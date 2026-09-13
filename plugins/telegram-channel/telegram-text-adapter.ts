import { Bot, InputFile } from 'grammy'
import { lstatSync, realpathSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import type { TelegramPolicy, TelegramPolicySource } from './telegram-policy'
import { AppServerAdmissionUncertainError } from './app-server-controller/protocol'

const MAX_TEXT_BYTES = 8 * 1024
export const MAX_TELEGRAM_TEXT_CHARACTERS = 4096
export const TELEGRAM_POLL_DEADLINE_MS = 20_000
const UTF8 = new TextEncoder()

export type TelegramEntity = { type: string; offset: number; length: number; url?: string; language?: string; customEmojiId?: string; textMention?: { userId: string; username?: string; display?: string } }
export type TelegramAttachment = { kind: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'sticker'; fileId: string; source?: 'reply'; name?: string; title?: string; mime?: string; size?: number; width?: number; height?: number; duration?: number; stickerEmoji?: string; stickerSetName?: string; stickerType?: string; localImagePath?: string }
export type TelegramTextRoute = {
  id: string; chatId: string; chatType: string; messageId: number; messageThreadId?: number; senderId?: string; sender?: string; username?: string; senderChatId?: string; timestamp: number; text: string; entities: TelegramEntity[]; attachments?: TelegramAttachment[]; replyToMessageId?: number; replySender?: string; replyText?: string
}
export type TelegramTextConfig = { allowedChats: ReadonlySet<string>; allowedSenders: ReadonlySet<string>; requireMention: boolean }
/**
 * Read-only terminal lifecycle result. It is deliberately unavailable while a
 * poll/receive is still unwinding; callers must await `poll()` before relying
 * on it. `close()` before the first `poll()` immediately records explicit-close.
 */
export type TelegramTextTerminalOutcome =
  | { readonly reason: 'explicit-close' }
  | { readonly reason: 'repeated-409-conflict'; readonly error: unknown }
  | { readonly reason: 'admission-uncertain'; readonly error: AppServerAdmissionUncertainError }
  | { readonly reason: 'unexpected-fatal-failure'; readonly error: unknown }

/** Bounded Telegram text-and-media edge. It carries visible metadata and only bounded ephemeral authorization grants, never a durable route ledger. */
export class TelegramTextAdapter {
  #offset = 0
  #closed = false
  #polling: Promise<void> | undefined
  #terminal: TelegramTextTerminalOutcome | undefined
  #operations = new Set<Promise<unknown>>()
  #receiving: Promise<void> | undefined
  #paused = false
  #resume: (() => void) | undefined
  #pauseGate: Promise<void> | undefined
  #draining: Promise<void> | undefined
  #identityAbort: AbortController | undefined
  #updatesAbort: AbortController | undefined
  #username = ''
  #botId = ''
  #fallbackGrants = new Map<string, { senderId: string; expiresAt: number; origin: string }>()
  constructor(private readonly bot: Bot, private readonly config: TelegramTextConfig | TelegramPolicySource, private readonly receive: (route: TelegramTextRoute) => Promise<void>, private readonly sleep: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds), private readonly fileRoots: readonly string[] = [], private readonly inbox?: string, private readonly apiRoot?: string, private readonly onCallback?: (query: Record<string, unknown>) => 'recorded' | 'already' | boolean, private readonly onHealth?: (ok: boolean, error?: unknown) => void, private readonly pollDeadlineMilliseconds = TELEGRAM_POLL_DEADLINE_MS, private readonly downloadUrl?: (filePath: string) => string) {}
  poll(): Promise<void> {
    if (this.#polling !== undefined) return this.#polling
    if (this.#closed) return Promise.resolve()
    let resolve!: () => void; let reject!: (error: unknown) => void
    const polling = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    this.#polling = polling
    void this.#runPoll().then(() => { this.#finishExplicitClose(); resolve() }, error => { this.#terminate({ reason: 'unexpected-fatal-failure', error }); reject(error) })
    void polling.then(() => { if (this.#polling === polling) this.#polling = undefined }, () => { if (this.#polling === polling) this.#polling = undefined })
    return polling
  }
  terminalOutcome(): TelegramTextTerminalOutcome | undefined { return this.#polling === undefined ? this.#terminal : undefined }
  /** Stops new update admission without closing the live poller or changing its in-memory offset. */
  async pauseAndDrain(): Promise<void> { if (this.#closed) throw new Error('Telegram adapter is closed'); if (!this.#paused) { this.#paused = true; this.#pauseGate = new Promise<void>(resolve => { this.#resume = resolve }) } await this.#waitForQuiescence() }
  /** Releases a prior in-memory transition pause on this same live poll loop. */
  resume(): void { if (!this.#paused) return; this.#paused = false; const resume = this.#resume; this.#resume = undefined; this.#pauseGate = undefined; resume?.() }
  isQuiescent(): boolean { return this.#paused && this.#receiving === undefined && this.#operations.size === 0 }
  /** Stops ingress and resolves only after every operation already started by this adapter has settled. */
  closeAndDrain(): Promise<void> {
    this.close()
    if (this.#draining === undefined) {
      let resolve!: () => void; let reject!: (error: unknown) => void
      const draining = new Promise<void>((done, fail) => { resolve = done; reject = fail })
      this.#draining = draining
      void this.#waitForDrain().then(resolve, reject)
    }
    return this.#draining
  }
  /** Alias for closeAndDrain: draining a live poller first closes it to prevent new work. */
  drain(): Promise<void> { return this.closeAndDrain() }
  async #runPoll(): Promise<void> {
    while (!this.#closed) {
      try {
        if (this.#username === '') { const identity = await this.#identity(); if (this.#closed) return; this.#username = identity.username; this.#botId = String(identity.id) }
        const updates = await this.#retry(() => this.#getUpdates())
        if (this.#closed) return
        await this.#waitUntilResumed()
        if (this.#closed) return
        this.#health(true)
        for (const update of updates) { if (this.#closed) return; await this.#waitUntilResumed(); if (this.#closed) return; const message = update.message; if (message !== undefined) { const receiving = this.#receiveMessage(message as unknown as Record<string, unknown>); this.#receiving = receiving; try { await receiving } finally { if (this.#receiving === receiving) this.#receiving = undefined } } if (this.#closed) return; await this.#waitUntilResumed(); if (this.#closed) return; const callback = update.callback_query; if (callback !== undefined) { try { const rawCallback = callback as unknown as Record<string, unknown>; const accepted = this.onCallback?.(rawCallback) ?? false; const callbackId = rawCallback.id; if (accepted && typeof callbackId === 'string') await this.#track(() => this.bot.api.answerCallbackQuery(callbackId, { text: accepted === 'already' ? 'Already resolved' : 'Recorded' })) } catch { /* callback failure cannot enter model input */ } } if (this.#closed) return; await this.#waitUntilResumed(); if (this.#closed) return; this.#offset = Math.max(this.#offset, update.update_id + 1) }
      } catch (error) {
        if (error instanceof AppServerAdmissionUncertainError) { this.#terminate({ reason: 'admission-uncertain', error }); this.#health(false, error); return }
        if (this.#closed) return
        this.#health(false, error)
        const delay = this.#nextBackoff(error)
        if (this.#closed) return
        await this.sleep(delay)
      }
    }
  }
  close(): void { if (this.#closed) return; this.#closed = true; this.#unblockPause(); this.#identityAbort?.abort(); this.#updatesAbort?.abort(); if (this.#polling === undefined) this.#latch({ reason: 'explicit-close' }) }
  allowsRoute(route: { chatId: string; messageId: number; messageThreadId?: number }): boolean { try { this.#assertOpen(); this.#assertOutbound(route); return true } catch { return false } }
  reply(route: { chatId: string; messageId: number; messageThreadId?: number }, args: { text?: string; files?: string[]; parse_mode?: 'MarkdownV2' }): Promise<number[]> { this.#assertOpen(); return this.#track(() => this.#reply(route, args)) }
  async #reply(route: { chatId: string; messageId: number; messageThreadId?: number }, args: { text?: string; files?: string[]; parse_mode?: 'MarkdownV2' }): Promise<number[]> {
    const policy = this.#assertOutbound(route)
    const limit = policy?.textChunkLimit ?? MAX_TELEGRAM_TEXT_CHARACTERS; const mode = policy?.chunkMode ?? 'length'; const replyMode = policy?.replyToMode ?? 'first'
    const formatted = args.parse_mode !== undefined; const replyText = args.text ?? ''
    if (formatted && replyText === '' && (args.files?.length ?? 0) > 0) throw new Error('formatted Telegram reply requires text')
    if (formatted && Array.from(replyText).length > limit) throw new Error('formatted Telegram reply exceeds one-message limit')
    const parts = formatted ? [replyText] : (replyText === '' ? [] : chunkTelegramText(replyText, limit, mode)); const files = (args.files ?? []).map(file => this.#file(file)); if (parts.length + files.length > 16) throw new Error('Telegram reply exceeds the bounded 16-part limit')
    const ids: number[] = []
    for (const [index, text] of parts.entries()) {
      this.#assertOutbound(route)
      const reply = replyMode === 'all' || (replyMode === 'first' && index === 0)
      const result = await this.#track(() => this.bot.api.sendMessage(route.chatId, text, { ...(reply ? { reply_parameters: { message_id: route.messageId } } : {}), ...(route.messageThreadId === undefined ? {} : { message_thread_id: route.messageThreadId }), ...(args.parse_mode === undefined ? {} : { parse_mode: args.parse_mode }) }))
      ids.push(result.message_id); this.#grantOutbound(route, result.message_id)
    }
    for (const [index, path] of files.entries()) { this.#assertOutbound(route); const reply = replyMode === 'all' || (replyMode === 'first' && parts.length + index === 0); const options = { ...(reply ? { reply_parameters: { message_id: route.messageId } } : {}), ...(route.messageThreadId === undefined ? {} : { message_thread_id: route.messageThreadId }) }; const result = photo(path) ? await this.#track(() => this.bot.api.sendPhoto(route.chatId, new InputFile(path), options)) : await this.#track(() => this.bot.api.sendDocument(route.chatId, new InputFile(path), options)); ids.push(result.message_id); this.#grantOutbound(route, result.message_id) }
    return ids
  }
  react(route: { chatId: string; messageId: number; messageThreadId?: number }, emoji: string): Promise<void> { this.#assertOpen(); return this.#track(async () => { this.#assertOutbound(route); await this.#track(() => this.bot.api.setMessageReaction(route.chatId, route.messageId, [{ type: 'emoji', emoji: emoji as never }])) }) }
  edit(route: { chatId: string; messageId: number; messageThreadId?: number }, text: string, parse_mode?: 'MarkdownV2'): Promise<void> { this.#assertOpen(); return this.#track(async () => { this.#assertOutbound(route); const options = parse_mode === undefined ? [] : [{ parse_mode }]; await this.#track(() => this.bot.api.editMessageText(route.chatId, route.messageId, text, ...options)) }) }
  #file(value: string): string { const path = resolve(value); const candidate = lstatSync(path); const real = realpathSync(path); const stat = lstatSync(real); if (candidate.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024 || !this.fileRoots.some(root => real === root || real.startsWith(`${root}${sep}`))) throw new Error('outbound file is outside the bounded workspace/inbox contract'); return real }
  #backoff = 0
  #consecutive409 = 0
  async #identity() {
    const controller = new AbortController(); this.#identityAbort = controller
    try { return await this.#retry(() => this.#track(() => this.bot.api.getMe(controller.signal))) }
    finally { if (this.#identityAbort === controller) this.#identityAbort = undefined }
  }
  async #getUpdates() {
    if (this.#closed) return []
    if (this.#updatesPhysical !== undefined) await this.#updatesPhysical
    if (this.#closed) return []
    const controller = new AbortController()
    this.#updatesAbort = controller
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('Telegram getUpdates deadline exceeded')) }, this.pollDeadlineMilliseconds)
    })
    const request = this.#track(() => this.bot.api.getUpdates({ offset: this.#offset, timeout: 15, allowed_updates: ['message', 'callback_query'] }, controller.signal))
    this.#updatesPhysical = request
    void request.then(() => { if (this.#updatesPhysical === request) this.#updatesPhysical = undefined; if (this.#updatesAbort === controller) this.#updatesAbort = undefined }, () => { if (this.#updatesPhysical === request) this.#updatesPhysical = undefined; if (this.#updatesAbort === controller) this.#updatesAbort = undefined })
    try { return await Promise.race([request, deadline]) }
    finally { if (timeout !== undefined) clearTimeout(timeout) }
  }
  async #retry<T>(operation: () => Promise<T>): Promise<T> { try { const result = await operation(); this.#backoff = 0; this.#consecutive409 = 0; return result } catch (error) { throw error } }
  #nextBackoff(error: unknown): number { if (/409/u.test(error instanceof Error ? error.message : String(error))) { this.#consecutive409++; if (this.#consecutive409 >= 8) { this.#terminate({ reason: 'repeated-409-conflict', error }); return 0 } } else { this.#consecutive409 = 0; this.#backoff = Math.min(this.#backoff + 1, 4) } return Math.min(15_000, 1_000 * (2 ** Math.min(this.#backoff, 3))) }
  #latch(outcome: TelegramTextTerminalOutcome): void { if (this.#terminal === undefined || this.#terminal.reason === 'explicit-close') this.#terminal = Object.freeze({ ...outcome }) as TelegramTextTerminalOutcome }
  #terminate(outcome: TelegramTextTerminalOutcome): void { this.#latch(outcome); this.#closed = true; this.#unblockPause(); this.#identityAbort?.abort(); this.#updatesAbort?.abort() }
  #finishExplicitClose(): void { if (this.#closed) this.#latch({ reason: 'explicit-close' }) }
  #health(ok: boolean, error?: unknown): void { try { this.onHealth?.(ok, error) } catch { /* observer failure cannot alter terminal admission state */ } }
  #updatesPhysical: Promise<unknown> | undefined
  #assertOpen(): void { if (this.#closed) throw new Error('Telegram adapter is closed') }
  #track<T>(start: () => Promise<T> | T): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (error: unknown) => void
    const tracked = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    this.#operations.add(tracked)
    void tracked.then(() => { this.#operations.delete(tracked) }, () => { this.#operations.delete(tracked) })
    try { Promise.resolve(start()).then(resolve, reject) } catch (error) { reject(error) }
    return tracked
  }
  async #waitForDrain(): Promise<void> {
    for (;;) {
      const pending = [...this.#operations]
      const polling = this.#polling
      if (pending.length === 0 && polling === undefined) return
      await Promise.all(pending.concat(polling === undefined ? [] : [polling]).map(operation => operation.then(() => undefined, () => undefined)))
    }
  }
  async #waitUntilResumed(): Promise<void> { while (this.#paused && !this.#closed) await this.#pauseGate }
  #unblockPause(): void { this.#paused = false; const resume = this.#resume; this.#resume = undefined; this.#pauseGate = undefined; resume?.() }
  async #waitForQuiescence(): Promise<void> {
    for (;;) {
      const pending = [...this.#operations]
      const receiving = this.#receiving
      if (pending.length === 0 && receiving === undefined) return
      await Promise.all([...pending, ...(receiving === undefined ? [] : [receiving])].map(operation => operation.then(() => undefined, () => undefined)))
    }
  }
  async #receiveMessage(message: Record<string, unknown>): Promise<void> {
    if (this.#closed) return
    const chat = asRecord(message.chat); const from = asRecord(message.from); const kind = mediaKind(message); const usesCaption = typeof message.text !== 'string' && typeof message.caption === 'string'; const audio = kind === 'audio' ? asRecord(message.audio) : undefined; const title = typeof audio?.title === 'string' ? bounded(audio.title, 128) : undefined; const text = typeof message.text === 'string' ? message.text : usesCaption ? message.caption as string : kind === undefined ? undefined : kind === 'audio' && title !== undefined && title !== '' ? `[audio: ${title}]` : `[${kind}]`; const messageEntities = usesCaption ? message.caption_entities : message.entities
    if (chat === undefined || from === undefined || text === undefined || typeof message.message_id !== 'number' || typeof chat.id !== 'number' || typeof chat.type !== 'string' || typeof from.id !== 'number' || typeof message.date !== 'number') return
    const chatId = String(chat.id); const senderId = String(from.id); const messageId = message.message_id
    const policy = this.#policy()
    if (policy !== undefined && chat.type === 'private' && policy.dmPolicy === 'pairing' && !policy.allowFrom.has(senderId)) {
      const code = isPolicySource(this.config) ? this.config.beginPair(senderId) : undefined
      if (code !== undefined) await this.bot.api.sendMessage(chatId, `Pairing code: ${code}`, { reply_parameters: { message_id: message.message_id } })
      return
    }
    if (policy === undefined) {
      const legacy = this.config as TelegramTextConfig
      if (!legacy.allowedChats.has(chatId) || !legacy.allowedSenders.has(senderId) || (chat.type !== 'private' && legacy.requireMention && !new RegExp(`(^|\\s)@${escape(this.#username)}(?:\\s|$)`, 'iu').test(text))) return
    } else if (!allowedInbound(policy, chatId, senderId, chat.type, text, this.#username, this.#botId, messageEntities, message.reply_to_message, message.sender_chat)) return
    if (UTF8.encode(text).byteLength === 0 || UTF8.encode(text).byteLength > MAX_TEXT_BYTES) return
    const sender = [from.first_name, from.last_name].filter(value => typeof value === 'string').join(' ').trim() || senderId
    const reply = asRecord(message.reply_to_message); const replyFrom = reply === undefined ? undefined : asRecord(reply.from); const senderChat = asRecord(message.sender_chat)
    if (policy?.typing) try { await this.#track(() => this.bot.api.sendChatAction(chatId, 'typing', ...(typeof message.message_thread_id === 'number' ? [{ message_thread_id: message.message_thread_id }] : [] ))); if (this.#closed) return } catch { /* typing is best-effort, admission is not */ }
    const groupGrant = policy !== undefined && chatId.startsWith('-') && (chat.type === 'group' || chat.type === 'supergroup')
    const attachments = await this.#attachments(message, chatId, message.message_id)
    if (this.#closed) return
    // Only the embedded immediate reply is available; never fetch history or recurse.
    // Its media capability remains bound to the current admitted sender/message/topic.
    const replyChat = asRecord(reply?.chat)
    if (reply !== undefined && typeof reply.message_id === 'number' && (replyChat === undefined || replyChat.id === chat.id)) {
      attachments.push(...(await this.#attachments(reply, chatId, message.message_id)).map(attachment => ({ ...attachment, source: 'reply' as const })))
    }
    if (this.#closed) return
    const currentPolicy = groupGrant ? this.#policy() : policy
    if (groupGrant && (currentPolicy === undefined || !allowedInbound(currentPolicy, chatId, senderId, chat.type, text, this.#username, this.#botId, messageEntities, message.reply_to_message, message.sender_chat))) return
    const replyText = typeof reply?.text === 'string' ? reply.text : typeof reply?.caption === 'string' ? reply.caption : undefined
    const route: TelegramTextRoute = { id: `telegram:${chatId}:${message.message_id}`, chatId, chatType: chat.type, messageId: message.message_id, senderId, sender, ...(typeof from.username === 'string' ? { username: from.username } : {}), ...(senderChat !== undefined && typeof senderChat.id === 'number' ? { senderChatId: String(senderChat.id) } : {}), timestamp: message.date, text, entities: entities(messageEntities), ...(attachments.length === 0 ? {} : { attachments }), ...(typeof message.message_thread_id === 'number' ? { messageThreadId: message.message_thread_id } : {}), ...(reply !== undefined && typeof reply.message_id === 'number' ? { replyToMessageId: reply.message_id } : {}), ...(replyFrom === undefined ? {} : { replySender: display(replyFrom) }), ...(replyText === undefined ? {} : { replyText: bounded(replyText, 1024) }) }
    if (this.#closed) return
    if (groupGrant) this.#grant(route, senderId)
    try { await this.receive(route) } catch (error) { if (groupGrant) this.#revokeGrantOrigin(grantKey(route)); throw error }
    let ackPolicy: TelegramPolicy | undefined
    try { ackPolicy = groupGrant ? this.#policy() : policy } catch { return }
    if (ackPolicy !== undefined && ackPolicy.ackReaction !== '' && (!groupGrant || allowedInbound(ackPolicy, chatId, senderId, chat.type, text, this.#username, this.#botId, messageEntities, message.reply_to_message, message.sender_chat))) void this.#track(() => this.bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: ackPolicy.ackReaction as never }])).catch(() => {})
  }
  #policy(): TelegramPolicy | undefined { return isPolicySource(this.config) ? this.config.read() : undefined }
  #assertOutbound(route: { chatId: string; messageId?: number; messageThreadId?: number }): TelegramPolicy | undefined { const policy = this.#policy(); if (!allowedOutbound(policy, route, this.#fallbackGrants)) throw new Error('Telegram route is no longer allowed'); return policy }
  #grant(route: { chatId: string; messageId: number; messageThreadId?: number }, senderId: string, expiresAt = Math.floor(Date.now() / 1000) + 3600, origin = grantKey(route)): void { this.#pruneGrants(); this.#fallbackGrants.set(grantKey(route), { senderId, expiresAt, origin }); while (this.#fallbackGrants.size > 256) this.#fallbackGrants.delete(this.#fallbackGrants.keys().next().value!) }
  #grantOutbound(route: { chatId: string; messageId: number; messageThreadId?: number }, messageId: number): void { const grant = this.#fallbackGrants.get(grantKey(route)); if (grant !== undefined) this.#grant({ chatId: route.chatId, messageId, ...(route.messageThreadId === undefined ? {} : { messageThreadId: route.messageThreadId }) }, grant.senderId, grant.expiresAt, grant.origin) }
  #revokeGrantOrigin(origin: string): void { for (const [key, grant] of this.#fallbackGrants) if (grant.origin === origin) this.#fallbackGrants.delete(key) }
  #pruneGrants(now = Math.floor(Date.now() / 1000)): void { for (const [key, grant] of this.#fallbackGrants) if (grant.expiresAt < now) this.#fallbackGrants.delete(key) }
  downloadAttachment(route: { chatId: string; messageId?: number; messageThreadId?: number }, fileId: string, kind: string, name = 'attachment'): Promise<string> { this.#assertOpen(); return this.#track(async () => { this.#assertOutbound(route); const file = await this.#track(() => this.bot.api.getFile(fileId)); if (typeof file.file_path !== 'string') throw new Error('Telegram attachment file path is unavailable'); return await this.#download(file.file_path, `${kind}-${name}`) }) }
  async #attachments(message: Record<string, unknown>, _chatId: string, _messageId: number): Promise<TelegramAttachment[]> { const kind = mediaKind(message); if (kind === undefined) return []; const value = kind === 'photo' ? largestPhoto(message.photo) : asRecord(message[kind]); if (value === undefined) return []; const fileId = value.file_id; if (typeof fileId !== 'string') return []; const number = (key: string): number | undefined => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : undefined; const string = (key: string, limit: number): string | undefined => typeof value[key] === 'string' ? bounded(value[key] as string, limit) : undefined; const attachment: TelegramAttachment = { kind, fileId, ...(string('file_name', 128) === undefined ? {} : { name: string('file_name', 128) }), ...(string('title', 128) === undefined ? {} : { title: string('title', 128) }), ...(string('mime_type', 128) === undefined ? {} : { mime: string('mime_type', 128) }), ...(number('file_size') === undefined ? {} : { size: number('file_size') }), ...(number('width') === undefined ? {} : { width: number('width') }), ...(number('height') === undefined ? {} : { height: number('height') }), ...(number('duration') === undefined ? {} : { duration: number('duration') }), ...(string('emoji', 64) === undefined ? {} : { stickerEmoji: string('emoji', 64) }), ...(string('set_name', 128) === undefined ? {} : { stickerSetName: string('set_name', 128) }), ...(string('type', 32) === undefined ? { } : { stickerType: string('type', 32) }) }; if (kind === 'photo') { try { const file = await this.#track(() => this.bot.api.getFile(fileId)); if (typeof file.file_path === 'string') attachment.localImagePath = await this.#download(file.file_path, `photo-${fileId}`) } catch { /* metadata remains usable through a signed attachment handle */ } } return [attachment] }
  async #download(filePath: string, stem: string): Promise<string> { if (this.inbox === undefined || (this.apiRoot === undefined && this.downloadUrl === undefined) || !/^[A-Za-z0-9_./-]{1,512}$/u.test(filePath) || filePath.startsWith('/') || filePath.split('/').includes('..')) throw new Error('attachment download is not configured'); let response: Response; try { response = await this.#track(() => fetch(this.downloadUrl?.(filePath) ?? `${this.apiRoot}/file/${encodeURI(filePath)}`, { signal: AbortSignal.timeout(15_000) })) } catch { throw new Error('attachment download was rejected') }; if (!response.ok) throw new Error('attachment download was rejected'); const bytes = new Uint8Array(await this.#track(() => response.arrayBuffer())); if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('attachment download exceeds 20 MiB'); mkdirSync(this.inbox, { recursive: true, mode: 0o700 }); const safe = stem.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 96); const target = resolve(this.inbox, `${safe}-${Date.now()}${safeExtension(filePath)}`); if (!target.startsWith(`${resolve(this.inbox)}${sep}`)) throw new Error('attachment path escapes inbox'); const temporary = `${target}.tmp`; writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); renameSync(temporary, target); return target }
}
export function parseTelegramTextConfig(env: Record<string, string | undefined>): TelegramTextConfig {
  const ids = (key: string): ReadonlySet<string> => { const value = env[key]; if (value === undefined || value.trim() === '') throw new Error(`${key} is required`); const result = new Set(value.split(',').map(item => item.trim()).filter(Boolean)); if (result.size === 0) throw new Error(`${key} is empty`); return result }
  const mention = env.TELEGRAM_REQUIRE_MENTION
  if (mention !== undefined && mention !== 'true' && mention !== 'false') throw new Error('TELEGRAM_REQUIRE_MENTION is invalid')
  return { allowedChats: ids('TELEGRAM_ALLOWED_CHAT_IDS'), allowedSenders: ids('TELEGRAM_ALLOWED_SENDER_IDS'), requireMention: mention !== 'false' }
}
export function isTransientPollFailure(error: unknown): boolean { return /502|bad gateway|fetch failed/i.test(error instanceof Error ? error.message : String(error)) }
export function chunkTelegramText(text: string, limit = MAX_TELEGRAM_TEXT_CHARACTERS, mode: 'length' | 'newline' = 'length'): string[] { const points = Array.from(text); const chunks: string[] = []; while (points.length) { let end = Math.min(limit, points.length); if (mode === 'newline' && end < points.length) { const window = points.slice(0, end).join(''); const paragraph = window.lastIndexOf('\n\n'); const line = window.lastIndexOf('\n'); const space = window.lastIndexOf(' '); const boundary = paragraph > 0 ? paragraph + 2 : line > 0 ? line + 1 : space > 0 ? space + 1 : 0; if (boundary > 0) end = Array.from(window.slice(0, boundary)).length } chunks.push(points.splice(0, Math.max(1, end)).join('')) } return chunks }
function isPolicySource(value: TelegramTextConfig | TelegramPolicySource): value is TelegramPolicySource { return 'read' in value }
function allowedOutbound(policy: TelegramPolicy | undefined, route: { chatId: string; messageId?: number; messageThreadId?: number }, grants: ReadonlyMap<string, { senderId: string; expiresAt: number; origin: string }>): boolean { if (policy === undefined) return true; const group = policy.groups.get(route.chatId); if (!route.chatId.startsWith('-')) return group === undefined ? policy.permissions.operatorDmChatIds.has(route.chatId) || (policy.dmPolicy !== 'disabled' && policy.allowFrom.has(route.chatId)) : group.allowFrom.size > 0; const grant = route.messageId === undefined ? undefined : grants.get(grantKey(route as { chatId: string; messageId: number; messageThreadId?: number })); if (grant === undefined || grant.expiresAt < Math.floor(Date.now() / 1000)) return false; return group === undefined ? policy.allowAllGroups && policy.allowFrom.has(grant.senderId) : group.allowFrom.has(grant.senderId) }
function allowedInbound(policy: TelegramPolicy, chatId: string, senderId: string, chatType: string, text: string, username: string, botId: string, rawEntities: unknown, reply: unknown, senderChat: unknown): boolean {
  if (chatType === 'private') return policy.dmPolicy !== 'disabled' && policy.allowFrom.has(senderId)
  const group = policy.groups.get(chatId); if (group === undefined) return isUnlistedFallback(policy, chatId, senderId, chatType, text, username, botId, rawEntities, reply, senderChat)
  if (!group.allowFrom.has(senderId)) return false
  if (!group.requireMention) return true
  const mentions = new RegExp(`(^|\\s)@${escape(username)}(?:\\s|$)`, 'iu').test(text) || policy.mentionPatterns.some(pattern => text.includes(pattern))
  const entityMention = Array.isArray(rawEntities) && rawEntities.some(value => { const entity = asRecord(value); if (entity?.type === 'mention' && typeof entity.offset === 'number' && typeof entity.length === 'number') return text.slice(entity.offset, entity.offset + entity.length).toLocaleLowerCase() === `@${username}`.toLocaleLowerCase(); return entity?.type === 'text_mention' && String(asRecord(entity.user)?.id ?? '') === botId })
  const replyToBot = String(asRecord(asRecord(reply)?.from)?.id ?? '') === botId
  return mentions || entityMention || replyToBot
}
function isUnlistedFallback(policy: TelegramPolicy, chatId: string, senderId: string, chatType: string, text: string, username: string, botId: string, rawEntities: unknown, reply: unknown, senderChat: unknown): boolean { return policy.groups.get(chatId) === undefined && policy.allowAllGroups && /^[1-9]\d{0,19}$/u.test(senderId) && policy.allowFrom.has(senderId) && chatId.startsWith('-') && (chatType === 'group' || chatType === 'supergroup') && senderChat === undefined && genuineBotMention(text, username, botId, rawEntities, reply) }
function genuineBotMention(text: string, username: string, botId: string, rawEntities: unknown, reply: unknown): boolean { const entityMention = Array.isArray(rawEntities) && rawEntities.some(value => { const entity = asRecord(value); if (entity?.type === 'mention' && typeof entity.offset === 'number' && typeof entity.length === 'number') return text.slice(entity.offset, entity.offset + entity.length).toLocaleLowerCase() === `@${username}`.toLocaleLowerCase(); return entity?.type === 'text_mention' && String(asRecord(entity.user)?.id ?? '') === botId }); const replyToBot = String(asRecord(asRecord(reply)?.from)?.id ?? '') === botId; return entityMention || replyToBot }
function grantKey(route: { chatId: string; messageId: number; messageThreadId?: number }): string { return `${route.chatId}:${route.messageId}:${route.messageThreadId ?? '-'}` }
function entities(value: unknown): TelegramEntity[] { return Array.isArray(value) ? value.flatMap(item => { const entity = asRecord(item); if (entity === undefined || typeof entity.type !== 'string' || typeof entity.offset !== 'number' || typeof entity.length !== 'number' || !Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length) || entity.offset < 0 || entity.length < 0) return []; const mention = asRecord(entity.user); const textMention = entity.type === 'text_mention' && mention !== undefined && typeof mention.id === 'number' ? { userId: String(mention.id), ...(typeof mention.username === 'string' ? { username: bounded(mention.username, 64) } : {}), ...(display(mention) === 'unknown' ? {} : { display: display(mention) }) } : undefined; return [{ type: bounded(entity.type, 64), offset: entity.offset, length: entity.length, ...(typeof entity.url === 'string' ? { url: bounded(entity.url, 2048) } : {}), ...(typeof entity.language === 'string' ? { language: bounded(entity.language, 64) } : {}), ...(typeof entity.custom_emoji_id === 'string' ? { customEmojiId: bounded(entity.custom_emoji_id, 128) } : {}), ...(textMention === undefined ? {} : { textMention }) }] }).slice(0, 64) : [] }
function display(value: Record<string, unknown>): string { return bounded([value.first_name, value.last_name].filter(item => typeof item === 'string').join(' ').trim() || (typeof value.username === 'string' ? `@${value.username}` : 'unknown'), 256) }
function bounded(value: string, limit: number): string { return Array.from(value).slice(0, limit).join('') }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
function photo(path: string): boolean { return ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(path).toLowerCase()) }
function safeExtension(filePath: string): string { const extension = extname(filePath).toLowerCase(); return /^\.[a-z0-9]{1,16}$/u.test(extension) ? extension : '.bin' }
function mediaKind(message: Record<string, unknown>): TelegramAttachment['kind'] | undefined { return ['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker'].find(kind => message[kind] !== undefined) as TelegramAttachment['kind'] | undefined }
function largestPhoto(value: unknown): Record<string, unknown> | undefined { return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined).sort((a, b) => Number(b.width ?? 0) * Number(b.height ?? 0) - Number(a.width ?? 0) * Number(a.height ?? 0) || Number(b.file_size ?? 0) - Number(a.file_size ?? 0))[0] : undefined }
