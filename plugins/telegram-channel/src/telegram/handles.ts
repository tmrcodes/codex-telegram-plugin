import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { nowSeconds } from '../shared/guards'

/**
 * Signed, short-lived handles are the only way a tool call can name a Telegram target.
 * They bind a chat, message and topic to one conversation profile, so the model never
 * supplies raw chat, message or file IDs.
 *
 *   reply       2r.i.<chat>.<message>.<topic|->.<expiry>.<signature>
 *   message     2m.<i|o>.<chat>.<message>.<topic|->.<kind>.<expiry>.<signature>
 *   attachment  2a.<i|o>.<kind>.<token>.<expiry>.<signature>
 */
export type Direction = 'inbound' | 'outbound'
export type AttachmentKind = 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'animation' | 'sticker'
export type MessageKind = 'text' | 'media'

export type ReplyRoute = {
  profile: string
  chatId: string
  messageId: number
  messageThreadId?: number
  expiresAt: number
}
export type MessageRoute = ReplyRoute & { direction: Direction; kind?: MessageKind }
export type AttachmentRoute = ReplyRoute & { direction: Direction; kind: AttachmentKind; fileId: string }

export const HANDLE_TTL_SECONDS = 3600
/** Any handle that claims to live longer than this was not issued by this code. */
const MAX_HANDLE_LIFETIME_SECONDS = 8 * 3600
const MAX_ATTACHMENT_CAPABILITIES = 256

const KIND_CODES: ReadonlyMap<string, MessageKind | AttachmentKind | undefined> = new Map([
  ['-', undefined],
  ['t', 'text'],
  ['m', 'media'],
  ['p', 'photo'],
  ['d', 'document'],
  ['v', 'voice'],
  ['a', 'audio'],
  ['V', 'video'],
  ['n', 'video_note'],
  ['g', 'animation'],
  ['s', 'sticker'],
] as const)

/** Issues and verifies handles with one per-launch secret; attachment file IDs never leave this process. */
export class HandleAuthority {
  readonly #attachments = new Map<string, AttachmentRoute>()

  constructor(private readonly key: string) {}

  signReply(route: ReplyRoute): string {
    const body = [
      '2r',
      'i',
      compactChat(route.chatId),
      compactPositive(route.messageId),
      compactTopic(route.messageThreadId),
      compactPositive(route.expiresAt),
    ].join('.')
    return `${body}.${this.#sign(`telegram:v2:reply:inbound:${route.profile}`, body)}`
  }

