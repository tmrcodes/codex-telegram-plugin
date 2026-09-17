import { AdmissionUncertainError } from '../app-server/transport'
import type { TelegramPolicy } from '../policy/policy'
import { type JsonObject, sleep as realSleep, truncate } from '../shared/guards'
import { allowedInbound, allowedOutbound, type InboundContext, RouteGrants } from './access-rules'
import { type TelegramApi, telegramStatus, type TelegramUpdate } from './bot-api'
import {
  AttachmentTooLargeError,
  AUTO_MEDIA_MAX_BYTES,
  DOWNLOAD_DEADLINE_MS,
  downloadToInbox,
  EXPLICIT_DOWNLOAD_MAX_BYTES,
  isSafeTelegramFilePath,
} from './downloads'
import {
  asRecord,
  attachmentMetadata,
  displayName,
  type InboundMessage,
  isAutoDownloaded,
  isImage,
  type MessageTarget,
  messageText,
  parseEntities,
  type TelegramAttachment,
} from './messages'
import { chunkText, isPhotoPath, MAX_MESSAGE_CHARACTERS, MAX_REPLY_PARTS, resolveOutboundFile } from './outbound'
import { helpReply, pairingPrompt, parseServiceCommand, statusReply } from './service-replies'

const MAX_INBOUND_TEXT_BYTES = 8 * 1024
const POLL_TIMEOUT_SECONDS = 15
export const POLL_DEADLINE_MS = 20_000
const MAX_CONSECUTIVE_CONFLICTS = 8
const UTF8 = new TextEncoder()

/** The live access policy plus the one mutation the adapter may make: issuing a pairing code. */
export type PolicyReader = { read(): TelegramPolicy; beginPair(senderId: string): string | undefined }
export type CallbackOutcome = 'recorded' | 'already' | boolean
export type ReplyArguments = { text?: string; files?: string[]; parse_mode?: 'MarkdownV2' }

/**
 * Why polling ended. Unavailable while a poll is still unwinding: await `poll()` first.
 * `close()` before the first `poll()` records `explicit-close` immediately.
 */
export type TerminalOutcome =
  | { readonly reason: 'explicit-close' }
  | { readonly reason: 'repeated-409-conflict'; readonly error: unknown }
  | { readonly reason: 'admission-uncertain'; readonly error: AdmissionUncertainError }
  | { readonly reason: 'unexpected-fatal-failure'; readonly error: unknown }

export type TelegramAdapterOptions = {
  api: TelegramApi
  policy: PolicyReader
  /** Admits one accepted message into the conversation; throwing keeps the update unacknowledged. */
  receive: (message: InboundMessage) => Promise<void>
  /** Real directories outbound files may come from (workspace and inbox). */
  fileRoots?: readonly string[]
  /** Private directory for downloaded attachments; downloads are refused without it. */
  inbox?: string
  onCallback?: (query: JsonObject) => CallbackOutcome
  onHealth?: (ok: boolean, error?: unknown) => void
  /** Update offset inherited from a previous owner of the same profile. */
  initialOffset?: number
  sleep?: (milliseconds: number) => Promise<void>
  pollDeadlineMs?: number
}

/**
 * The Telegram edge of one conversation: a single long-poll loop, access decisions, bounded
 * downloads and origin-bound replies. It keeps only in-memory, expiring authorizations.
 */
export class TelegramAdapter {
  readonly #api: TelegramApi
  readonly #options: TelegramAdapterOptions
  readonly #grants = new RouteGrants()
  readonly #operations = new Set<Promise<unknown>>()
  #offset: number
  #closed = false
  #polling: Promise<void> | undefined
  #terminal: TerminalOutcome | undefined
  #receiving: Promise<void> | undefined
  #draining: Promise<void> | undefined
  #paused = false
  #pauseGate: Promise<void> | undefined
  #releasePause: (() => void) | undefined
  #identityAbort: AbortController | undefined
  #updatesAbort: AbortController | undefined
  #updatesInFlight: Promise<unknown> | undefined
  #botUsername = ''
  #botId = ''
  #backoff = 0
  #consecutiveConflicts = 0

