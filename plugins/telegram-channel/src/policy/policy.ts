import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hasControlCharacters, isRecord, isTelegramId, type JsonObject, nowSeconds } from '../shared/guards'

export type DmPolicy = 'pairing' | 'allowlist' | 'disabled'
export type DeliveryMode = 'steer' | 'queue' | 'auto'
export type ReplyToMode = 'off' | 'first' | 'all'
export type ChunkMode = 'length' | 'newline'
export type GroupPolicy = { allowFrom: ReadonlySet<string>; requireMention: boolean }
export type PendingPairing = { code: string; expiresAt: number; senderId?: string; reminded?: boolean }

export type TelegramPolicy = {
  schemaVersion: 1
  dmPolicy: DmPolicy
  allowFrom: ReadonlySet<string>
  groups: ReadonlyMap<string, GroupPolicy>
  allowAllGroups: boolean
  mentionPatterns: readonly string[]
  ackReaction: string
  typing: boolean
  replyToMode: ReplyToMode
  textChunkLimit: number
  chunkMode: ChunkMode
  deliveryMode: DeliveryMode
  permissions: { enabled: boolean; operatorDmChatIds: ReadonlySet<string>; bootstrapFirstPairAsOperator: boolean }
  pending: readonly PendingPairing[]
  /** Short digest of the stored JSON; health reports use it to show which policy was read. */
  fingerprint: string
}

export const DM_POLICIES: readonly DmPolicy[] = ['pairing', 'allowlist', 'disabled']
export const DELIVERY_MODES: readonly DeliveryMode[] = ['steer', 'queue', 'auto']
export const REPLY_TO_MODES: readonly ReplyToMode[] = ['off', 'first', 'all']
export const CHUNK_MODES: readonly ChunkMode[] = ['length', 'newline']

export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PAIRING_CODE = /^[A-Z2-9]{6}$/u
const PAIRING_CODE_TTL_SECONDS = 3600
const MAX_PENDING_PAIRINGS = 3
const MAX_POLICY_BYTES = 64 * 1024

const POLICY_KEYS = [
  'schemaVersion',
  'dmPolicy',
  'allowFrom',
  'groups',
  'allowAllGroups',
  'mentionPatterns',
  'ackReaction',
  'typing',
  'replyToMode',
  'textChunkLimit',
  'chunkMode',
  'deliveryMode',
  'permissions',
  'pending',
]
const PERMISSION_KEYS = ['enabled', 'operatorDmChatIds', 'bootstrapFirstPairAsOperator']
const PENDING_KEYS = ['code', 'expiresAt', 'senderId', 'reminded']

/** Settings for a fresh profile: empty allowlist, DM pairing and a one-shot owner bootstrap. */
export function freshPolicy(): JsonObject {
  return {
    schemaVersion: 1,
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    allowAllGroups: true,
    mentionPatterns: [],
    ackReaction: '👀',
    typing: true,
    replyToMode: 'first',
    textChunkLimit: 4096,
    chunkMode: 'newline',
    deliveryMode: 'queue',
    permissions: { enabled: false, operatorDmChatIds: [], bootstrapFirstPairAsOperator: true },
    pending: [],
  }
}

/** The profile JSON is deliberately hot-read: a malformed or replaced policy fails Telegram closed. */
export class TelegramPolicySource {
  constructor(readonly path: string) {}

  read(): TelegramPolicy {
    return parseTelegramPolicy(readOwnedPolicy(this.path))
  }

  /** Re-reads and validates both sides of an owner-only atomic policy mutation. */
  update(mutate: (draft: JsonObject) => void): TelegramPolicy {
    const raw = readOwnedPolicy(this.path)
    parseTelegramPolicy(raw)
    const draft = structuredClone(raw) as JsonObject
    mutate(draft)
    const policy = parseTelegramPolicy(draft)
    this.#write(draft)
    return policy
  }

  /**
   * Issues, or reminds once about, the pairing code bound to this sender.
   * Returns undefined when the sender was already reminded or too many codes are pending.
   */
  beginPair(senderId: string, now = nowSeconds()): string | undefined {
    const policy = this.read()
    const retained = policy.pending.filter(item => item.expiresAt >= now)
    const existing = retained.find(item => item.senderId === senderId)
    if (existing !== undefined) {
      if (existing.reminded) return undefined
      this.update(draft => {
        draft.pending = retained.map(item => (item === existing ? { ...item, reminded: true } : item))
      })
      return existing.code
    }
    if (retained.length >= MAX_PENDING_PAIRINGS) return undefined
    const code = Array.from(
      crypto.getRandomValues(new Uint8Array(6)),
      value => PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length],
    ).join('')
    this.update(draft => {
      draft.pending = [...retained, { code, expiresAt: now + PAIRING_CODE_TTL_SECONDS, senderId, reminded: false }]
    })
    return code
  }

  #write(value: JsonObject): void {
    const temporary = `${this.path}.tmp`
    if (existsSync(temporary)) {
      const stat = lstatSync(temporary)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('Telegram policy temporary file is unsafe')
      }
      unlinkSync(temporary)
    }
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.path)
  }
}

