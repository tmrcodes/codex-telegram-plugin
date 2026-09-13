import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { parseTelegramPolicy, TelegramPolicySource } from './telegram-policy'

const policy = () => ({ schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: ['7'], groups: { '-100': { allowFrom: ['7'], requireMention: true } }, mentionPatterns: ['@ops'], ackReaction: '', typing: true, replyToMode: 'first', textChunkLimit: 32, chunkMode: 'newline', deliveryMode: 'auto', permissions: { enabled: true, operatorDmChatIds: ['7'] }, pending: [] })

test('profile policy hot-reloads and malformed replacement fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-policy-')); const path = join(dir, 'telegram.json')
  try {
    writeFileSync(path, JSON.stringify(policy())); chmodSync(path, 0o600)
    const source = new TelegramPolicySource(path); expect(source.read()).toMatchObject({ textChunkLimit: 32, chunkMode: 'newline', deliveryMode: 'auto' })
    const revised = policy(); revised.textChunkLimit = 64; revised.deliveryMode = 'steer'; writeFileSync(path, JSON.stringify(revised)); chmodSync(path, 0o600); expect(source.read()).toMatchObject({ textChunkLimit: 64, deliveryMode: 'steer' })
    const legacy = policy(); delete (legacy as Partial<typeof legacy>).deliveryMode; writeFileSync(path, JSON.stringify(legacy)); chmodSync(path, 0o600); expect(source.read().deliveryMode).toBe('auto')
    expect(source.read().allowAllGroups).toBeFalse()
    const invalid = policy(); invalid.deliveryMode = 'invalid'; writeFileSync(path, JSON.stringify(invalid)); chmodSync(path, 0o600); expect(() => source.read()).toThrow('invalid values')
    writeFileSync(path, '{'); chmodSync(path, 0o600); expect(() => source.read()).toThrow('malformed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('isolates malformed policy fields and recovers on the next valid hot-read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-policy-fields-')); const path = join(dir, 'telegram.json')
  try {
    writeFileSync(path, JSON.stringify(policy())); chmodSync(path, 0o600); const source = new TelegramPolicySource(path)
    const cases: Array<(value: Record<string, unknown>) => void> = [
      value => { value.typing = 'true' },
      value => { value.textChunkLimit = '32' },
      value => { value.groups = { '-100': { allowFrom: ['7'], requireMention: 'true' } } },
      value => { value.permissions = { enabled: true, operatorDmChatIds: [7] } },
      value => { value.pending = [{ code: 'BAD', expiresAt: 1 }] },
    ]
    for (const mutate of cases) {
      const invalid = JSON.parse(JSON.stringify(policy())) as Record<string, unknown>; mutate(invalid); writeFileSync(path, JSON.stringify(invalid)); chmodSync(path, 0o600)
      expect(() => source.read()).toThrow()
      writeFileSync(path, JSON.stringify(policy())); chmodSync(path, 0o600)
      expect(source.read().deliveryMode).toBe('auto')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('accepts JSON-integral policy numbers and rejects boolean, controls, unsafe expiry, and coerced pairing codes', () => {
  const valid = policy() as Record<string, unknown>; valid.schemaVersion = 1.0; valid.textChunkLimit = 1.0; valid.pending = [{ code: 'ABC234', expiresAt: 1.0 }]
  expect(parseTelegramPolicy(valid)).toMatchObject({ schemaVersion: 1, textChunkLimit: 1, pending: [{ code: 'ABC234', expiresAt: 1 }] })
  const cases: Array<(value: Record<string, unknown>) => void> = [
    value => { value.schemaVersion = true },
    value => { value.mentionPatterns = ['bad\u0000'] },
    value => { value.ackReaction = '\u007f' },
    value => { value.pending = [{ code: 'ABC234', expiresAt: Number.MAX_SAFE_INTEGER + 1 }] },
      value => { value.pending = [{ code: 123456, expiresAt: 1 }] },
      value => { value.allowAllGroups = 'true' },
  ]
  for (const mutate of cases) { const invalid = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>; mutate(invalid); expect(() => parseTelegramPolicy(invalid)).toThrow() }
})

test('pairing binds a sender for one hour, permits one reminder, and caps pending requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-pair-')); const path = join(dir, 'telegram.json')
  try {
    const value = policy(); value.dmPolicy = 'pairing'; value.allowFrom = []; writeFileSync(path, JSON.stringify(value)); chmodSync(path, 0o600)
    const source = new TelegramPolicySource(path); const first = source.beginPair('8', 100); expect(first).toMatch(/^[A-Z2-9]{6}$/); expect(source.beginPair('8', 101)).toBe(first); expect(source.beginPair('8', 102)).toBeUndefined()
    source.beginPair('9', 103); source.beginPair('10', 104); expect(source.beginPair('11', 105)).toBeUndefined(); expect(source.beginPair('11', 4000)).toMatch(/^[A-Z2-9]{6}$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('validated policy updates normalize legacy delivery mode atomically and leave invalid drafts unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-policy-update-')); const path = join(dir, 'telegram.json')
  try {
    const legacy = policy(); delete (legacy as Partial<typeof legacy>).deliveryMode; writeFileSync(path, JSON.stringify(legacy)); chmodSync(path, 0o600); const source = new TelegramPolicySource(path)
    source.update(draft => { draft.typing = false }); expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ deliveryMode: 'auto', typing: false }); expect(lstatSync(path).mode & 0o777).toBe(0o600)
    const before = readFileSync(path); expect(() => source.update(draft => { draft.textChunkLimit = 0 })).toThrow('invalid values'); expect(readFileSync(path)).toEqual(before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
