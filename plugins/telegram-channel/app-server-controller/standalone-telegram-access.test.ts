import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { standaloneTelegramAccess } from './standalone-telegram-access'

const current = Date.parse('2023-11-14T22:13:20Z') / 1000
const policy = () => ({ schemaVersion: 1, dmPolicy: 'pairing', allowFrom: ['7'], groups: { '-100': { allowFrom: ['7'], requireMention: true } }, mentionPatterns: ['@ops'], ackReaction: '', typing: true, replyToMode: 'first', textChunkLimit: 32, chunkMode: 'newline', deliveryMode: 'auto', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [{ code: 'ABC234', expiresAt: current + 1, senderId: '8' }, { code: 'OLD234', expiresAt: current, senderId: '9' }] })
function privateFile(path: string, value: string): void { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'standalone-access-')); const policyFile = join(root, 'telegram.json'); const tokenFile = join(root, 'token'); const configFile = join(root, 'connection.json'); const stateDir = join(root, 'state')
  mkdirSync(stateDir, { mode: 0o700 }); chmodSync(stateDir, 0o700); privateFile(policyFile, JSON.stringify(policy())); privateFile(tokenFile, 'synthetic-token'); privateFile(configFile, JSON.stringify({ schemaVersion: 1, appServerSocket: join(root, 'host.sock'), policyFile, botTokenFile: tokenFile, stateDir }))
  return { root, policyFile, env: { CODEX_TELEGRAM_CONFIG: configFile } }
}

test('status and policy are read-only views with no runtime dependency', () => {
  const value = fixture()
  try {
    const before = readFileSync(value.policyFile); const mtime = statSync(value.policyFile).mtimeMs
    expect(standaloneTelegramAccess('status', [], value.env, current)).toMatchObject({ policy: { pending: [{ code: 'ABC234', senderId: '8' }] } })
    expect(standaloneTelegramAccess('policy', [], value.env, current)).toMatchObject({ policy: { dmPolicy: 'pairing' } })
    expect(readFileSync(value.policyFile)).toEqual(before); expect(statSync(value.policyFile).mtimeMs).toBe(mtime)
    const source = readFileSync(join(import.meta.dir, 'standalone-telegram-access.ts'), 'utf8'); for (const forbidden of ['grammy', 'standalone-telegram\'', 'controller', 'telegram-channel']) expect(source).not.toContain(forbidden)
  } finally { rmSync(value.root, { recursive: true, force: true }) }
})

test('pairing and direct allowlist changes preserve current terminal semantics', () => {
  const value = fixture()
  try {
    expect(standaloneTelegramAccess('pair', ['ABC234'], value.env, current)).toEqual({ paired: '8' })
    let stored = JSON.parse(readFileSync(value.policyFile, 'utf8')); expect(stored.allowFrom).toEqual(['7', '8']); expect(stored.pending).toEqual([])
    const before = readFileSync(value.policyFile); expect(() => standaloneTelegramAccess('pair', ['OLD234'], value.env, current)).toThrow('unknown, expired, or unbound'); expect(readFileSync(value.policyFile)).toEqual(before)
    expect(standaloneTelegramAccess('deny', ['MISSING'], value.env, current)).toEqual({ denied: 'MISSING' })
    expect(standaloneTelegramAccess('allow', ['10'], value.env, current)).toEqual({ allow: '10' }); expect(standaloneTelegramAccess('allow', ['10'], value.env, current)).toEqual({ allow: '10' }); expect(standaloneTelegramAccess('remove', ['10'], value.env, current)).toEqual({ remove: '10' })
    stored = JSON.parse(readFileSync(value.policyFile, 'utf8')); expect(stored.allowFrom).toEqual(['7', '8'])
  } finally { rmSync(value.root, { recursive: true, force: true }) }
})

test('set and group commands retain the launcher whitelist and reject invalid values unchanged', () => {
  const value = fixture()
  try {
    for (const [field, input] of [['dmPolicy', 'allowlist'], ['allowAllGroups', 'true'], ['typing', 'false'], ['ackReaction', '👀'], ['replyToMode', 'all'], ['textChunkLimit', '80'], ['chunkMode', 'length'], ['deliveryMode', 'queue'], ['permissions.enabled', 'true']] as const) expect(standaloneTelegramAccess('set', [field, input], value.env, current)).toEqual({ set: field })
    expect(standaloneTelegramAccess('status', [], value.env, current)).toMatchObject({ policy: { allowAllGroups: true } })
    expect(standaloneTelegramAccess('set', ['allowAllGroups', 'false'], value.env, current)).toEqual({ set: 'allowAllGroups' }); expect(standaloneTelegramAccess('status', [], value.env, current)).toMatchObject({ policy: { allowAllGroups: false } }); const beforeInvalid = readFileSync(value.policyFile); expect(() => standaloneTelegramAccess('set', ['allowAllGroups', 'yes'], value.env, current)).toThrow('set value is invalid'); expect(readFileSync(value.policyFile)).toEqual(beforeInvalid)
    expect(standaloneTelegramAccess('group', ['add', '-200', 'false', '8', '8', '9'], value.env, current)).toEqual({ group: '-200' }); expect(standaloneTelegramAccess('group', ['set', '-200', 'true', '9'], value.env, current)).toEqual({ group: '-200' }); expect(standaloneTelegramAccess('group', ['rm', '-200'], value.env, current)).toEqual({ groupRemoved: '-200' })
    const before = readFileSync(value.policyFile); expect(() => standaloneTelegramAccess('set', ['deliveryMode', 'invalid'], value.env, current)).toThrow('set value is invalid'); expect(() => standaloneTelegramAccess('group', ['add', 'bad', 'true'], value.env, current)).toThrow('group add/set'); expect(readFileSync(value.policyFile)).toEqual(before)
  } finally { rmSync(value.root, { recursive: true, force: true }) }
})
