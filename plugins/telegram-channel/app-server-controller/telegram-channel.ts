import type { Bot } from 'grammy'
import { chunkTelegramText, TelegramTextAdapter, type TelegramTextRoute } from '../telegram-text-adapter'
import { type TelegramDeliveryMode, TelegramPolicySource } from '../telegram-policy'
import { createTelegramReplyHandle, verifyTelegramReplyHandle } from './reply-handle'
import { signAttachmentHandle, signMessageHandle, verifyAttachmentHandle, verifyMessageHandle } from './telegram-handles'
import type { TelegramToolRequest } from './telegram-tools-protocol'

export type TelegramChannelOrigin = { id: string; route: string; text: string; displayText: string; source: 'telegram'; clientUserMessageId: string; localImagePath?: string; localImagePaths?: string[] }
export type TelegramChannel = { adapter: TelegramTextAdapter; poll: () => Promise<void>; close: () => void; closeAndDrain: () => Promise<void>; executeTool: (request: TelegramToolRequest) => Promise<Record<string, unknown>>; executeRetainedTool: (profile: string, request: TelegramToolRequest) => Promise<Record<string, unknown>>; pauseAndDrain: () => Promise<void>; resume: () => void; isQuiescent: () => boolean; rebind: (route: string, profile: string, admit: TelegramChannelOptions['admit'], onCallback?: TelegramChannelOptions['onCallback']) => void }
export type TelegramChannelOptions = {
  bot: Bot; policy: TelegramPolicySource; route: string; profile: string; handleKey: string; workspaceRoot: string; inboxRoot: string; apiRoot: string; downloadUrl?: (filePath: string) => string
  admit: (origin: TelegramChannelOrigin, deliveryMode: TelegramDeliveryMode) => Promise<void>
  onCallback?: (query: Record<string, unknown>) => 'recorded' | 'already' | boolean
  onHealth?: (ok: boolean, error?: unknown) => void
}

/** Telegram ingress/egress core with only caller-supplied authority and paths. */
export function createTelegramChannel(options: TelegramChannelOptions): TelegramChannel {
  let route = options.route; let profile = options.profile; let admit = options.admit; let callback = options.onCallback
  const tools = new Set<Promise<unknown>>()
  const adapter = new TelegramTextAdapter(options.bot, options.policy, async input => {
    const policy = options.policy.read()
    await admit(telegramOrigin(route, input, options.handleKey, profile), policy.deliveryMode)
  }, undefined, [options.workspaceRoot, options.inboxRoot], options.inboxRoot, options.apiRoot, query => callback?.(query) ?? false, options.onHealth, undefined, options.downloadUrl)
  const executeWithProfile = (request: TelegramToolRequest, handleProfile: string): Promise<Record<string, unknown>> => {
    const active = executeTelegramTool(request, adapter, options.policy, options.handleKey, handleProfile); tools.add(active); void active.then(() => tools.delete(active), () => tools.delete(active)); return active
  }
  const waitTools = async (): Promise<void> => { for (;;) { const pending = [...tools]; if (pending.length === 0) return; await Promise.all(pending.map(tool => tool.then(() => undefined, () => undefined))) } }
  return { adapter, poll: () => adapter.poll(), close: () => adapter.close(), async closeAndDrain() { await adapter.closeAndDrain(); await waitTools() }, executeTool: request => executeWithProfile(request, profile), executeRetainedTool: (retainedProfile, request) => executeWithProfile(request, retainedProfile), async pauseAndDrain() { await adapter.pauseAndDrain(); await waitTools() }, resume: () => adapter.resume(), isQuiescent: () => adapter.isQuiescent() && tools.size === 0, rebind(nextRoute, nextProfile, nextAdmit, nextCallback) { if (!adapter.isQuiescent() || tools.size !== 0) throw new Error('Telegram channel is not quiescent'); route = nextRoute; profile = nextProfile; admit = nextAdmit; callback = nextCallback } }
}

