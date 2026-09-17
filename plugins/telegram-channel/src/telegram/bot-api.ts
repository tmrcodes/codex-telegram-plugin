import { basename } from 'node:path'
import { isRecord, type JsonObject } from '../shared/guards'

/** The subset of the Telegram Bot API this plugin uses, over plain `fetch`. */
export type TelegramUpdate = { update_id: number; message?: JsonObject; callback_query?: JsonObject }
export type BotIdentity = { id: number; username: string; is_bot?: boolean }
export type SentMessage = { message_id: number }
export type ReplyParameters = { message_id: number }
export type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
export type SendOptions = {
  reply_parameters?: ReplyParameters
  message_thread_id?: number
  parse_mode?: 'MarkdownV2'
  reply_markup?: InlineKeyboard
}
export type EmojiReaction = { type: 'emoji'; emoji: string }
export type GetUpdatesParams = { offset: number; timeout: number; allowed_updates: readonly string[] }

export interface TelegramApi {
  getMe(signal?: AbortSignal): Promise<BotIdentity>
  getUpdates(params: GetUpdatesParams, signal?: AbortSignal): Promise<TelegramUpdate[]>
  getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string }>
  /** Download URL for a `getFile` path; it embeds the token and must never be logged. */
  fileUrl(filePath: string): string
  sendMessage(chatId: string, text: string, options?: SendOptions): Promise<SentMessage>
  sendPhoto(chatId: string, filePath: string, options?: SendOptions): Promise<SentMessage>
  sendDocument(chatId: string, filePath: string, options?: SendOptions): Promise<SentMessage>
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options?: Pick<SendOptions, 'parse_mode' | 'reply_markup'>,
  ): Promise<unknown>
  setMessageReaction(chatId: string, messageId: number, reaction: readonly EmojiReaction[]): Promise<unknown>
  sendChatAction(chatId: string, action: 'typing', options?: { message_thread_id?: number }): Promise<unknown>
  answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<unknown>
}

/** A Bot API call that reached Telegram and was refused, or never completed. Never carries the token. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number | undefined,
    description: string,
  ) {
    super(
      status === undefined
        ? `Telegram ${method} request failed: ${description}`
        : `Telegram ${method} failed (${status}): ${description}`,
    )
    this.name = 'TelegramApiError'
  }
}

export type BotApiOptions = { apiRoot?: string; fetch?: typeof fetch }

const DEFAULT_API_ROOT = 'https://api.telegram.org'
const CALL_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 120_000

export class TelegramBotApi implements TelegramApi {
  readonly #token: string
  readonly #apiRoot: string
  readonly #fetch: typeof fetch

  constructor(token: string, options: BotApiOptions = {}) {
    this.#token = token
    this.#apiRoot = (options.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/u, '')
    this.#fetch = options.fetch ?? fetch
  }

  getMe(signal?: AbortSignal): Promise<BotIdentity> {
    return this.#call('getMe', {}, signal) as Promise<BotIdentity>
  }

  getUpdates(params: GetUpdatesParams, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    // A long poll legitimately outlives the ordinary call timeout; the caller owns its deadline.
    return this.#call('getUpdates', params, signal, (params.timeout + 15) * 1000) as Promise<TelegramUpdate[]>
  }

  getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string }> {
    return this.#call('getFile', { file_id: fileId }, signal) as Promise<{ file_path?: string }>
  }

  fileUrl(filePath: string): string {
    return `${this.#apiRoot}/file/bot${this.#token}/${encodeURI(filePath)}`
  }

  sendMessage(chatId: string, text: string, options: SendOptions = {}): Promise<SentMessage> {
    return this.#call('sendMessage', { chat_id: chatId, text, ...options }) as Promise<SentMessage>
  }

  sendPhoto(chatId: string, filePath: string, options: SendOptions = {}): Promise<SentMessage> {
    return this.#upload('sendPhoto', 'photo', chatId, filePath, options)
  }

  sendDocument(chatId: string, filePath: string, options: SendOptions = {}): Promise<SentMessage> {
    return this.#upload('sendDocument', 'document', chatId, filePath, options)
  }

  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: Pick<SendOptions, 'parse_mode' | 'reply_markup'> = {},
  ): Promise<unknown> {
    return this.#call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...options })
  }

  setMessageReaction(chatId: string, messageId: number, reaction: readonly EmojiReaction[]): Promise<unknown> {
    return this.#call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction })
  }

  sendChatAction(chatId: string, action: 'typing', options: { message_thread_id?: number } = {}): Promise<unknown> {
    return this.#call('sendChatAction', { chat_id: chatId, action, ...options })
  }

  answerCallbackQuery(callbackQueryId: string, options: { text?: string } = {}): Promise<unknown> {
    return this.#call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...options })
  }

  #call(method: string, params: object, signal?: AbortSignal, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    return this.#request(
      method,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      },
      signal,
      timeoutMs,
    )
  }

  #upload(method: string, field: string, chatId: string, filePath: string, options: SendOptions): Promise<SentMessage> {
    const form = new FormData()
    form.set('chat_id', chatId)
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    form.set(field, Bun.file(filePath), basename(filePath))
    return this.#request(method, { method: 'POST', body: form }, undefined, UPLOAD_TIMEOUT_MS) as Promise<SentMessage>
  }

  async #request(
    method: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(`${this.#apiRoot}/bot${this.#token}/${method}`, {
        ...init,
        redirect: 'error',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error) {
      // Transport errors can quote the request URL, which contains the token.
      const reason =
        error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
          ? 'aborted or timed out'
          : 'network error'
      throw new TelegramApiError(method, undefined, reason)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new TelegramApiError(method, response.status, 'response was not JSON')
    }
    if (!isRecord(body) || body.ok !== true) {
      const status = isRecord(body) && typeof body.error_code === 'number' ? body.error_code : response.status
      const description =
        isRecord(body) && typeof body.description === 'string' ? body.description : 'request was rejected'
      throw new TelegramApiError(method, status, description)
    }
    return body.result
  }
}

/** HTTP-style status of a failed Bot API call, when Telegram answered at all. */
export function telegramStatus(error: unknown): number | undefined {
  return error instanceof TelegramApiError ? error.status : undefined
}
