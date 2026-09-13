export const MAX_TELEGRAM_TOOL_FRAME_BYTES = 512 * 1024
export type ParseMode = 'MarkdownV2'
export type TelegramReplyArguments = { reply_handle: string; text?: string; files?: string[]; phase: 'commentary' | 'final'; parse_mode?: ParseMode }
export type TelegramReactArguments = { target_handle: string; emoji: string }
export type TelegramEditArguments = { message_handle: string; text: string; parse_mode?: ParseMode }
export type TelegramDownloadArguments = { attachment_handle: string }
export type TelegramToolRequest = { version: 1; type: 'reply'; arguments: TelegramReplyArguments } | { version: 1; type: 'react'; arguments: TelegramReactArguments } | { version: 1; type: 'edit_message'; arguments: TelegramEditArguments } | { version: 1; type: 'download_attachment'; arguments: TelegramDownloadArguments }
export type TelegramToolResult = { message_ids?: number[]; message_handles?: string[]; path?: string }
export type TelegramToolResponse = { version: 1; ok: true; result: TelegramToolResult } | { version: 1; ok: false; error: string }

const HANDLES = /^(?:[A-Za-z0-9_-]{1,468}|2[ram](?:\.[A-Za-z0-9_-]+){4,6})\.[A-Za-z0-9_-]{43}$/u
export function parseTelegramToolRequest(raw: string): TelegramToolRequest {
  if (new TextEncoder().encode(raw).byteLength > MAX_TELEGRAM_TOOL_FRAME_BYTES) throw new Error('Telegram tool frame is too large')
  let value: unknown; try { value = JSON.parse(raw) } catch { throw new Error('Telegram tool frame is not valid JSON') }
  if (!record(value) || value.version !== 1 || typeof value.type !== 'string' || !record(value.arguments) || Object.keys(value).length !== 3) throw new Error('Telegram tool frame is invalid')
  if (value.type === 'reply') return { version: 1, type: 'reply', arguments: reply(value.arguments) }
  if (value.type === 'react') return { version: 1, type: 'react', arguments: react(value.arguments) }
  if (value.type === 'edit_message') return { version: 1, type: 'edit_message', arguments: edit(value.arguments) }
  if (value.type === 'download_attachment') return { version: 1, type: 'download_attachment', arguments: download(value.arguments) }
  throw new Error('Telegram tool is unsupported')
}
export function parseTelegramToolResponse(raw: string): TelegramToolResponse {
  let value: unknown; try { value = JSON.parse(raw) } catch { throw new Error('Telegram tool result is not valid JSON') }
  if (!record(value) || value.version !== 1 || typeof value.ok !== 'boolean') throw new Error('Telegram tool result is invalid')
  if (!value.ok) { exact(value, ['version', 'ok', 'error']); return { version: 1, ok: false, error: text(value.error, 'error', 1024) } }
  exact(value, ['version', 'ok', 'result']); if (!record(value.result)) throw new Error('Telegram tool result is invalid')
  const result: TelegramToolResult = {}; const keys = Object.keys(value.result); if (keys.some(key => !['message_ids', 'message_handles', 'path'].includes(key))) throw new Error('Telegram tool result is invalid')
  if (value.result.message_ids !== undefined) { if (!Array.isArray(value.result.message_ids) || value.result.message_ids.length > 17 || value.result.message_ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Telegram tool result is invalid'); result.message_ids = value.result.message_ids as number[] }
  if (value.result.message_handles !== undefined) { if (!Array.isArray(value.result.message_handles) || value.result.message_handles.some(handle => typeof handle !== 'string' || !HANDLES.test(handle))) throw new Error('Telegram tool result is invalid'); result.message_handles = value.result.message_handles as string[] }
  if (value.result.path !== undefined) result.path = text(value.result.path, 'path', 1024)
  return { version: 1, ok: true, result }
}
export function toolSpecs(): readonly Record<string, unknown>[] { return [
  { name: 'reply', description: 'Reply only using the supplied signed reply handle.', inputSchema: { type: 'object', properties: { reply_handle: { type: 'string' }, text: { type: 'string' }, files: { type: 'array', items: { type: 'string' }, maxItems: 8 }, phase: { enum: ['commentary', 'final'] }, parse_mode: { enum: ['MarkdownV2'] } }, required: ['reply_handle', 'phase'], additionalProperties: false } },
  { name: 'react', description: 'React using a supplied signed target_handle; inbound targets and outbound reply message_handle values are valid.', inputSchema: { type: 'object', properties: { target_handle: { type: 'string' }, emoji: { type: 'string' } }, required: ['target_handle', 'emoji'], additionalProperties: false } },
  { name: 'edit_message', description: 'Edit only the signed outbound message_handle returned by reply; never use an inbound target_handle.', inputSchema: { type: 'object', properties: { message_handle: { type: 'string' }, text: { type: 'string' }, parse_mode: { enum: ['MarkdownV2'] } }, required: ['message_handle', 'text'], additionalProperties: false } },
  { name: 'download_attachment', description: 'Download only a supplied signed attachment handle.', inputSchema: { type: 'object', properties: { attachment_handle: { type: 'string' } }, required: ['attachment_handle'], additionalProperties: false } },
] }
function reply(value: Record<string, unknown>): TelegramReplyArguments { exact(value, ['reply_handle', 'text', 'files', 'phase', 'parse_mode'], ['reply_handle', 'phase']); const files = value.files === undefined ? undefined : paths(value.files); if (value.text === undefined && files === undefined) throw new Error('reply requires text or files'); return { reply_handle: handle(value.reply_handle, 'reply_handle'), ...(value.text === undefined ? {} : { text: text(value.text, 'text', 16384) }), ...(files === undefined ? {} : { files }), phase: phase(value.phase), ...(value.parse_mode === undefined ? {} : { parse_mode: parseMode(value.parse_mode) }) } }
function react(value: Record<string, unknown>): TelegramReactArguments { exact(value, ['target_handle', 'emoji']); return { target_handle: handle(value.target_handle, 'target_handle'), emoji: text(value.emoji, 'emoji', 16) } }
function edit(value: Record<string, unknown>): TelegramEditArguments { exact(value, ['message_handle', 'text', 'parse_mode'], ['message_handle', 'text']); return { message_handle: handle(value.message_handle, 'message_handle'), text: text(value.text, 'text', 4096), ...(value.parse_mode === undefined ? {} : { parse_mode: parseMode(value.parse_mode) }) } }
function download(value: Record<string, unknown>): TelegramDownloadArguments { exact(value, ['attachment_handle']); return { attachment_handle: handle(value.attachment_handle, 'attachment_handle') } }
function paths(value: unknown): string[] { if (!Array.isArray(value) || !value.length || value.length > 8 || value.some(path => typeof path !== 'string' || path.length < 1 || path.length > 1024 || /[\u0000\r\n]/u.test(path))) throw new Error('files are invalid'); return value as string[] }
function phase(value: unknown): 'commentary' | 'final' { if (value !== 'commentary' && value !== 'final') throw new Error('phase is invalid'); return value }
function parseMode(value: unknown): ParseMode { if (value !== 'MarkdownV2') throw new Error('parse_mode is invalid'); return value }
function handle(value: unknown, label: string): string { const result = text(value, label, 512); if (!HANDLES.test(result)) throw new Error(`${label} is invalid`); return result }
function text(value: unknown, label: string, maximum: number): string { if (typeof value !== 'string' || !value || Array.from(value).length > maximum) throw new Error(`${label} is invalid`); return value }
function exact(value: Record<string, unknown>, keys: string[], required = keys): void { if (Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Telegram tool arguments have unknown or missing fields') }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
