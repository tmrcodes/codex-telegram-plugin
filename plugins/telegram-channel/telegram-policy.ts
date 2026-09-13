import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export type TelegramGroupPolicy = { allowFrom: ReadonlySet<string>; requireMention: boolean }
export type TelegramDeliveryMode = 'steer' | 'queue' | 'auto'
export type TelegramPolicy = {
  schemaVersion: 1; dmPolicy: 'pairing' | 'allowlist' | 'disabled'; allowFrom: ReadonlySet<string>
  groups: ReadonlyMap<string, TelegramGroupPolicy>; allowAllGroups: boolean; mentionPatterns: readonly string[]; ackReaction: string
  typing: boolean; replyToMode: 'off' | 'first' | 'all'; textChunkLimit: number; chunkMode: 'length' | 'newline'
  deliveryMode: TelegramDeliveryMode
  permissions: { enabled: boolean; operatorDmChatIds: ReadonlySet<string> }; pending: readonly { code: string; expiresAt: number; senderId?: string; reminded?: boolean }[]
  fingerprint: string
}

/** The profile JSON is deliberately hot-read: malformed or replaced policy fails Telegram closed. */
export class TelegramPolicySource {
  constructor(readonly path: string) {}
  read(): TelegramPolicy { return parseTelegramPolicy(readPrivate(this.path)) }
  /** Re-reads and validates both sides of an owner-only atomic policy mutation. */
  update(mutate: (draft: Record<string, unknown>) => void): TelegramPolicy { const raw = readPrivate(this.path); parseTelegramPolicy(raw); const draft = structuredClone(raw) as Record<string, unknown>; if (!Object.hasOwn(draft, 'deliveryMode')) draft.deliveryMode = 'auto'; if (!Object.hasOwn(draft, 'allowAllGroups')) draft.allowAllGroups = false; mutate(draft); const policy = parseTelegramPolicy(draft); this.#write(draft); return policy }
  beginPair(senderId: string, now = Math.floor(Date.now() / 1000)): string | undefined { const raw = readPrivate(this.path); const policy = parseTelegramPolicy(raw); const retained = policy.pending.filter(item => item.expiresAt >= now); const existing = retained.find(item => item.senderId === senderId); if (existing !== undefined) { if (existing.reminded) return undefined; this.update(draft => { draft.pending = retained.map(item => item === existing ? { ...item, reminded: true } : item) }); return existing.code } if (retained.length >= 3) return undefined; const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), value => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[value! % 32]).join(''); this.update(draft => { draft.pending = [...retained, { code, expiresAt: now + 3600, senderId, reminded: false }] }); return code }
  #write(value: Record<string, unknown>): void { const temporary = `${this.path}.pairing.tmp`; if (existsSync(temporary)) { const stat = lstatSync(temporary); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) throw new Error('Telegram policy temporary file is unsafe'); unlinkSync(temporary) } writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path) }
}