export function controllerTelegramModelInput(input: TelegramTextRoute, handleKey: string, profile: string): string {
  const now = Math.floor(Date.now() / 1000)
  const replyHandle = createTelegramReplyHandle(handleKey, { ...input, profile, expiresAt: now + 3600 })
  const messageHandle = signMessageHandle(handleKey, { profile, direction: 'inbound', chatId: input.chatId, messageId: input.messageId, ...(input.messageThreadId === undefined ? {} : { messageThreadId: input.messageThreadId }), expiresAt: now + 3600 })
  const sender = input.sender === undefined ? input.username === undefined ? 'Telegram sender' : `@${input.username}` : `${input.sender}${input.username === undefined ? '' : ` (@${input.username})`}`
  const conversation = `${input.chatType}${input.messageThreadId === undefined ? '' : ' topic'}`
  const metadata = entitySummary(input)
  const lines = [
    '<channel source="telegram">',
    `Telegram · sender: ${inlineRemote(sender)} · conversation: ${inlineRemote(conversation)}`,
    'message:',
    ...quoteRemote(input.text),
    ...(metadata === '' ? [] : [`metadata: ${inlineRemote(metadata)}`]),
    ...(input.replyToMessageId === undefined ? [] : [`reply${input.replySender === undefined ? '' : ` from: ${inlineRemote(input.replySender)}`}:`, ...quoteRemote(input.replyText ?? '')]),
    ...(input.attachments ?? []).map(attachment => attachmentLine(attachment, input, handleKey, profile, now)),
    `reply_handle: ${replyHandle}`,
    `target_handle: ${messageHandle}`,
    '</channel>',
  ]
  const rendered = lines.join('\n')
  if (new TextEncoder().encode(rendered).byteLength > 12 * 1024) throw new Error('Telegram model input exceeds its host byte limit')
  return rendered
}

