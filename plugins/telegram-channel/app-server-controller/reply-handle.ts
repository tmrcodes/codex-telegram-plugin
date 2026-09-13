import { createHmac, timingSafeEqual } from 'node:crypto'
import { compactChat, compactDirectionCode, compactPositive, compactSignature, compactSignatureMatches, expandCompactChat, expandCompactPositive } from './compact-handle'

export type TelegramReplyRoute = { chatId: string; messageId: number; messageThreadId?: number; profile: string; expiresAt: number }
type RouteAuthorizer = ReadonlySet<string> | ((route: TelegramReplyRoute) => boolean)

export function createTelegramReplyHandle(key: string, route: TelegramReplyRoute): string {
  const body = ['2r', compactDirectionCode('inbound'), compactChat(route.chatId), compactPositive(route.messageId), route.messageThreadId === undefined ? '-' : compactPositive(route.messageThreadId), compactPositive(route.expiresAt)].join('.')
  return `${body}.${compactSignature(key, `telegram:v2:reply:inbound:${route.profile}`, body)}`
}
export function verifyTelegramReplyHandle(key: string, handle: string, allowedChats: RouteAuthorizer, profile: string, now = Math.floor(Date.now() / 1000)): TelegramReplyRoute {
  if (handle.startsWith('2r.')) return verifyCompactReplyHandle(key, handle, allowedChats, profile, now)
  return verifyLegacyReplyHandle(key, handle, allowedChats, profile, now)
}
function verifyLegacyReplyHandle(key: string, handle: string, allowedChats: RouteAuthorizer, profile: string, now: number): TelegramReplyRoute {
  const [payload, provided, ...extra] = handle.split('.')
  if (payload === undefined || provided === undefined || extra.length !== 0 || !/^[A-Za-z0-9_-]{1,256}$/u.test(payload) || !/^[A-Za-z0-9_-]{43}$/u.test(provided)) throw new Error('reply_handle is invalid')
  const expected = signature(key, payload)
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw new Error('reply_handle signature is invalid')
  let value: unknown
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw new Error('reply_handle payload is invalid') }
  const expiresAt = record(value) ? value.expiresAt : undefined
  if (!record(value) || value.v !== 1 || !chat(value.chatId) || !positive(value.messageId) || (value.messageThreadId !== undefined && !positive(value.messageThreadId)) || typeof value.profile !== 'string' || value.profile !== profile || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + 8 * 3600 || Object.keys(value).some(key => !['v', 'chatId', 'messageId', 'messageThreadId', 'profile', 'expiresAt'].includes(key))) throw new Error('reply_handle route is invalid')
  const route = { chatId: value.chatId, messageId: value.messageId, ...(value.messageThreadId === undefined ? {} : { messageThreadId: value.messageThreadId }), profile: value.profile, expiresAt }; if (!allowed(route, allowedChats)) throw new Error('reply_handle route is invalid'); return route
}
function verifyCompactReplyHandle(key: string, handle: string, allowedChats: RouteAuthorizer, profile: string, now: number): TelegramReplyRoute {
  const parts = handle.split('.'); if (parts.length !== 7 || parts[0] !== '2r' || parts[1] !== 'i') throw new Error('reply_handle is invalid')
  const [body, provided] = [parts.slice(0, -1).join('.'), parts[6]!]
  if (!compactSignatureMatches(key, `telegram:v2:reply:inbound:${profile}`, body, provided)) throw new Error('reply_handle signature is invalid')
  const chatId = expandCompactChat(parts[2]!); const messageId = expandCompactPositive(parts[3]!); const messageThreadId = parts[4] === '-' ? undefined : expandCompactPositive(parts[4]!); const expiresAt = expandCompactPositive(parts[5]!)
  if (chatId === undefined || messageId === undefined || (parts[4] !== '-' && messageThreadId === undefined) || expiresAt === undefined || expiresAt < now || expiresAt > now + 8 * 3600) throw new Error('reply_handle route is invalid')
  const route = { chatId, messageId, ...(messageThreadId === undefined ? {} : { messageThreadId }), profile, expiresAt }; if (!allowed(route, allowedChats)) throw new Error('reply_handle route is invalid'); return route
}
function allowed(route: TelegramReplyRoute, authorizer: RouteAuthorizer): boolean { return typeof authorizer === 'function' ? authorizer(route) : authorizer.has(route.chatId) }
function signature(key: string, payload: string): string { return createHmac('sha256', key).update(payload).digest('base64url') }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function chat(value: unknown): value is string { return typeof value === 'string' && /^-?[1-9]\d{0,19}$/u.test(value) }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