  constructor(options: TelegramAdapterOptions) {
    const offset = options.initialOffset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Telegram initial poll offset is invalid')
    this.#api = options.api
    this.#options = options
    this.#offset = offset
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  poll(): Promise<void> {
    if (this.#polling !== undefined) return this.#polling
    if (this.#closed) return Promise.resolve()
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const polling = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })
    this.#polling = polling
    // Registered first, so the slot is free before any caller continues after `await poll()`.
    const release = () => {
      if (this.#polling === polling) this.#polling = undefined
    }
    void polling.then(release, release)
    void this.#runPoll().then(
      () => {
        if (this.#closed) this.#latch({ reason: 'explicit-close' })
        resolve()
      },
      error => {
        this.#terminate({ reason: 'unexpected-fatal-failure', error })
        reject(error)
      },
    )
    return polling
  }

  terminalOutcome(): TerminalOutcome | undefined {
    return this.#polling === undefined ? this.#terminal : undefined
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unblockPause()
    this.#identityAbort?.abort()
    this.#updatesAbort?.abort()
    if (this.#polling === undefined) this.#latch({ reason: 'explicit-close' })
  }

  /** Stops ingress and resolves only after every operation already started here has settled. */
  closeAndDrain(): Promise<void> {
    this.close()
    this.#draining ??= this.#settle(() => this.#polling)
    return this.#draining
  }

  /** Stops admitting new updates without closing the poller or moving its in-memory offset. */
  async pauseAndDrain(): Promise<void> {
    if (this.#closed) throw new Error('Telegram adapter is closed')
    if (!this.#paused) {
      this.#paused = true
      this.#pauseGate = new Promise<void>(resolve => {
        this.#releasePause = resolve
      })
    }
    await this.#settle(() => this.#receiving)
  }

  resume(): void {
    if (this.#paused) this.#unblockPause()
  }

  isQuiescent(): boolean {
    return this.#paused && this.#receiving === undefined && this.#operations.size === 0
  }

  /** Next update offset for a successor; valid only once every admitted update advanced it. */
  handoffOffset(): number {
    if (!this.isQuiescent()) throw new Error('Telegram adapter is not quiescent')
    return this.#offset
  }

  // ---- outbound ----------------------------------------------------------------------------

  allowsRoute(target: MessageTarget): boolean {
    try {
      this.#assertOpen()
      this.#assertOutbound(target)
      return true
    } catch {
      return false
    }
  }

  reply(target: MessageTarget, args: ReplyArguments): Promise<number[]> {
    this.#assertOpen()
    return this.#track(() => this.#reply(target, args))
  }

  react(target: MessageTarget, emoji: string): Promise<void> {
    this.#assertOpen()
    return this.#track(async () => {
      this.#assertOutbound(target)
      await this.#api.setMessageReaction(target.chatId, target.messageId, [{ type: 'emoji', emoji }])
    })
  }

  edit(target: MessageTarget, text: string, parseMode?: 'MarkdownV2'): Promise<void> {
    this.#assertOpen()
    return this.#track(async () => {
      this.#assertOutbound(target)
      if (parseMode === undefined) await this.#api.editMessageText(target.chatId, target.messageId, text)
      else await this.#api.editMessageText(target.chatId, target.messageId, text, { parse_mode: parseMode })
    })
  }

  /** Explicit download of a file that was not fetched automatically; returns its local path. */
  downloadAttachment(
    target: { chatId: string; messageId?: number; messageThreadId?: number },
    fileId: string,
    kind: string,
    name = 'attachment',
  ): Promise<string> {
    this.#assertOpen()
    return this.#track(async () => {
      this.#assertOutbound(target)
      return await this.#download(fileId, `${kind}-${name}`, EXPLICIT_DOWNLOAD_MAX_BYTES)
    })
  }

  async #reply(target: MessageTarget, args: ReplyArguments): Promise<number[]> {
    const policy = this.#assertOutbound(target)
    const text = args.text ?? ''
    const formatted = args.parse_mode !== undefined
    if (formatted && text === '' && (args.files?.length ?? 0) > 0)
      throw new Error('formatted Telegram reply requires text')
    // MarkdownV2 entities cannot be split safely, so a formatted reply must fit one message.
    if (formatted && Array.from(text).length > policy.textChunkLimit)
      throw new Error('formatted Telegram reply exceeds one-message limit')
    const parts = formatted ? [text] : text === '' ? [] : chunkText(text, policy.textChunkLimit, policy.chunkMode)
    const files = (args.files ?? []).map(file => resolveOutboundFile(file, this.#options.fileRoots ?? []))
    if (parts.length + files.length > MAX_REPLY_PARTS)
      throw new Error('Telegram reply exceeds the bounded 16-part limit')

    const sent: number[] = []
    const optionsFor = (index: number) => {
      const threaded = policy.replyToMode === 'all' || (policy.replyToMode === 'first' && index === 0)
      return {
        ...(threaded ? { reply_parameters: { message_id: target.messageId } } : {}),
        ...(target.messageThreadId === undefined ? {} : { message_thread_id: target.messageThreadId }),
      }
    }
    for (const [index, part] of parts.entries()) {
      this.#assertOutbound(target)
      const result = await this.#api.sendMessage(target.chatId, part, {
        ...optionsFor(index),
        ...(formatted ? { parse_mode: args.parse_mode } : {}),
      })
      sent.push(result.message_id)
      this.#grants.extend(target, result.message_id)
    }
    for (const [index, path] of files.entries()) {
      this.#assertOutbound(target)
      const send = isPhotoPath(path) ? this.#api.sendPhoto : this.#api.sendDocument
      const result = await send.call(this.#api, target.chatId, path, optionsFor(parts.length + index))
      sent.push(result.message_id)
      this.#grants.extend(target, result.message_id)
    }
    return sent
  }

  // ---- polling -----------------------------------------------------------------------------

  async #runPoll(): Promise<void> {
    while (!this.#closed) {
      try {
        if (this.#botUsername === '') {
          const identity = await this.#identity()
          if (this.#closed) return
          this.#botUsername = identity.username
          this.#botId = String(identity.id)
        }
        const updates = await this.#getUpdates()
        this.#backoff = 0
        this.#consecutiveConflicts = 0
        if (this.#closed) return
        await this.#waitUntilResumed()
        if (this.#closed) return
        this.#health(true)
        for (const update of updates) {
          if (this.#closed) return
          // Pause between updates, never between a successful admission and its offset
          // advance; otherwise a successor session could replay that message.
          await this.#waitUntilResumed()
          if (this.#closed) return
          const receiving = this.#receiveUpdate(update)
          this.#receiving = receiving
          try {
            await receiving
          } finally {
            if (this.#receiving === receiving) this.#receiving = undefined
          }
        }
      } catch (error) {
        if (error instanceof AdmissionUncertainError) {
          // The message may already be in the conversation; replaying it could repeat an action.
          this.#terminate({ reason: 'admission-uncertain', error })
          this.#health(false, error)
          return
        }
        if (this.#closed) return
        this.#health(false, error)
        const delay = this.#nextBackoff(error)
        if (this.#closed) return
        await (this.#options.sleep ?? realSleep)(delay)
      }
    }
  }

  async #identity() {
    const controller = new AbortController()
    this.#identityAbort = controller
    try {
      const identity = await this.#track(() => this.#api.getMe(controller.signal))
      this.#backoff = 0
      this.#consecutiveConflicts = 0
      return identity
    } finally {
      if (this.#identityAbort === controller) this.#identityAbort = undefined
    }
  }

  async #getUpdates(): Promise<TelegramUpdate[]> {
    if (this.#closed) return []
    // An aborted request may still be unwinding; never run two getUpdates calls at once.
    if (this.#updatesInFlight !== undefined) await this.#updatesInFlight
    if (this.#closed) return []
    const controller = new AbortController()
    this.#updatesAbort = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Telegram getUpdates deadline exceeded'))
      }, this.#options.pollDeadlineMs ?? POLL_DEADLINE_MS)
    })
    const request = this.#track(() =>
      this.#api.getUpdates(
        { offset: this.#offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message', 'callback_query'] },
        controller.signal,
      ),
    )
    this.#updatesInFlight = request
    const settled = () => {
      if (this.#updatesInFlight === request) this.#updatesInFlight = undefined
      if (this.#updatesAbort === controller) this.#updatesAbort = undefined
    }
    void request.then(settled, settled)
    try {
      return await Promise.race([request, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Another poller holding this bot answers 409; give up rather than fight it forever. */
  #nextBackoff(error: unknown): number {
    if (telegramStatus(error) === 409) {
      this.#consecutiveConflicts++
      if (this.#consecutiveConflicts >= MAX_CONSECUTIVE_CONFLICTS) {
        this.#terminate({ reason: 'repeated-409-conflict', error })
        return 0
      }
    } else {
      this.#consecutiveConflicts = 0
      this.#backoff = Math.min(this.#backoff + 1, 4)
    }
    return Math.min(15_000, 1_000 * 2 ** Math.min(this.#backoff, 3))
  }

  async #receiveUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message !== undefined) await this.#receiveMessage(update.message)
    if (this.#closed) return
    if (update.callback_query !== undefined) await this.#receiveCallback(update.callback_query)
    if (!this.#closed) this.#offset = Math.max(this.#offset, update.update_id + 1)
  }

  async #receiveCallback(query: JsonObject): Promise<void> {
    try {
      const outcome = this.#options.onCallback?.(query) ?? false
      if (outcome && typeof query.id === 'string') {
        const id = query.id
        await this.#track(() =>
          this.#api.answerCallbackQuery(id, { text: outcome === 'already' ? 'Already resolved' : 'Recorded' }),
        )
      }
    } catch {
      /* a callback failure must never reach the model */
    }
  }

  // ---- inbound -----------------------------------------------------------------------------

  async #receiveMessage(message: JsonObject): Promise<void> {
    if (this.#closed) return
    const chat = asRecord(message.chat)
    const from = asRecord(message.from)
    const { text, entities } = messageText(message)
    if (
      chat === undefined ||
      from === undefined ||
      text === undefined ||
      typeof message.message_id !== 'number' ||
      typeof chat.id !== 'number' ||
      typeof chat.type !== 'string' ||
      typeof from.id !== 'number' ||
      typeof message.date !== 'number'
    )
      return
    const chatId = String(chat.id)
    const senderId = String(from.id)
    const messageId = message.message_id
    const replyTo = { reply_parameters: { message_id: messageId } }
    const policy = this.#options.policy.read()

    // Service commands never reach the model, never reveal a code in a group and never
    // turn an unknown sender in allowlist mode into an admitted conversation.
    const command = parseServiceCommand(text)
    if (command !== undefined) {
      const forAnotherBot =
        command.addressedTo !== undefined && command.addressedTo.toLowerCase() !== this.#botUsername.toLowerCase()
      if (chat.type !== 'private' || policy.dmPolicy === 'disabled' || forAnotherBot) return
      if (!policy.allowFrom.has(senderId) && policy.dmPolicy !== 'pairing') return
      await this.#api.sendMessage(
        chatId,
        command.name === 'status' ? statusReply(policy, senderId) : helpReply(policy, senderId),
        replyTo,
      )
      return
    }

    if (chat.type === 'private' && policy.dmPolicy === 'pairing' && !policy.allowFrom.has(senderId)) {
      const code = this.#options.policy.beginPair(senderId)
      if (code !== undefined) await this.#api.sendMessage(chatId, pairingPrompt(code), replyTo)
      return
    }

    const context: InboundContext = {
      chatId,
      chatType: chat.type,
      senderId,
      text,
      entities,
      replyToMessage: message.reply_to_message,
      senderChat: message.sender_chat,
      botUsername: this.#botUsername,
      botId: this.#botId,
    }
    if (!allowedInbound(policy, context)) return
    const bytes = UTF8.encode(text).byteLength
    if (bytes === 0 || bytes > MAX_INBOUND_TEXT_BYTES) return

    if (policy.typing) {
      const topic = message.message_thread_id
      try {
        await this.#track(() =>
          typeof topic === 'number'
            ? this.#api.sendChatAction(chatId, 'typing', { message_thread_id: topic })
            : this.#api.sendChatAction(chatId, 'typing'),
        )
        if (this.#closed) return
      } catch {
        /* typing is best-effort, admission is not */
      }
    }

    const inGroup = chatId.startsWith('-') && (chat.type === 'group' || chat.type === 'supergroup')
    const attachments = await this.#attachments(message)
    if (this.#closed) return
    // Only the embedded immediate reply is available; never fetch history or recurse.
    const reply = asRecord(message.reply_to_message)
    const replyChat = asRecord(reply?.chat)
    if (
      reply !== undefined &&
      typeof reply.message_id === 'number' &&
      (replyChat === undefined || replyChat.id === chat.id)
    ) {
      attachments.push(
        ...(await this.#attachments(reply)).map(attachment => ({ ...attachment, source: 'reply' as const })),
      )
    }
    if (this.#closed) return
    // Downloads take time; a group sender revoked meanwhile must not be admitted.
    if (inGroup && !allowedInbound(this.#options.policy.read(), context)) return

    const replyFrom = asRecord(reply?.from)
    const replyText =
      typeof reply?.text === 'string' ? reply.text : typeof reply?.caption === 'string' ? reply.caption : undefined
    const senderChat = asRecord(message.sender_chat)
    const inbound: InboundMessage = {
      id: `telegram:${chatId}:${messageId}`,
      chatId,
      chatType: chat.type,
      messageId,
      senderId,
      sender:
        [from.first_name, from.last_name]
          .filter(value => typeof value === 'string')
          .join(' ')
          .trim() || senderId,
      ...(typeof from.username === 'string' ? { username: from.username } : {}),
      ...(senderChat !== undefined && typeof senderChat.id === 'number' ? { senderChatId: String(senderChat.id) } : {}),
      timestamp: message.date,
      text,
      entities: parseEntities(entities),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(typeof message.message_thread_id === 'number' ? { messageThreadId: message.message_thread_id } : {}),
      ...(reply !== undefined && typeof reply.message_id === 'number' ? { replyToMessageId: reply.message_id } : {}),
      ...(replyFrom === undefined ? {} : { replySender: displayName(replyFrom) }),
      ...(replyText === undefined ? {} : { replyText: truncate(replyText, 1024) }),
    }
    if (this.#closed) return
    if (inGroup) this.#grants.grant(inbound, senderId)
    try {
      await this.#options.receive(inbound)
    } catch (error) {
      if (inGroup) this.#grants.revokeOrigin(inbound)
      throw error
    }

    let current: TelegramPolicy
    try {
      current = inGroup ? this.#options.policy.read() : policy
    } catch {
      return
    }
    if (current.ackReaction !== '' && (!inGroup || allowedInbound(current, context))) {
      const reaction = [{ type: 'emoji' as const, emoji: current.ackReaction }]
      void this.#track(() => this.#api.setMessageReaction(chatId, messageId, reaction)).catch(() => {})
    }
  }

  async #attachments(message: JsonObject): Promise<TelegramAttachment[]> {
    const attachment = attachmentMetadata(message)
    if (attachment === undefined) return []
    if (!isAutoDownloaded(attachment)) return [attachment]
    attachment.downloadLimit = AUTO_MEDIA_MAX_BYTES
    if (attachment.size !== undefined && attachment.size > AUTO_MEDIA_MAX_BYTES) {
      attachment.downloadStatus = 'skipped_oversize'
      return [attachment]
    }
    try {
      const path = await this.#track(() =>
        this.#download(
          attachment.fileId,
          attachment.name === undefined ? attachment.kind : `${attachment.kind}-${attachment.name}`,
          AUTO_MEDIA_MAX_BYTES,
        ),
      )
      attachment.localPath = path
      if (isImage(attachment)) attachment.localImagePath = path
      attachment.downloadStatus = 'downloaded'
    } catch (error) {
      attachment.downloadStatus = error instanceof AttachmentTooLargeError ? 'skipped_oversize' : 'failed'
    }
    return [attachment]
  }

  /** One deadline covers both `getFile` and the byte stream. */
  async #download(fileId: string, stem: string, maxBytes: number): Promise<string> {
    const signal = AbortSignal.timeout(DOWNLOAD_DEADLINE_MS)
    const file = await this.#api.getFile(fileId, signal)
    if (typeof file.file_path !== 'string') throw new Error('Telegram attachment file path is unavailable')
    if (this.#options.inbox === undefined || !isSafeTelegramFilePath(file.file_path))
      throw new Error('attachment download is not configured')
    return await downloadToInbox({
      url: this.#api.fileUrl(file.file_path),
      inbox: this.#options.inbox,
      stem,
      providerPath: file.file_path,
      maxBytes,
      signal,
    })
  }

  // ---- internals ---------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw new Error('Telegram adapter is closed')
  }

  /** Re-reads the live policy for every outbound step, so a revoked route stops mid-reply. */
  #assertOutbound(target: { chatId: string; messageId?: number; messageThreadId?: number }): TelegramPolicy {
    const policy = this.#options.policy.read()
    if (!allowedOutbound(policy, target, this.#grants)) throw new Error('Telegram route is no longer allowed')
    return policy
  }

  #track<T>(start: () => Promise<T> | T): Promise<T> {
    const tracked = (async () => await start())()
    this.#operations.add(tracked)
    const forget = () => {
      this.#operations.delete(tracked)
    }
    void tracked.then(forget, forget)
    return tracked
  }

  /** Waits until tracked operations and the given in-progress promise have all settled. */
  async #settle(current: () => Promise<unknown> | undefined): Promise<void> {
    for (;;) {
      const pending = [...this.#operations]
      const active = current()
      if (pending.length === 0 && active === undefined) return
      await Promise.allSettled(active === undefined ? pending : [...pending, active])
    }
  }

  async #waitUntilResumed(): Promise<void> {
    while (this.#paused && !this.#closed) await this.#pauseGate
  }

  #unblockPause(): void {
    this.#paused = false
    const release = this.#releasePause
    this.#releasePause = undefined
    this.#pauseGate = undefined
    release?.()
  }

  #latch(outcome: TerminalOutcome): void {
    if (this.#terminal === undefined || this.#terminal.reason === 'explicit-close')
      this.#terminal = Object.freeze({ ...outcome }) as TerminalOutcome
  }

  #terminate(outcome: TerminalOutcome): void {
    this.#latch(outcome)
    this.#closed = true
    this.#unblockPause()
    this.#identityAbort?.abort()
    this.#updatesAbort?.abort()
  }

  #health(ok: boolean, error?: unknown): void {
    try {
      this.#options.onHealth?.(ok, error)
    } catch {
      /* an observer failure cannot alter admission state */
    }
  }
}

export { MAX_MESSAGE_CHARACTERS }
