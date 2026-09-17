import type { TelegramPolicy } from '../policy/policy'
import { nowSeconds } from '../shared/guards'
import { asRecord, type MessageTarget } from './messages'

/** Everything the inbound decision needs from one raw Telegram message. */
export type InboundContext = {
  chatId: string
  chatType: string
  senderId: string
  text: string
  entities: unknown
  replyToMessage: unknown
  senderChat: unknown
  botUsername: string
  botId: string
}

/** Pure admission decision; pairing, service commands and size limits are handled by the adapter. */
export function allowedInbound(policy: TelegramPolicy, context: InboundContext): boolean {
  if (context.chatType === 'private') return policy.dmPolicy !== 'disabled' && policy.allowFrom.has(context.senderId)
  const group = policy.groups.get(context.chatId)
  if (group === undefined) return allowedInUnlistedGroup(policy, context)
  if (!group.allowFrom.has(context.senderId)) return false
  if (!group.requireMention) return true
  return (
    mentionsBotInText(context) ||
    policy.mentionPatterns.some(pattern => new RegExp(pattern, 'i').test(context.text)) ||
    addressesBot(context)
  )
}

/**
 * Any-group fallback: a paired sender may address the bot in a group without an explicit rule,
 * but only through a genuine mention entity or a reply to the bot, never as an anonymous admin
 * or channel (`sender_chat`), and never through a custom text pattern.
 */
function allowedInUnlistedGroup(policy: TelegramPolicy, context: InboundContext): boolean {
  return (
    policy.allowAllGroups &&
    /^[1-9]\d{0,19}$/u.test(context.senderId) &&
    policy.allowFrom.has(context.senderId) &&
    context.chatId.startsWith('-') &&
    (context.chatType === 'group' || context.chatType === 'supergroup') &&
    context.senderChat === undefined &&
    addressesBot(context)
  )
}

function mentionsBotInText(context: InboundContext): boolean {
  return new RegExp(`(^|\\s)@${escapeRegExp(context.botUsername)}(?:\\s|$)`, 'iu').test(context.text)
}

/**
 * A `mention`/`text_mention` entity naming this bot, a leading command addressed to it
 * (`/ask@this_bot ...`), or a reply to one of the bot's messages. With Telegram's privacy mode on,
 * the addressed command and the reply are the only group messages a bot receives at all.
 */
function addressesBot(context: InboundContext): boolean {
  const suffix = `@${context.botUsername}`.toLocaleLowerCase()
  const mentioned =
    Array.isArray(context.entities) &&
    context.entities.some(value => {
      const entity = asRecord(value)
      if (entity === undefined) return false
      if (entity.type === 'text_mention') return String(asRecord(entity.user)?.id ?? '') === context.botId
      if (typeof entity.offset !== 'number' || typeof entity.length !== 'number') return false
      const covered = context.text.slice(entity.offset, entity.offset + entity.length).toLocaleLowerCase()
      if (entity.type === 'mention') return covered === suffix
      return entity.type === 'bot_command' && entity.offset === 0 && covered.endsWith(suffix)
    })
  const replyToBot = String(asRecord(asRecord(context.replyToMessage)?.from)?.id ?? '') === context.botId
  return mentioned || replyToBot
}

/**
 * A group reply is authorized by a short-lived grant created when that sender's message was
 * admitted; private chats are authorized by the live allowlist or operator list.
 */
export function allowedOutbound(
  policy: TelegramPolicy,
  target: { chatId: string; messageId?: number; messageThreadId?: number },
  grants: RouteGrants,
): boolean {
  const group = policy.groups.get(target.chatId)
  if (!target.chatId.startsWith('-')) {
    if (group !== undefined) return group.allowFrom.size > 0
    return (
      policy.permissions.operatorDmChatIds.has(target.chatId) ||
      (policy.dmPolicy !== 'disabled' && policy.allowFrom.has(target.chatId))
    )
  }
  const grant = target.messageId === undefined ? undefined : grants.get(target as MessageTarget)
  if (grant === undefined) return false
  return group === undefined
    ? policy.allowAllGroups && policy.allowFrom.has(grant.senderId)
    : group.allowFrom.has(grant.senderId)
}

type Grant = { senderId: string; expiresAt: number; origin: string }

const GRANT_TTL_SECONDS = 3600
const MAX_GRANTS = 256

/** In-memory, bounded authorizations for replying into a group; never a durable route ledger. */
export class RouteGrants {
  readonly #grants = new Map<string, Grant>()

  /** Authorizes replies to an admitted inbound group message. */
  grant(target: MessageTarget, senderId: string): void {
    this.#set(target, { senderId, expiresAt: nowSeconds() + GRANT_TTL_SECONDS, origin: grantKey(target) })
  }

  /** A message the bot sent under a grant inherits it, so it can be edited or reacted to. */
  extend(from: MessageTarget, sentMessageId: number): void {
    const grant = this.#grants.get(grantKey(from))
    if (grant === undefined) return
    const { messageThreadId } = from
    this.#set(
      { chatId: from.chatId, messageId: sentMessageId, ...(messageThreadId === undefined ? {} : { messageThreadId }) },
      grant,
    )
  }

  get(target: MessageTarget): Grant | undefined {
    const grant = this.#grants.get(grantKey(target))
    return grant === undefined || grant.expiresAt < nowSeconds() ? undefined : grant
  }

  /** Drops the grant of a message whose admission failed, with everything derived from it. */
  revokeOrigin(target: MessageTarget): void {
    const origin = grantKey(target)
    for (const [key, grant] of this.#grants) if (grant.origin === origin) this.#grants.delete(key)
  }

  #set(target: MessageTarget, grant: Grant): void {
    const now = nowSeconds()
    for (const [key, item] of this.#grants) if (item.expiresAt < now) this.#grants.delete(key)
    this.#grants.set(grantKey(target), grant)
    while (this.#grants.size > MAX_GRANTS) this.#grants.delete(this.#grants.keys().next().value!)
  }
}

function grantKey(target: MessageTarget): string {
  return `${target.chatId}:${target.messageId}:${target.messageThreadId ?? '-'}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