export function parseTelegramPolicy(raw: unknown): TelegramPolicy {
  if (!record(raw)) throw new Error('Telegram policy must be an object')
  const keys = ['schemaVersion', 'dmPolicy', 'allowFrom', 'groups', 'mentionPatterns', 'ackReaction', 'typing', 'replyToMode', 'textChunkLimit', 'chunkMode', 'permissions', 'pending']
  if (Object.keys(raw).some(key => ![...keys, 'deliveryMode', 'allowAllGroups'].includes(key)) || keys.some(key => !Object.hasOwn(raw, key))) throw new Error('Telegram policy has an invalid shape')
  const textChunkLimit = raw.textChunkLimit
  const deliveryMode = Object.hasOwn(raw, 'deliveryMode') ? raw.deliveryMode : 'auto'
  const allowAllGroups = Object.hasOwn(raw, 'allowAllGroups') ? raw.allowAllGroups : false
  if (!jsonInteger(raw.schemaVersion, 1, 1) || !['pairing', 'allowlist', 'disabled'].includes(String(raw.dmPolicy)) || !['off', 'first', 'all'].includes(String(raw.replyToMode)) || !['length', 'newline'].includes(String(raw.chunkMode)) || !['steer', 'queue', 'auto'].includes(String(deliveryMode)) || typeof allowAllGroups !== 'boolean' || typeof raw.typing !== 'boolean' || !jsonInteger(textChunkLimit, 1, 4096)) throw new Error('Telegram policy has invalid values')
  const allowFrom = ids(raw.allowFrom, 'allowFrom'); const groups = groupPolicies(raw.groups); const mentionPatterns = strings(raw.mentionPatterns, 'mentionPatterns', 16, 256)
  if (typeof raw.ackReaction !== 'string' || Array.from(raw.ackReaction).length > 16 || /[\u0000-\u001f\u007f]/u.test(raw.ackReaction)) throw new Error('Telegram policy ackReaction is invalid')
  if (!record(raw.permissions) || Object.keys(raw.permissions).length !== 2 || typeof raw.permissions.enabled !== 'boolean') throw new Error('Telegram policy permissions are invalid')
  const permissions = { enabled: raw.permissions.enabled, operatorDmChatIds: ids(raw.permissions.operatorDmChatIds, 'operatorDmChatIds', 8) }
  if (!Array.isArray(raw.pending) || raw.pending.length > 3 || raw.pending.some(item => !record(item) || Object.keys(item).some(key => !['code', 'expiresAt', 'senderId', 'reminded'].includes(key)) || typeof item.code !== 'string' || !/^[A-Z2-9]{6}$/u.test(item.code) || !jsonInteger(item.expiresAt) || (item.senderId !== undefined && !id(item.senderId)) || (item.reminded !== undefined && typeof item.reminded !== 'boolean'))) throw new Error('Telegram policy pending is invalid')
  const canonical = JSON.stringify(raw)
  return { schemaVersion: 1, dmPolicy: raw.dmPolicy as TelegramPolicy['dmPolicy'], allowFrom, groups, allowAllGroups, mentionPatterns, ackReaction: raw.ackReaction, typing: raw.typing, replyToMode: raw.replyToMode as TelegramPolicy['replyToMode'], textChunkLimit, chunkMode: raw.chunkMode as TelegramPolicy['chunkMode'], deliveryMode: deliveryMode as TelegramDeliveryMode, permissions, pending: raw.pending.map(item => { const pending = item as { code: string; expiresAt: number; senderId?: string; reminded?: boolean }; return { code: pending.code, expiresAt: pending.expiresAt, ...(pending.senderId === undefined ? {} : { senderId: pending.senderId }), ...(pending.reminded === undefined ? {} : { reminded: pending.reminded }) } }), fingerprint: createHash('sha256').update(canonical).digest('hex').slice(0, 16) }
}

function readPrivate(path: string): unknown {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) throw new Error('Telegram policy must be an owned 0600 regular file')
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch { throw new Error('Telegram policy is malformed') }
}
function groupPolicies(value: unknown): ReadonlyMap<string, TelegramGroupPolicy> {
  if (!record(value) || Object.keys(value).length > 64) throw new Error('Telegram policy groups are invalid')
  return new Map(Object.entries(value).map(([chatId, item]) => { if (!id(chatId) || !record(item) || Object.keys(item).length !== 2 || typeof item.requireMention !== 'boolean') throw new Error('Telegram policy group is invalid'); return [chatId, { allowFrom: ids(item.allowFrom, 'group allowFrom'), requireMention: item.requireMention }] }))
}
function ids(value: unknown, label: string, maximum = 256): ReadonlySet<string> { if (!Array.isArray(value) || value.length > maximum || value.some(item => !id(item)) || new Set(value).size !== value.length) throw new Error(`Telegram policy ${label} is invalid`); return new Set(value as string[]) }
function strings(value: unknown, label: string, maximum: number, length: number): string[] { if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || !item || Array.from(item).length > length || /[\u0000-\u001f\u007f]/u.test(item))) throw new Error(`Telegram policy ${label} is invalid`); return [...value] as string[] }
function jsonInteger(value: unknown, minimum = -Number.MAX_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum }
function id(value: unknown): value is string { return typeof value === 'string' && /^-?[1-9]\d{0,19}$/u.test(value) }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
