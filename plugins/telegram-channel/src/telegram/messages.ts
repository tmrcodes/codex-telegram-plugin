import { isRecord, type JsonObject, truncate } from '../shared/guards'
import type { AttachmentKind } from './handles'

/** Bounded, already-validated view of one admitted Telegram message. */
export type TelegramEntity = {
  type: string
  offset: number
  length: number
  url?: string
  language?: string
  customEmojiId?: string
  textMention?: { userId: string; username?: string; display?: string }
}

export type TelegramAttachment = {
  kind: AttachmentKind
  fileId: string
  /** Set when the file belongs to the message this one replies to. */
  source?: 'reply'
  name?: string
  title?: string
  mime?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  stickerEmoji?: string
  stickerSetName?: string
  stickerType?: string
  localPath?: string
  localImagePath?: string
  downloadStatus?: 'downloaded' | 'skipped_oversize' | 'failed'
  downloadLimit?: number
}

export type InboundMessage = {
  id: string
  chatId: string
  chatType: string
  messageId: number
  messageThreadId?: number
  senderId: string
  sender: string
  username?: string
  senderChatId?: string
  timestamp: number
  text: string
  entities: TelegramEntity[]
  attachments?: TelegramAttachment[]
  replyToMessageId?: number
  replySender?: string
  replyText?: string
}

export type MessageTarget = { chatId: string; messageId: number; messageThreadId?: number }

const MEDIA_KINDS: readonly AttachmentKind[] = [
  'photo',
  'document',
  'voice',
  'audio',
  'video',
  'video_note',
  'animation',
  'sticker',
]

export function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined
}

export function mediaKind(message: JsonObject): AttachmentKind | undefined {
  return MEDIA_KINDS.find(kind => message[kind] !== undefined)
}

/** Text, else caption, else a bracketed placeholder such as `[photo]` or `[audio: title]`. */
export function messageText(message: JsonObject): { text: string | undefined; entities: unknown } {
  if (typeof message.text === 'string') return { text: message.text, entities: message.entities }
  if (typeof message.caption === 'string') return { text: message.caption, entities: message.caption_entities }
  const kind = mediaKind(message)
  if (kind === undefined) return { text: undefined, entities: message.entities }
  const title = kind === 'audio' ? asRecord(message.audio)?.title : undefined
  const label =
    typeof title === 'string' && truncate(title, 128) !== '' ? `[audio: ${truncate(title, 128)}]` : `[${kind}]`
  return { text: label, entities: message.entities }
}

/** Metadata of the single media item carried by a message; downloads are decided elsewhere. */
export function attachmentMetadata(message: JsonObject): TelegramAttachment | undefined {
  const kind = mediaKind(message)
  if (kind === undefined) return undefined
  const value = kind === 'photo' ? largestPhoto(message.photo) : asRecord(message[kind])
  if (value === undefined || typeof value.file_id !== 'string') return undefined
  const number = (key: string): number | undefined => {
    const item = value[key]
    return typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : undefined
  }
  const string = (key: string, limit: number): string | undefined => {
    const item = value[key]
    return typeof item === 'string' ? truncate(item, limit) : undefined
  }
  return withoutUndefined({
    kind,
    fileId: value.file_id,
    name: string('file_name', 128),
    title: string('title', 128),
    mime: string('mime_type', 128),
    size: number('file_size'),
    width: number('width'),
    height: number('height'),
    duration: number('duration'),
    stickerEmoji: string('emoji', 64),
    stickerSetName: string('set_name', 128),
    stickerType: string('type', 32),
  })
}

/** Photos, voice, audio, video and media-typed documents are fetched before model admission. */
export function isAutoDownloaded(attachment: TelegramAttachment): boolean {
  if (attachment.kind === 'sticker') return false
  return attachment.kind !== 'document' || /^(?:image|audio|video)\//iu.test(attachment.mime ?? '')
}

export function isImage(attachment: TelegramAttachment): boolean {
  return attachment.kind === 'photo' || (attachment.kind === 'document' && /^image\//iu.test(attachment.mime ?? ''))
}

export function parseEntities(value: unknown): TelegramEntity[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap((item): TelegramEntity[] => {
      const entity = asRecord(item)
      if (
        entity === undefined ||
        typeof entity.type !== 'string' ||
        typeof entity.offset !== 'number' ||
        typeof entity.length !== 'number' ||
        !Number.isSafeInteger(entity.offset) ||
        !Number.isSafeInteger(entity.length) ||
        entity.offset < 0 ||
        entity.length < 0
      )
        return []
      const user = asRecord(entity.user)
      const textMention =
        entity.type === 'text_mention' && user !== undefined && typeof user.id === 'number'
          ? withoutUndefined({
              userId: String(user.id),
              username: typeof user.username === 'string' ? truncate(user.username, 64) : undefined,
              display: displayName(user) === 'unknown' ? undefined : displayName(user),
            })
          : undefined
      return [
        withoutUndefined({
          type: truncate(entity.type, 64),
          offset: entity.offset,
          length: entity.length,
          url: typeof entity.url === 'string' ? truncate(entity.url, 2048) : undefined,
          language: typeof entity.language === 'string' ? truncate(entity.language, 64) : undefined,
          customEmojiId: typeof entity.custom_emoji_id === 'string' ? truncate(entity.custom_emoji_id, 128) : undefined,
          textMention,
        }),
      ]
    })
    .slice(0, 64)
}

export function displayName(user: JsonObject): string {
  const name = [user.first_name, user.last_name]
    .filter(item => typeof item === 'string')
    .join(' ')
    .trim()
  return truncate(name || (typeof user.username === 'string' ? `@${user.username}` : 'unknown'), 256)
}

function largestPhoto(value: unknown): JsonObject | undefined {
  if (!Array.isArray(value)) return undefined
  const sizes = value.map(asRecord).filter((item): item is JsonObject => item !== undefined)
  const area = (item: JsonObject) => Number(item.width ?? 0) * Number(item.height ?? 0)
  return sizes.sort((a, b) => area(b) - area(a) || Number(b.file_size ?? 0) - Number(a.file_size ?? 0))[0]
}

/** Drops keys whose value is undefined so optional fields stay absent rather than explicit. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
