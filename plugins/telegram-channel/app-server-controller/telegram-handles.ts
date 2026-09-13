import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { compactChat, compactDirection, compactDirectionCode, compactPositive, compactSignature, compactSignatureMatches, expandCompactChat, expandCompactPositive, type CompactDirection } from './compact-handle'

export type MessageRoute = { profile: string; direction: CompactDirection; chatId: string; messageId: number; messageThreadId?: number; expiresAt: number; kind?: 'text' | 'media' | 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'sticker' }
export type AttachmentRoute = MessageRoute & { fileId: string; kind: string }
const attachmentCapabilities = new Map<string, AttachmentRoute>()
const MAX_ATTACHMENT_CAPABILITIES = 256
const kinds = new Map([['-', undefined], ['t', 'text'], ['m', 'media'], ['p', 'photo'], ['d', 'document'], ['v', 'voice'], ['a', 'audio'], ['V', 'video'], ['n', 'video_note'], ['s', 'sticker']] as const)

export function signMessageHandle(key: string, route: MessageRoute): string {
  const kind = kindCode(route.kind); const body = ['2m', compactDirectionCode(route.direction), compactChat(route.chatId), compactPositive(route.messageId), route.messageThreadId === undefined ? '-' : compactPositive(route.messageThreadId), kind, compactPositive(route.expiresAt)].join('.')
  return `${body}.${compactSignature(key, `telegram:v2:message:${route.direction}:${kind}:${route.profile}`, body)}`
}
export function signAttachmentHandle(key: string, route: AttachmentRoute): string {
  pruneAttachments(); const token = randomBytes(16).toString('base64url'); attachmentCapabilities.set(token, route); while (attachmentCapabilities.size > MAX_ATTACHMENT_CAPABILITIES) attachmentCapabilities.delete(attachmentCapabilities.keys().next().value!)
  const kind = kindCode(route.kind); const body = ['2a', compactDirectionCode(route.direction), kind, token, compactPositive(route.expiresAt)].join('.')
  return `${body}.${compactSignature(key, `telegram:v2:attachment:${route.direction}:${kind}:${route.profile}`, body)}`
}
export function verifyMessageHandle(key: string, handle: string, profile: string, outboundOnly = false, now = Math.floor(Date.now() / 1000)): MessageRoute {
  const value = handle.startsWith('2m.') ? verifyCompactMessageHandle(key, handle, profile, now) : verifyLegacy(key, handle, 'm', profile, now)
  if ((value.kind !== undefined && value.kind !== 'text' && value.kind !== 'media') || (outboundOnly && value.direction !== 'outbound')) throw new Error('message handle is invalid')
  return value
}
export function verifyAttachmentHandle(key: string, handle: string, profile: string, now = Math.floor(Date.now() / 1000)): AttachmentRoute {
  pruneAttachments(now)
  if (handle.startsWith('2a.')) return verifyCompactAttachmentHandle(key, handle, profile, now)
  const value = verifyLegacyPayload(key, handle, 'a')
  if (typeof value.t === 'string' && typeof value.p === 'string' && typeof value.e === 'number') { const stored = attachmentCapabilities.get(value.t); if (stored === undefined || stored.profile !== profile || stored.expiresAt < now || value.p !== profile || value.e !== stored.expiresAt) throw new Error('attachment handle is invalid'); return stored }
  if (!legacyRoute(value, profile, now)) throw new Error('attachment handle is invalid')
  const fileId = (value as Record<string, unknown>).fileId; const kind = value.kind
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(fileId) || typeof kind !== 'string' || !['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker'].includes(kind)) throw new Error('attachment handle is invalid')
  return { ...value, fileId, kind } as AttachmentRoute
}
function verifyCompactMessageHandle(key: string, handle: string, profile: string, now: number): MessageRoute {
  const parts = handle.split('.'); if (parts.length !== 8 || parts[0] !== '2m') throw new Error('message handle is invalid')
  const direction = compactDirection(parts[1]!); const kind = expandKind(parts[5]!); const body = parts.slice(0, -1).join('.')
  if (direction === undefined || kind === 'invalid' || !compactSignatureMatches(key, `telegram:v2:message:${direction}:${parts[5]}:${profile}`, body, parts[7]!)) throw new Error('message handle signature is invalid')
  const route = compactRoute(parts[2]!, parts[3]!, parts[4]!, parts[6]!, profile, direction, kind, now)
  if (route === undefined) throw new Error('message handle is invalid')
  return route
}
function verifyCompactAttachmentHandle(key: string, handle: string, profile: string, now: number): AttachmentRoute {
  const parts = handle.split('.'); if (parts.length !== 6 || parts[0] !== '2a') throw new Error('attachment handle is invalid')
  const direction = compactDirection(parts[1]!); const kind = expandKind(parts[2]!); const expiresAt = expandCompactPositive(parts[4]!); const body = parts.slice(0, -1).join('.')
  if (direction === undefined || kind === 'invalid' || expiresAt === undefined || !/^[A-Za-z0-9_-]{22}$/u.test(parts[3]!) || !compactSignatureMatches(key, `telegram:v2:attachment:${direction}:${parts[2]}:${profile}`, body, parts[5]!)) throw new Error('attachment handle signature is invalid')
  const stored = attachmentCapabilities.get(parts[3]!); if (stored === undefined || stored.profile !== profile || stored.direction !== direction || stored.kind !== kind || stored.expiresAt !== expiresAt || stored.expiresAt < now || stored.expiresAt > now + 8 * 3600) throw new Error('attachment handle is invalid')
  return stored
}
function compactRoute(chat: string, message: string, topic: string, expiry: string, profile: string, direction: CompactDirection, kind: MessageRoute['kind'] | undefined, now: number): MessageRoute | undefined {
  const chatId = expandCompactChat(chat); const messageId = expandCompactPositive(message); const messageThreadId = topic === '-' ? undefined : expandCompactPositive(topic); const expiresAt = expandCompactPositive(expiry)
  if (chatId === undefined || messageId === undefined || (topic !== '-' && messageThreadId === undefined) || expiresAt === undefined || expiresAt < now || expiresAt > now + 8 * 3600) return undefined
  return { profile, direction, chatId, messageId, ...(messageThreadId === undefined ? {} : { messageThreadId }), ...(kind === undefined ? {} : { kind }), expiresAt }
}
function kindCode(kind: MessageRoute['kind'] | string | undefined): string { for (const [code, value] of kinds) if (value === kind) return code; throw new Error('message kind is invalid') }
function expandKind(value: string): MessageRoute['kind'] | undefined | 'invalid' { return kinds.has(value as never) ? kinds.get(value as never) : 'invalid' }
function pruneAttachments(now = Math.floor(Date.now() / 1000)): void { for (const [token, route] of attachmentCapabilities) if (route.expiresAt < now) attachmentCapabilities.delete(token) }