  /** `isAllowed` re-checks the live access policy for the decoded route. */
  verifyReply(
    handle: string,
    profile: string,
    isAllowed: (route: ReplyRoute) => boolean,
    now = nowSeconds(),
  ): ReplyRoute {
    const parts = handle.split('.')
    if (parts.length !== 7 || parts[0] !== '2r' || parts[1] !== 'i') throw new Error('reply_handle is invalid')
    const body = parts.slice(0, -1).join('.')
    if (!this.#matches(`telegram:v2:reply:inbound:${profile}`, body, parts[6]!))
      throw new Error('reply_handle signature is invalid')
    const target = expandTarget(parts[2]!, parts[3]!, parts[4]!, parts[5]!, now)
    if (target === undefined) throw new Error('reply_handle route is invalid')
    const route = { ...target, profile }
    if (!isAllowed(route)) throw new Error('reply_handle route is invalid')
    return route
  }

  signMessage(route: MessageRoute): string {
    const kind = kindCode(route.kind)
    const body = [
      '2m',
      directionCode(route.direction),
      compactChat(route.chatId),
      compactPositive(route.messageId),
      compactTopic(route.messageThreadId),
      kind,
      compactPositive(route.expiresAt),
    ].join('.')
    return `${body}.${this.#sign(`telegram:v2:message:${route.direction}:${kind}:${route.profile}`, body)}`
  }

  verifyMessage(
    handle: string,
    profile: string,
    options: { outboundOnly?: boolean } = {},
    now = nowSeconds(),
  ): MessageRoute {
    const parts = handle.split('.')
    if (parts.length !== 8 || parts[0] !== '2m') throw new Error('message handle is invalid')
    const direction = expandDirection(parts[1]!)
    const kind = expandKind(parts[5]!)
    const body = parts.slice(0, -1).join('.')
    if (
      direction === undefined ||
      kind === 'invalid' ||
      !this.#matches(`telegram:v2:message:${direction}:${parts[5]}:${profile}`, body, parts[7]!)
    ) {
      throw new Error('message handle signature is invalid')
    }
    const target = expandTarget(parts[2]!, parts[3]!, parts[4]!, parts[6]!, now)
    if (
      target === undefined ||
      (kind !== undefined && kind !== 'text' && kind !== 'media') ||
      (options.outboundOnly && direction !== 'outbound')
    ) {
      throw new Error('message handle is invalid')
    }
    return { ...target, profile, direction, ...(kind === undefined ? {} : { kind }) }
  }

  signAttachment(route: AttachmentRoute): string {
    this.#pruneAttachments()
    const token = randomBytes(16).toString('base64url')
    this.#attachments.set(token, route)
    while (this.#attachments.size > MAX_ATTACHMENT_CAPABILITIES)
      this.#attachments.delete(this.#attachments.keys().next().value!)
    const kind = kindCode(route.kind)
    const body = ['2a', directionCode(route.direction), kind, token, compactPositive(route.expiresAt)].join('.')
    return `${body}.${this.#sign(`telegram:v2:attachment:${route.direction}:${kind}:${route.profile}`, body)}`
  }

  verifyAttachment(handle: string, profile: string, now = nowSeconds()): AttachmentRoute {
    this.#pruneAttachments(now)
    const parts = handle.split('.')
    if (parts.length !== 6 || parts[0] !== '2a') throw new Error('attachment handle is invalid')
    const direction = expandDirection(parts[1]!)
    const kind = expandKind(parts[2]!)
    const expiresAt = expandPositive(parts[4]!)
    const body = parts.slice(0, -1).join('.')
    if (
      direction === undefined ||
      kind === 'invalid' ||
      expiresAt === undefined ||
      !/^[A-Za-z0-9_-]{22}$/u.test(parts[3]!) ||
      !this.#matches(`telegram:v2:attachment:${direction}:${parts[2]}:${profile}`, body, parts[5]!)
    )
      throw new Error('attachment handle signature is invalid')
    const stored = this.#attachments.get(parts[3]!)
    if (
      stored === undefined ||
      stored.profile !== profile ||
      stored.direction !== direction ||
      stored.kind !== kind ||
      stored.expiresAt !== expiresAt ||
      stored.expiresAt < now ||
      stored.expiresAt > now + MAX_HANDLE_LIFETIME_SECONDS
    )
      throw new Error('attachment handle is invalid')
    return stored
  }

  #sign(domain: string, body: string): string {
    return createHmac('sha256', this.key).update(`${domain}\x00${body}`).digest('base64url')
  }

  #matches(domain: string, body: string, provided: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(provided)) return false
    return timingSafeEqual(Buffer.from(provided), Buffer.from(this.#sign(domain, body)))
  }

  #pruneAttachments(now = nowSeconds()): void {
    for (const [token, route] of this.#attachments) if (route.expiresAt < now) this.#attachments.delete(token)
  }
}

function expandTarget(
  chat: string,
  message: string,
  topic: string,
  expiry: string,
  now: number,
): Omit<ReplyRoute, 'profile'> | undefined {
  const chatId = expandChat(chat)
  const messageId = expandPositive(message)
  const messageThreadId = topic === '-' ? undefined : expandPositive(topic)
  const expiresAt = expandPositive(expiry)
  if (
    chatId === undefined ||
    messageId === undefined ||
    (topic !== '-' && messageThreadId === undefined) ||
    expiresAt === undefined ||
    expiresAt < now ||
    expiresAt > now + MAX_HANDLE_LIFETIME_SECONDS
  )
    return undefined
  return { chatId, messageId, ...(messageThreadId === undefined ? {} : { messageThreadId }), expiresAt }
}

function directionCode(value: Direction): 'i' | 'o' {
  return value === 'inbound' ? 'i' : 'o'
}

function expandDirection(value: string): Direction | undefined {
  return value === 'i' ? 'inbound' : value === 'o' ? 'outbound' : undefined
}

function kindCode(kind: MessageKind | AttachmentKind | undefined): string {
  for (const [code, value] of KIND_CODES) if (value === kind) return code
  throw new Error('message kind is invalid')
}

function expandKind(code: string): MessageKind | AttachmentKind | undefined | 'invalid' {
  return KIND_CODES.has(code) ? KIND_CODES.get(code) : 'invalid'
}

/** Chat IDs are signed decimal strings; `n`/`p` carries the sign and base 36 keeps handles short. */
function compactChat(value: string): string {
  if (!/^-?[1-9]\d{0,19}$/u.test(value)) throw new Error('compact chat ID is invalid')
  const negative = value.startsWith('-')
  return `${negative ? 'n' : 'p'}${BigInt(negative ? value.slice(1) : value).toString(36)}`
}

function expandChat(value: string): string | undefined {
  if (!/^[np][0-9a-z]+$/u.test(value)) return undefined
  const numeric = expandBase36(value.slice(1), 99_999_999_999_999_999_999n)
  return numeric === undefined || numeric === 0n ? undefined : `${value[0] === 'n' ? '-' : ''}${numeric}`
}

function compactTopic(messageThreadId: number | undefined): string {
  return messageThreadId === undefined ? '-' : compactPositive(messageThreadId)
}

function compactPositive(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('compact number is invalid')
  return value.toString(36)
}

function expandPositive(value: string): number | undefined {
  const numeric = expandBase36(value, BigInt(Number.MAX_SAFE_INTEGER))
  return numeric === undefined || numeric === 0n ? undefined : Number(numeric)
}

function expandBase36(value: string, maximum: bigint): bigint | undefined {
  if (!/^[0-9a-z]+$/u.test(value)) return undefined
  let result = 0n
  for (const character of value) {
    result = result * 36n + BigInt(parseInt(character, 36))
    if (result > maximum) return undefined
  }
  return result
}