function entitySummary(input: TelegramTextRoute): string {
  const labels: string[] = []
  for (const entity of input.entities) {
    const text = input.text.slice(entity.offset, entity.offset + entity.length).trim()
    if (entity.type === 'text_link' && entity.url !== undefined) labels.push(`link ${text === '' ? 'text' : text} → ${entity.url}`)
    else if (entity.type === 'text_mention' && entity.textMention !== undefined) labels.push(`mention ${entity.textMention.display}${entity.textMention.username === undefined ? '' : ` (@${entity.textMention.username})`}`)
    else if (entity.type === 'mention') labels.push(`mention ${text}`)
    else if (entity.type === 'url') labels.push(`link ${text}`)
    else if (entity.type === 'pre') labels.push(`code${entity.language === undefined ? '' : ` (${entity.language})`}`)
    else if (['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'code', 'blockquote', 'expandable_blockquote', 'custom_emoji'].includes(entity.type)) labels.push(entity.type.replace(/_/gu, ' '))
  }
  return [...new Set(labels)].join('; ')
}

function attachmentLine(attachment: NonNullable<TelegramTextRoute['attachments']>[number], input: TelegramTextRoute, handleKey: string, profile: string, now: number): string {
  const values = Object.entries({ name: attachment.name, title: attachment.title, mime: attachment.mime, size: attachment.size, width: attachment.width, height: attachment.height, duration: attachment.duration, sticker_emoji: attachment.stickerEmoji, sticker_set_name: attachment.stickerSetName, sticker_type: attachment.stickerType })
    .flatMap(([key, value]) => value === undefined ? [] : [`${key}: ${inlineRemote(String(value))}`])
  if (attachment.source === 'reply') values.unshift('source: immediate reply')
  if (attachment.localImagePath !== undefined) values.push('local_image: true')
  const handle = signAttachmentHandle(handleKey, { profile, direction: 'inbound', chatId: input.chatId, messageId: input.messageId, ...(input.messageThreadId === undefined ? {} : { messageThreadId: input.messageThreadId }), fileId: attachment.fileId, kind: attachment.kind, expiresAt: now + 3600 })
  return `attachment: ${attachment.kind}${values.length === 0 ? '' : ` · ${values.join(' · ')}`} · attachment_handle: ${handle}`
}

function telegramOrigin(route: string, input: TelegramTextRoute, key: string, profile: string): TelegramChannelOrigin { return { id: input.id, route, text: controllerTelegramModelInput(input, key, profile), displayText: telegramDisplayPreview(input), source: 'telegram', clientUserMessageId: input.id, localImagePath: input.attachments?.find(attachment => attachment.localImagePath !== undefined)?.localImagePath, localImagePaths: (input.attachments ?? []).flatMap(attachment => attachment.localImagePath === undefined ? [] : [attachment.localImagePath]) } }
function telegramDisplayPreview(input: TelegramTextRoute): string {
  const sender = input.sender === undefined ? input.username === undefined ? 'Telegram sender' : `@${input.username}` : `${input.sender}${input.username === undefined ? '' : ` (@${input.username})`}`
  const request = input.text.trim() === '' ? (input.attachments ?? []).map(attachment => `${attachment.kind}${attachment.name === undefined ? '' : ` ${attachment.name}`}`).join(', ') || 'attachment' : input.text
  return truncatePreview(`Telegram · sender: ${inlineRemote(sender)} · request: ${inlineRemote(request)}`)
}
function truncatePreview(value: string): string { const points = Array.from(value); return points.length <= 320 ? value : `${points.slice(0, 319).join('')}…` }
async function executeTelegramTool(request: TelegramToolRequest, adapter: TelegramTextAdapter, config: TelegramPolicySource, key: string, profile: string): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000)
  if (request.type === 'reply') { const policy = config.read(); const route = verifyTelegramReplyHandle(key, request.arguments.reply_handle, candidate => adapter.allowsRoute(candidate), profile); const ids = await adapter.reply(route, request.arguments); const textCount = request.arguments.text === undefined || request.arguments.text === '' ? 0 : chunkTelegramText(request.arguments.text, policy.textChunkLimit, policy.chunkMode).length; return { message_ids: ids, message_handles: ids.map((messageId, index) => signMessageHandle(key, { profile, direction: 'outbound', chatId: route.chatId, messageId, ...(route.messageThreadId === undefined ? {} : { messageThreadId: route.messageThreadId }), kind: index < textCount ? 'text' : 'media', expiresAt: now + 3600 })) } }
  if (request.type === 'react') { const route = verifyMessageHandle(key, request.arguments.target_handle, profile); await adapter.react(route, request.arguments.emoji); return {} }
  if (request.type === 'edit_message') { const route = verifyMessageHandle(key, request.arguments.message_handle, profile, true); if (route.kind === 'media') throw new Error('media message handles cannot be edited'); await adapter.edit(route, request.arguments.text, request.arguments.parse_mode); return {} }
  const attachment = verifyAttachmentHandle(key, request.arguments.attachment_handle, profile); const path = await adapter.downloadAttachment({ chatId: attachment.chatId, messageId: attachment.messageId, ...(attachment.messageThreadId === undefined ? {} : { messageThreadId: attachment.messageThreadId }) }, attachment.fileId, attachment.kind); return { path }
}
function inlineRemote(value: string): string { return escapeRemote(value).replace(/[\r\n]/gu, '↵') }
function quoteRemote(value: string): string[] { return value.split(/\r\n|\r|\n/gu).map(line => `│ ${escapeRemote(line).replace(/^(reply_handle|attachment_handle|target_handle|message_handle):/u, '$1\\:')}`) }
function escapeRemote(value: string): string { return value.replace(/<\s*\/?\s*channel\b[^>]*>/giu, match => `&lt;${match.slice(1)}`) }