function verifyLegacy(key: string, handle: string, expectedKind: string, profile: string, now: number): MessageRoute {
  const value = verifyLegacyPayload(key, handle, expectedKind)
  if (!legacyRoute(value, profile, now)) throw new Error('handle payload is invalid')
  return value
}
function verifyLegacyPayload(key: string, handle: string, expectedKind: string): Record<string, unknown> {
  const [body, supplied, extra] = handle.split('.'); if (!body || !supplied || extra !== undefined || handle.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(body) || !/^[A-Za-z0-9_-]{43}$/u.test(supplied)) throw new Error('handle is invalid')
  const expected = legacyMac(key, body); if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new Error('handle signature is invalid')
  let value: unknown; try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw new Error('handle payload is invalid') }
  if (!record(value) || value.v !== 1 || value.k !== expectedKind) throw new Error('handle payload is invalid')
  return value
}
function legacyRoute(value: Record<string, unknown>, profile: string, now: number): value is MessageRoute { const expiresAt = value.expiresAt; const messageId = value.messageId; const messageThreadId = value.messageThreadId; return value.profile === profile && (value.direction === 'inbound' || value.direction === 'outbound') && typeof value.chatId === 'string' && /^-?[1-9]\d{0,19}$/u.test(value.chatId) && typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0 && (value.kind === undefined || ['text', 'media', 'photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker'].includes(String(value.kind))) && (messageThreadId === undefined || typeof messageThreadId === 'number' && Number.isSafeInteger(messageThreadId) && messageThreadId > 0) && typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt >= now && expiresAt <= now + 8 * 3600 }
function legacyMac(key: string, body: string): string { return createHmac('sha256', key).update(body).digest('base64url') }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