export function parseTelegramPolicy(raw: unknown): TelegramPolicy {
  if (!isRecord(raw)) throw new Error('Telegram policy must be an object')
  const keys = Object.keys(raw)
  if (keys.some(key => !POLICY_KEYS.includes(key)) || POLICY_KEYS.some(key => !Object.hasOwn(raw, key))) {
    throw new Error('Telegram policy has an invalid shape')
  }
  if (
    !boundedInteger(raw.schemaVersion, 1, 1) ||
    !oneOf(DM_POLICIES, raw.dmPolicy) ||
    !oneOf(REPLY_TO_MODES, raw.replyToMode) ||
    !oneOf(CHUNK_MODES, raw.chunkMode) ||
    !oneOf(DELIVERY_MODES, raw.deliveryMode) ||
    typeof raw.allowAllGroups !== 'boolean' ||
    typeof raw.typing !== 'boolean' ||
    !boundedInteger(raw.textChunkLimit, 1, 4096)
  )
    throw new Error('Telegram policy has invalid values')

  const mentionPatterns = boundedStrings(raw.mentionPatterns, 'mentionPatterns', 16, 256)
  for (const pattern of mentionPatterns) {
    try {
      new RegExp(pattern, 'i')
    } catch {
      throw new Error('Telegram policy mentionPatterns contains an invalid regular expression')
    }
  }
  if (
    typeof raw.ackReaction !== 'string' ||
    Array.from(raw.ackReaction).length > 16 ||
    hasControlCharacters(raw.ackReaction)
  ) {
    throw new Error('Telegram policy ackReaction is invalid')
  }

  return {
    schemaVersion: 1,
    dmPolicy: raw.dmPolicy,
    allowFrom: idSet(raw.allowFrom, 'allowFrom'),
    groups: groupPolicies(raw.groups),
    allowAllGroups: raw.allowAllGroups,
    mentionPatterns,
    ackReaction: raw.ackReaction,
    typing: raw.typing,
    replyToMode: raw.replyToMode,
    textChunkLimit: raw.textChunkLimit,
    chunkMode: raw.chunkMode,
    deliveryMode: raw.deliveryMode,
    permissions: permissions(raw.permissions),
    pending: pendingPairings(raw.pending),
    fingerprint: createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 16),
  }
}

function permissions(value: unknown): TelegramPolicy['permissions'] {
  if (
    !isRecord(value) ||
    Object.keys(value).some(key => !PERMISSION_KEYS.includes(key)) ||
    typeof value.enabled !== 'boolean' ||
    !Object.hasOwn(value, 'operatorDmChatIds') ||
    (value.bootstrapFirstPairAsOperator !== undefined && typeof value.bootstrapFirstPairAsOperator !== 'boolean')
  )
    throw new Error('Telegram policy permissions are invalid')
  const operatorDmChatIds = idSet(value.operatorDmChatIds, 'operatorDmChatIds', 8)
  const bootstrapFirstPairAsOperator = value.bootstrapFirstPairAsOperator === true
  // The bootstrap marker means "nobody owns approvals yet"; it cannot coexist with an owner.
  if (bootstrapFirstPairAsOperator && (value.enabled || operatorDmChatIds.size !== 0)) {
    throw new Error('Telegram policy permissions bootstrap is invalid')
  }
  return { enabled: value.enabled, operatorDmChatIds, bootstrapFirstPairAsOperator }
}

function pendingPairings(value: unknown): PendingPairing[] {
  if (!Array.isArray(value) || value.length > MAX_PENDING_PAIRINGS)
    throw new Error('Telegram policy pending is invalid')
  return value.map(item => {
    if (
      !isRecord(item) ||
      Object.keys(item).some(key => !PENDING_KEYS.includes(key)) ||
      typeof item.code !== 'string' ||
      !PAIRING_CODE.test(item.code) ||
      !boundedInteger(item.expiresAt) ||
      (item.senderId !== undefined && !isTelegramId(item.senderId)) ||
      (item.reminded !== undefined && typeof item.reminded !== 'boolean')
    )
      throw new Error('Telegram policy pending is invalid')
    return {
      code: item.code,
      expiresAt: item.expiresAt,
      ...(item.senderId === undefined ? {} : { senderId: item.senderId }),
      ...(item.reminded === undefined ? {} : { reminded: item.reminded }),
    }
  })
}

function groupPolicies(value: unknown): ReadonlyMap<string, GroupPolicy> {
  if (!isRecord(value) || Object.keys(value).length > 64) throw new Error('Telegram policy groups are invalid')
  return new Map(
    Object.entries(value).map(([chatId, item]) => {
      if (
        !isTelegramId(chatId) ||
        !isRecord(item) ||
        Object.keys(item).length !== 2 ||
        typeof item.requireMention !== 'boolean'
      ) {
        throw new Error('Telegram policy group is invalid')
      }
      return [chatId, { allowFrom: idSet(item.allowFrom, 'group allowFrom'), requireMention: item.requireMention }]
    }),
  )
}

function readOwnedPolicy(path: string): unknown {
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > MAX_POLICY_BYTES
  )
    throw new Error('Telegram policy must be an owned 0600 regular file')
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error('Telegram policy is malformed')
  }
}

function idSet(value: unknown, label: string, maximum = 256): ReadonlySet<string> {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some(item => !isTelegramId(item)) ||
    new Set(value).size !== value.length
  )
    throw new Error(`Telegram policy ${label} is invalid`)
  return new Set(value as string[])
}

function boundedStrings(value: unknown, label: string, maximum: number, length: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some(
      item => typeof item !== 'string' || item === '' || Array.from(item).length > length || hasControlCharacters(item),
    )
  )
    throw new Error(`Telegram policy ${label} is invalid`)
  return [...value] as string[]
}

function boundedInteger(
  value: unknown,
  minimum = -Number.MAX_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}
