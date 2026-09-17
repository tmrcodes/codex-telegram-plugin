import { nowSeconds } from '../shared/guards'
import { HANDLE_TTL_SECONDS, type HandleAuthority } from './handles'
import type { InboundMessage, TelegramAttachment } from './messages'

const MAX_MODEL_INPUT_BYTES = 12 * 1024
const MAX_PREVIEW_CHARACTERS = 320

/**
 * Renders one admitted message as the block the model sees. Everything from Telegram is
 * untrusted: it is quoted line by line and cannot close the block or forge a handle line.
 */
export function renderModelInput(message: InboundMessage, handles: HandleAuthority, profile: string): string {
  const expiresAt = nowSeconds() + HANDLE_TTL_SECONDS
  const target = {
    profile,
    chatId: message.chatId,
    messageId: message.messageId,
    ...(message.messageThreadId === undefined ? {} : { messageThreadId: message.messageThreadId }),
    expiresAt,
  }
  const conversation = `${message.chatType}${message.messageThreadId === undefined ? '' : ' topic'}`
  const metadata = entitySummary(message)
  const lines = [
    '<channel source="telegram">',
    `Telegram · sender: ${inline(senderLabel(message))} · conversation: ${inline(conversation)}`,
    'message:',
    ...quote(message.text),
    ...(metadata === '' ? [] : [`metadata: ${inline(metadata)}`]),
    ...(message.replyToMessageId === undefined
      ? []
      : [
          `reply${message.replySender === undefined ? '' : ` from: ${inline(message.replySender)}`}:`,
          ...quote(message.replyText ?? ''),
        ]),
    ...(message.attachments ?? []).map(attachment => attachmentLine(attachment, target, handles)),
    `reply_handle: ${handles.signReply(target)}`,
    `target_handle: ${handles.signMessage({ ...target, direction: 'inbound' })}`,
    '</channel>',
  ]
  const rendered = lines.join('\n')
  if (new TextEncoder().encode(rendered).byteLength > MAX_MODEL_INPUT_BYTES)
    throw new Error('Telegram model input exceeds its host byte limit')
  return rendered
}

/** One-line preview shown as the user message when the full block travels as untrusted context. */
export function renderDisplayPreview(message: InboundMessage): string {
  const attachments = (message.attachments ?? [])
    .map(item => `${item.kind}${item.name === undefined ? '' : ` ${item.name}`}`)
    .join(', ')
  const request = message.text.trim() === '' ? attachments || 'attachment' : message.text
  const preview = `Telegram · sender: ${inline(senderLabel(message))} · request: ${inline(request)}`
  const points = Array.from(preview)
  return points.length <= MAX_PREVIEW_CHARACTERS ? preview : `${points.slice(0, MAX_PREVIEW_CHARACTERS - 1).join('')}…`
}

function senderLabel(message: InboundMessage): string {
  return `${message.sender}${message.username === undefined ? '' : ` (@${message.username})`}`
}

function entitySummary(message: InboundMessage): string {
  const plainStyles = [
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'spoiler',
    'code',
    'blockquote',
    'expandable_blockquote',
    'custom_emoji',
  ]
  const labels: string[] = []
  for (const entity of message.entities) {
    const text = message.text.slice(entity.offset, entity.offset + entity.length).trim()
    if (entity.type === 'text_link' && entity.url !== undefined)
      labels.push(`link ${text === '' ? 'text' : text} → ${entity.url}`)
    else if (entity.type === 'text_mention' && entity.textMention !== undefined) {
      const { display, username } = entity.textMention
      labels.push(`mention ${display}${username === undefined ? '' : ` (@${username})`}`)
    } else if (entity.type === 'mention') labels.push(`mention ${text}`)
    else if (entity.type === 'url') labels.push(`link ${text}`)
    else if (entity.type === 'pre') labels.push(`code${entity.language === undefined ? '' : ` (${entity.language})`}`)
    else if (plainStyles.includes(entity.type)) labels.push(entity.type.replace(/_/gu, ' '))
  }
  return [...new Set(labels)].join('; ')
}

function attachmentLine(
  attachment: TelegramAttachment,
  target: Parameters<HandleAuthority['signReply']>[0],
  handles: HandleAuthority,
): string {
  const values = Object.entries({
    name: attachment.name,
    title: attachment.title,
    mime: attachment.mime,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
    duration: attachment.duration,
    sticker_emoji: attachment.stickerEmoji,
    sticker_set_name: attachment.stickerSetName,
    sticker_type: attachment.stickerType,
    download_status: attachment.downloadStatus,
    download_limit_bytes: attachment.downloadLimit,
    local_path: attachment.localPath,
  }).flatMap(([key, value]) => (value === undefined ? [] : [`${key}: ${inline(String(value))}`]))
  if (attachment.source === 'reply') values.unshift('source: immediate reply')
  if (attachment.localImagePath !== undefined) values.push('local_image: true')
  if (attachment.downloadStatus === 'skipped_oversize')
    values.push('download_notice: media exceeds the 5 MiB automatic-download limit; resend a smaller file')
  if (attachment.downloadStatus === 'failed')
    values.push('download_notice: automatic media download failed; resend the media or use a smaller file')
  const line = `attachment: ${attachment.kind}${values.length === 0 ? '' : ` · ${values.join(' · ')}`}`
  // Media that was fetched, skipped or failed automatically has no explicit-download handle.
  if (attachment.downloadStatus !== undefined) return line
  const handle = handles.signAttachment({
    ...target,
    direction: 'inbound',
    fileId: attachment.fileId,
    kind: attachment.kind,
  })
  return `${line} · attachment_handle: ${handle}`
}

function inline(value: string): string {
  return escapeChannelTags(value).replace(/[\r\n]/gu, '↵')
}

function quote(value: string): string[] {
  return value.split(/\r\n|\r|\n/gu).map(line => {
    const escaped = escapeChannelTags(line).replace(
      /^(reply_handle|attachment_handle|target_handle|message_handle):/u,
      '$1\\:',
    )
    return `│ ${escaped}`
  })
}

function escapeChannelTags(value: string): string {
  return value.replace(/<\s*\/?\s*channel\b[^>]*>/giu, match => `&lt;${match.slice(1)}`)
}
