import { afterEach, describe, expect, test } from 'bun:test'
import { controllerTelegramModelInput } from './app-server-controller/telegram-channel'
import { AppServerController } from './app-server-controller/controller'
import { AppServerAdmissionUncertainError } from './app-server-controller/protocol'
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chunkTelegramText, parseTelegramTextConfig, TelegramTextAdapter as ProductionTelegramTextAdapter, type TelegramTextRoute } from './telegram-text-adapter'

const activeAdapters = new Set<ProductionTelegramTextAdapter>()

// Fake Telegram calls must be finite and yield even when production retries.
// A Bun test timeout does not cancel an already-running polling Promise.
class TelegramTextAdapter extends ProductionTelegramTextAdapter {
  #fixtureFailure: Error | undefined

  constructor(...args: ConstructorParameters<typeof ProductionTelegramTextAdapter>) {
    const [bot, config, receive, sleep, ...rest] = args
    let calls = 0
    const guard = <A extends unknown[], R>(operation: (...params: A) => R) => async (...params: A) => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (++calls > 32) {
        this.#fixtureFailure = new Error('poll fixture exceeded 32 API calls without stopping')
        this.close()
        throw this.#fixtureFailure
      }
      return await operation.apply(bot.api, params)
    }
    const api = { ...bot.api,
      ...(typeof bot.api.getMe === 'function' ? { getMe: guard(bot.api.getMe) } : {}),
      ...(typeof bot.api.getUpdates === 'function' ? { getUpdates: guard(bot.api.getUpdates) } : {}),
    }
    super({ ...bot, api } as unknown as typeof bot, config, receive, async milliseconds => { await sleep?.(milliseconds); await new Promise<void>(resolve => setTimeout(resolve, 0)) }, ...rest)
    activeAdapters.add(this)
  }

  override async poll(): Promise<void> {
    try {
      await super.poll()
      if (this.#fixtureFailure !== undefined) throw this.#fixtureFailure
    } finally {
      this.close()
      activeAdapters.delete(this)
    }
  }
}

afterEach(() => { for (const adapter of activeAdapters) adapter.close(); activeAdapters.clear() })

describe('minimal Telegram text adapter', () => {
  test('keeps only the allowlist and mention input gate', () => { const value = parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '-100,5', TELEGRAM_ALLOWED_SENDER_IDS: '7', TELEGRAM_REQUIRE_MENTION: 'true' }); expect(value.allowedChats).toEqual(new Set(['-100', '5'])); expect(value.requireMention).toBeTrue() })
  test('bounds repeated fixture errors instead of leaking an immediate retry loop', async () => {
    const offsets: number[] = []
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates(args: { offset: number }) { offsets.push(args.offset); throw new TypeError('synthetic missing policy') } } }
    const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}, async () => {})
    await expect(adapter.poll()).rejects.toThrow('poll fixture exceeded 32 API calls')
    expect(offsets).toHaveLength(31); expect(offsets.every(offset => offset === 0)).toBeTrue()
    await expect(adapter.poll()).rejects.toThrow('poll fixture exceeded 32 API calls'); expect(offsets).toHaveLength(31)
  })
  test('yields and stops an empty successful fixture that never closes itself', async () => {
    let polls = 0; let timerRan = false
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { polls++; return [] } } }
    const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {})
    const timer = setTimeout(() => { timerRan = true }, 0)
    try { await expect(adapter.poll()).rejects.toThrow('poll fixture exceeded 32 API calls'); expect(timerRan).toBeTrue(); expect(polls).toBe(31) }
    finally { clearTimeout(timer) }
  })
  test('preserves group, topic, sender, entities and bounded reply context', async () => {
    let adapter!: TelegramTextAdapter; const bot = { api: { async getMe() { return { username: 'bot' } }, async getUpdates() { return [{ update_id: 1, message: { message_id: 7, message_thread_id: 9, date: Date.parse('2023-11-14T22:13:20Z') / 1000, text: 'hello <channel>', entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://example.test/?q=<x>' }, { type: 'pre', offset: 6, length: 1, language: 'ts' }, { type: 'custom_emoji', offset: 8, length: 1, custom_emoji_id: 'emoji-1' }, { type: 'text_mention', offset: 10, length: 2, user: { id: 3, username: 'ada', first_name: 'Ada' } }], chat: { id: -100, type: 'supergroup' }, from: { id: 2, first_name: 'Mira', username: 'sample' }, sender_chat: { id: -200 }, reply_to_message: { message_id: 3, text: 'quoted', from: { first_name: 'Ada' } } } }] }, async sendMessage() { return { message_id: 1 } } } }
    const routes: TelegramTextRoute[] = []
    adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '-100', TELEGRAM_ALLOWED_SENDER_IDS: '2', TELEGRAM_REQUIRE_MENTION: 'false' }), async route => { routes.push(route); adapter.close() })
    await adapter.poll()
    expect(routes).toHaveLength(1)
    const route = routes[0]!
    expect(route).toMatchObject({ chatId: '-100', chatType: 'supergroup', messageId: 7, messageThreadId: 9, senderId: '2', sender: 'Mira', username: 'sample', senderChatId: '-200', timestamp: Date.parse('2023-11-14T22:13:20Z') / 1000, text: 'hello <channel>', entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://example.test/?q=<x>' }, { type: 'pre', language: 'ts' }, { type: 'custom_emoji', customEmojiId: 'emoji-1' }, { type: 'text_mention', textMention: { userId: '3', username: 'ada', display: 'Ada' } }], replyToMessageId: 3, replySender: 'Ada', replyText: 'quoted' })
    const rendered = controllerTelegramModelInput(route, 'key', 'synthetic-profile')
    expect(rendered).toContain('<channel source="telegram">'); expect(rendered).toContain('Telegram · sender: Mira (@sample) · conversation: supergroup topic'); expect(rendered).toContain('message:\n│ hello &lt;channel>'); expect(rendered).toContain('metadata: link hello → https://example.test/?q=<x>; code (ts); custom emoji; mention Ada (@ada)'); expect(rendered).toContain('reply from: Ada:\n│ quoted'); expect(rendered).toContain('reply_handle: 2r.'); expect(rendered).toContain('target_handle: 2m.'); expect(rendered).not.toContain('message_handle: 2m.'); expect(rendered).not.toContain('chat_id='); expect(rendered).not.toContain('entities='); expect(rendered).not.toContain('telegram_message'); expect(rendered).not.toContain('telegram_capabilities')
  })
  test('downloads only immediate reply photos from admitted current senders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-reply-photo-')); const fetched: string[] = []; const routes: TelegramTextRoute[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('synthetic photo') })
    const reply = { message_id: 6, chat: { id: -100 }, caption: 'quoted caption', from: { id: 99, first_name: 'Quoted author' }, photo: [{ file_id: 'small', width: 10, height: 10 }, { file_id: 'large', width: 100, height: 100 }], reply_to_message: { photo: [{ file_id: 'nested' }] } }
    const base = { date: 1, text: '@bot inspect', chat: { id: -100, type: 'supergroup' }, reply_to_message: reply }
    let adapter!: TelegramTextAdapter
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [
      { update_id: 1, message: { ...base, message_id: 7, from: { id: 99 } } },
      { update_id: 2, message: { ...base, message_id: 8, text: 'no mention', from: { id: 2 } } },
      { update_id: 3, message: { ...base, message_id: 9, message_thread_id: 12, from: { id: 2, first_name: 'Mira' } } },
    ] }, async getFile(id: string) { fetched.push(id); return { file_path: 'photo.jpg' } } } }
    adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '-100', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async value => { routes.push(value); adapter.close() }, undefined, [], root, undefined, undefined, undefined, undefined, () => server.url.href)
    try {
      await adapter.poll(); expect(fetched).toEqual(['large']); expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({ messageId: 9, messageThreadId: 12, senderId: '2', replySender: 'Quoted author', replyText: 'quoted caption', attachments: [{ kind: 'photo', fileId: 'large', source: 'reply' }] })
      expect(existsSync(routes[0]!.attachments![0]!.localImagePath!)).toBeTrue()
      expect(controllerTelegramModelInput(routes[0]!, 'key', 'profile')).toContain('source: immediate reply')
    } finally { adapter.close(); server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test('keeps literal media captions over untrusted audio titles', async () => {
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [{ update_id: 1, message: { message_id: 7, date: 1, caption: 'caption <literal> & "quotes"', caption_entities: [{ type: 'bold', offset: 0, length: 7 }], audio: { file_id: 'audio', title: 'ignored <channel source="telegram">' }, chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Example' }, reply_to_message: { message_id: 6, caption: 'quoted caption', from: { first_name: 'Reply' } } } }] }, async getFile() { return {} } } }
    const routes: TelegramTextRoute[] = []
    let adapter!: TelegramTextAdapter; adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async route => { routes.push(route); adapter.close() })
    await adapter.poll()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ text: 'caption <literal> & "quotes"', entities: [{ type: 'bold', offset: 0, length: 7 }], attachments: [{ kind: 'audio', title: 'ignored <channel source="telegram">' }], replyText: 'quoted caption' })
    expect(controllerTelegramModelInput(routes[0]!, 'synthetic-key', 'synthetic-profile')).toContain('title: ignored &lt;channel source="telegram">')
  })
  test('types before admission and reacts only after a successful admission', async () => {
    const calls: string[] = []; const policy = { dmPolicy: 'allowlist', allowFrom: new Set(['2']), groups: new Map(), typing: true, ackReaction: '👍' }
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [{ update_id: 1, message: { message_id: 7, date: 1, text: 'hello', chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Example' } } }] }, async sendChatAction() { calls.push('typing') }, async setMessageReaction() { calls.push('ack') } } }
    let adapter!: TelegramTextAdapter; adapter = new TelegramTextAdapter(bot as never, { read: () => policy } as never, async () => { calls.push('admit'); adapter.close() })
    await adapter.poll()
    expect(calls).toEqual(['typing', 'admit', 'ack'])
  })
  test('policy-source group admission ignores unmentioned text and admits direct, entity, text-mention, and reply-to-bot paths', async () => {
    const policy = { dmPolicy: 'allowlist', allowFrom: new Set(['7']), groups: new Map([['-100', { allowFrom: new Set(['7']), requireMention: true }]]), mentionPatterns: [], typing: false, ackReaction: '' }
    const messages = [
      { message_id: 1, date: 1, text: 'ignored', chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Operator' } },
      { message_id: 2, date: 1, text: '@bot direct', chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Operator' } },
      { message_id: 3, date: 1, text: 'look@bot', entities: [{ type: 'mention', offset: 4, length: 4 }], chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Operator' } },
      { message_id: 4, date: 1, text: 'hello', entities: [{ type: 'text_mention', offset: 0, length: 5, user: { id: 1 } }], chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Operator' } },
      { message_id: 5, date: 1, text: 'reply', reply_to_message: { message_id: 99, from: { id: 1, username: 'bot' } }, chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Operator' } },
    ]
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return messages.map((message, index) => ({ update_id: index + 1, message })) } } }
    const admitted: number[] = []; let adapter!: TelegramTextAdapter
    adapter = new TelegramTextAdapter(bot as never, { read: () => policy } as never, async route => { admitted.push(route.messageId); if (admitted.length === 4) adapter.close() })
    await adapter.poll()
    expect(admitted).toEqual([2, 3, 4, 5])
  })
  test('admits only a mentioned global allowlist user in an unlisted group and revokes its ephemeral egress grant', async () => {
    const policy = { dmPolicy: 'allowlist', allowFrom: new Set(['7']), groups: new Map([['-101', { allowFrom: new Set<string>(), requireMention: false }]]), allowAllGroups: true, mentionPatterns: [], typing: false, ackReaction: '', permissions: { operatorDmChatIds: new Set<string>() }, textChunkLimit: 4096, chunkMode: 'length', replyToMode: 'first' }
    const messages = [
      { message_id: 1, date: 1, text: '@bot yes', entities: [{ type: 'mention', offset: 0, length: 4 }], chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } },
      { message_id: 2, date: 1, text: '@bot no', entities: [{ type: 'mention', offset: 0, length: 4 }], chat: { id: -102, type: 'supergroup' }, from: { id: 8, first_name: 'Other' } },
      { message_id: 3, date: 1, text: 'no mention', chat: { id: -103, type: 'group' }, from: { id: 7, first_name: 'Mira' } },
      { message_id: 4, date: 1, text: '@bot channel', entities: [{ type: 'mention', offset: 0, length: 4 }], chat: { id: -104, type: 'channel' }, from: { id: 7, first_name: 'Mira' } },
      { message_id: 5, date: 1, text: '@bot anonymous', entities: [{ type: 'mention', offset: 0, length: 4 }], sender_chat: { id: -9 }, chat: { id: -105, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } },
      { message_id: 6, date: 1, text: '@bot denied', entities: [{ type: 'mention', offset: 0, length: 4 }], chat: { id: -101, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } },
      { message_id: 7, date: 1, text: '@bot raw', chat: { id: -106, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } },
      { message_id: 8, date: 1, text: 'spoofed reply', reply_to_message: { message_id: 1, from: { username: 'bot' } }, chat: { id: -107, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } },
      { message_id: 9, date: 1, text: 'genuine reply', reply_to_message: { message_id: 1, from: { id: 1, username: 'bot' } }, chat: { id: -108, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } },
    ]
    let polls = 0; const calls: string[] = []; let adapter!: TelegramTextAdapter; const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { polls++; if (polls === 1) return messages.map((message, index) => ({ update_id: index + 1, message })); adapter.close(); return [] }, async sendMessage() { calls.push('reply'); return { message_id: 9 } }, async editMessageText() { calls.push('edit') }, async setMessageReaction() { calls.push('react') } } }
    const admitted: number[] = []; adapter = new TelegramTextAdapter(bot as never, { read: () => policy } as never, async route => { admitted.push(route.messageId); if (route.messageId !== 1) return; await adapter.reply(route, { text: 'ok' }); await adapter.edit({ chatId: '-100', messageId: 9 }, 'edited'); await adapter.react({ chatId: '-100', messageId: 1 }, '👍'); policy.groups.set('-100', { allowFrom: new Set(['8']), requireMention: false }); await expect(adapter.react({ chatId: '-100', messageId: 1 }, '👍')).rejects.toThrow('no longer allowed'); policy.groups.set('-100', { allowFrom: new Set(['7']), requireMention: false }); const originalNow = Date.now; try { Date.now = () => originalNow() + 2 * 3600 * 1000; await expect(adapter.react({ chatId: '-100', messageId: 1 }, '👍')).rejects.toThrow('no longer allowed') } finally { Date.now = originalNow }; policy.groups.clear(); policy.allowFrom.clear(); await expect(adapter.react({ chatId: '-100', messageId: 1 }, '👍')).rejects.toThrow('no longer allowed'); policy.allowFrom.add('7'); policy.allowAllGroups = false; await expect(adapter.reply({ chatId: '-100', messageId: 1 }, { text: 'no' })).rejects.toThrow('no longer allowed'); await expect(adapter.edit({ chatId: '-100', messageId: 9 }, 'no')).rejects.toThrow('no longer allowed'); await expect(adapter.react({ chatId: '-100', messageId: 1 }, '👍')).rejects.toThrow('no longer allowed'); policy.groups.set('-101', { allowFrom: new Set<string>(), requireMention: false }); policy.allowAllGroups = true })
    await adapter.poll(); expect(admitted).toEqual([1, 9]); expect(calls).toEqual(['reply', 'edit', 'react'])
  })
  test('removes an unlisted-group grant on failed admission and rechecks before each outbound chunk', async () => {
    const policy = { dmPolicy: 'allowlist', allowFrom: new Set(['7']), groups: new Map(), allowAllGroups: true, mentionPatterns: [], typing: false, ackReaction: '', permissions: { operatorDmChatIds: new Set<string>() }, textChunkLimit: 2, chunkMode: 'length', replyToMode: 'first' }
    const message = { message_id: 1, date: 1, text: '@bot', entities: [{ type: 'mention', offset: 0, length: 4 }], chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } }
    let adapter!: TelegramTextAdapter; const failedBot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [{ update_id: 1, message }] }, async sendMessage() { return { message_id: 9 } }, async editMessageText() {}, async setMessageReaction() {} } }
    adapter = new TelegramTextAdapter(failedBot as never, { read: () => policy } as never, async route => { try { await adapter.reply(route, { text: 'already sent' }); throw new Error('admission failed') } catch (error) { expect(adapter.allowsRoute({ chatId: '-100', messageId: 1 })).toBeFalse(); await expect(adapter.reply({ chatId: '-100', messageId: 1 }, { text: 'no' })).rejects.toThrow('no longer allowed'); await expect(adapter.edit({ chatId: '-100', messageId: 9 }, 'no')).rejects.toThrow('no longer allowed'); await expect(adapter.react({ chatId: '-100', messageId: 9 }, '👍')).rejects.toThrow('no longer allowed'); throw error } finally { adapter.close() } }, async () => {})
    await adapter.poll(); expect(() => adapter.reply({ chatId: '-100', messageId: 1 }, { text: 'closed' })).toThrow('Telegram adapter is closed')
    const sent: string[] = []; let chunkAdapter!: TelegramTextAdapter; const chunkBot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [{ update_id: 1, message }] }, async sendMessage() { sent.push('send'); policy.allowAllGroups = false; return { message_id: sent.length } } } }
    let chunkError: unknown
    chunkAdapter = new TelegramTextAdapter(chunkBot as never, { read: () => policy } as never, async route => { try { await chunkAdapter.reply(route, { text: '1234' }) } catch (error) { chunkError = error } finally { chunkAdapter.close() } })
    policy.allowAllGroups = true; await chunkAdapter.poll(); expect(sent).toEqual(['send'])
    expect(chunkError).toBeInstanceOf(Error); expect((chunkError as Error).message).toContain('no longer allowed')
  })
  test('does not retry a fallback admission when the post-admission ACK policy read fails', async () => {
    const policy = { dmPolicy: 'allowlist', allowFrom: new Set(['7']), groups: new Map(), allowAllGroups: true, mentionPatterns: [], typing: false, ackReaction: '👍', permissions: { operatorDmChatIds: new Set<string>() }, textChunkLimit: 4096, chunkMode: 'length', replyToMode: 'first' }; let reads = 0; let adapter!: TelegramTextAdapter
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { if (reads > 3) { adapter.close(); return [] } return [{ update_id: 1, message: { message_id: 1, date: 1, text: '@bot', entities: [{ type: 'mention', offset: 0, length: 4 }], chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } } }] } } }
    let admitted = 0; adapter = new TelegramTextAdapter(bot as never, { read: () => { reads++; if (reads >= 3) throw new Error('policy replaced'); return policy } } as never, async () => { admitted++; adapter.close() }, async () => {})
    await adapter.poll(); expect(admitted).toBe(1)
  })
  test('evicts the oldest fallback grant after 256 admitted routes', async () => {
    const policy = { dmPolicy: 'allowlist', allowFrom: new Set(['7']), groups: new Map(), allowAllGroups: true, mentionPatterns: [], typing: false, ackReaction: '', permissions: { operatorDmChatIds: new Set<string>() }, textChunkLimit: 4096, chunkMode: 'length', replyToMode: 'first' }; const updates = Array.from({ length: 257 }, (_, index) => ({ update_id: index + 1, message: { message_id: index + 1, date: 1, text: '@bot', entities: [{ type: 'mention', offset: 0, length: 4 }], chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Mira' } } })); let polls = 0; let adapter!: TelegramTextAdapter; let sends = 0
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { polls++; if (polls === 1) return updates; adapter.close(); return [] }, async sendMessage() { sends++; return { message_id: 999 } } } }
    adapter = new TelegramTextAdapter(bot as never, { read: () => policy } as never, async route => { if (route.messageId === 257) { await expect(adapter.reply({ chatId: '-100', messageId: 1 }, { text: 'old' })).rejects.toThrow('no longer allowed'); await adapter.reply({ chatId: '-100', messageId: 257 }, { text: 'latest' }) } })
    await adapter.poll(); expect(sends).toBe(1)
  })
  test('typing and ACK API failures do not alter successful admission, and failed admission receives no ACK', async () => {
    const policy = { dmPolicy: 'allowlist', allowFrom: new Set(['2']), groups: new Map(), typing: true, ackReaction: '👍' }
    const message = { message_id: 7, date: 1, text: 'hello', chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Example' } }
    let admitted = 0; const resilientBot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [{ update_id: 1, message }] }, async sendChatAction() { throw new Error('typing unavailable') }, async setMessageReaction() { throw new Error('ack unavailable') } } }
    let adapter!: TelegramTextAdapter; adapter = new TelegramTextAdapter(resilientBot as never, { read: () => policy } as never, async () => { admitted++; adapter.close() })
    await adapter.poll(); expect(admitted).toBe(1)
    let acknowledgements = 0; const rejectedBot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [{ update_id: 1, message }] }, async sendChatAction() {}, async setMessageReaction() { acknowledgements++ } } }
    const rejected = new TelegramTextAdapter(rejectedBot as never, { read: () => policy } as never, async () => { throw new AppServerAdmissionUncertainError('stock admission uncertain') })
    await rejected.poll(); expect(acknowledgements).toBe(0)
  })
  test('preserves bounded metadata for voice, audio, video, video note, and sticker input', async () => {
    const media: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['voice', { file_id: 'voice-file', duration: 3, mime_type: 'audio/ogg', file_size: 7 }, { kind: 'voice', fileId: 'voice-file', duration: 3, mime: 'audio/ogg', size: 7 }],
      ['audio', { file_id: 'audio-file', duration: 4, mime_type: 'audio/mpeg', file_size: 8, file_name: 'song.mp3', title: 'Ночной <трек>' }, { kind: 'audio', fileId: 'audio-file', duration: 4, mime: 'audio/mpeg', size: 8, name: 'song.mp3', title: 'Ночной <трек>' }],
      ['video', { file_id: 'video-file', duration: 5, width: 640, height: 480, file_size: 9 }, { kind: 'video', fileId: 'video-file', duration: 5, width: 640, height: 480, size: 9 }],
      ['video_note', { file_id: 'note-file', duration: 6, file_size: 10 }, { kind: 'video_note', fileId: 'note-file', duration: 6, size: 10 }],
      ['sticker', { file_id: 'sticker-file', width: 64, height: 64, file_size: 11, emoji: '👍', set_name: 'set', type: 'regular' }, { kind: 'sticker', fileId: 'sticker-file', width: 64, height: 64, size: 11, stickerEmoji: '👍', stickerSetName: 'set', stickerType: 'regular' }],
    ]
    const updates = media.map(([kind, value], index) => ({ update_id: index + 1, message: { message_id: index + 1, date: 1, [kind]: value, chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Example' } } }))
    const routes: Array<{ text: string, attachments?: unknown[] }> = []; const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return updates }, async getFile() { return {} } } }
    let adapter!: TelegramTextAdapter; adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async route => { routes.push(route); if (routes.length === media.length) adapter.close() })
    await adapter.poll()
    expect(routes.map(route => route.text)).toEqual(['[voice]', '[audio: Ночной <трек>]', '[video]', '[video_note]', '[sticker]'])
    expect(routes.map(route => route.attachments?.[0])).toEqual(media.map(([, , expected]) => expected))
    expect(controllerTelegramModelInput(routes[1] as never, 'synthetic-key', 'synthetic-profile')).toContain('attachment: audio · name: song.mp3 · title: Ночной <трек> · mime: audio/mpeg')
  })
  test('chunks plain text but fails closed for formatted text above Telegram limit', async () => { const calls: Array<Record<string, unknown>> = []; const bot = { api: { async sendMessage(_chat: string, _text: string, options: Record<string, unknown>) { calls.push(options); return { message_id: calls.length } } } }; const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}); expect(chunkTelegramText('x'.repeat(4097))).toHaveLength(2); await expect(adapter.reply({ chatId: '1', messageId: 7, messageThreadId: 9 }, { text: 'x'.repeat(4097), parse_mode: 'MarkdownV2' })).rejects.toThrow('one-message limit'); await adapter.reply({ chatId: '1', messageId: 7 }, { text: 'ok', parse_mode: 'MarkdownV2' }); expect(calls[0]).toMatchObject({ parse_mode: 'MarkdownV2', reply_parameters: { message_id: 7 } }) })
  test('uses newline chunks with topic ordering and exact off/all reply modes for text and files', async () => { const root = mkdtempSync(join(tmpdir(), 'telegram-order-')); const file = join(root, 'attachment.txt'); writeFileSync(file, 'x'); const calls: Array<{ kind: string; text?: string; options: Record<string, unknown> }> = []; const policy = { groups: new Map([['1', { allowFrom: new Set(['2']), requireMention: false }]]), permissions: { operatorDmChatIds: new Set<string>() }, allowFrom: new Set<string>(), dmPolicy: 'disabled', textChunkLimit: 6, chunkMode: 'newline', replyToMode: 'off' }; const bot = { api: { async sendMessage(_chat: string, text: string, options: Record<string, unknown>) { calls.push({ kind: 'text', text, options }); return { message_id: calls.length } }, async sendDocument(_chat: string, _file: unknown, options: Record<string, unknown>) { calls.push({ kind: 'file', options }); return { message_id: calls.length } } } }; const adapter = new TelegramTextAdapter(bot as never, { read: () => policy } as never, async () => {}, undefined, [realpathSync(root)]); try { await adapter.reply({ chatId: '1', messageId: 7, messageThreadId: 9 }, { text: 'aa\nbb\ncc', files: [file] }); expect(calls.map(call => call.text ?? call.kind)).toEqual(['aa\nbb\n', 'cc', 'file']); expect(calls.every(call => call.options.message_thread_id === 9 && call.options.reply_parameters === undefined)).toBeTrue(); policy.replyToMode = 'all'; calls.length = 0; await adapter.reply({ chatId: '1', messageId: 7, messageThreadId: 9 }, { text: 'aa\nbb\ncc', files: [file] }); expect(calls.every(call => call.options.message_thread_id === 9 && (call.options.reply_parameters as { message_id: number }).message_id === 7)).toBeTrue() } finally { rmSync(root, { recursive: true, force: true }) } })
  test('rechecks the live policy before reply, reaction, and edit delivery', async () => { const policy = { groups: new Map([['1', { allowFrom: new Set(['2']), requireMention: false }]]), permissions: { operatorDmChatIds: new Set<string>() }, allowFrom: new Set<string>(), dmPolicy: 'disabled' }; const calls: string[] = []; const bot = { api: { async sendMessage() { calls.push('reply'); return { message_id: 1 } }, async setMessageReaction() { calls.push('react') }, async editMessageText() { calls.push('edit') } } }; const adapter = new TelegramTextAdapter(bot as never, { read: () => policy } as never, async () => {}); await adapter.reply({ chatId: '1', messageId: 1 }, { text: 'ok' }); await adapter.react({ chatId: '1', messageId: 1 }, '👍'); await adapter.edit({ chatId: '1', messageId: 1 }, 'ok'); expect(calls).toEqual(['reply', 'react', 'edit']); policy.groups.clear(); await expect(adapter.reply({ chatId: '1', messageId: 1 }, { text: 'no' })).rejects.toThrow('no longer allowed'); await expect(adapter.react({ chatId: '1', messageId: 1 }, '👍')).rejects.toThrow('no longer allowed'); await expect(adapter.edit({ chatId: '1', messageId: 1 }, 'no')).rejects.toThrow('no longer allowed') })
  test('sends bounded photo and document files through their Telegram API methods', async () => { const root = mkdtempSync(join(tmpdir(), 'telegram-files-')); const photo = join(root, 'photo.png'); const document = join(root, 'document.txt'); writeFileSync(photo, 'x'); writeFileSync(document, 'x'); const calls: string[] = []; const bot = { api: { async sendPhoto() { calls.push('photo'); return { message_id: 1 } }, async sendDocument() { calls.push('document'); return { message_id: 2 } } } }; const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}, undefined, [realpathSync(root)]); try { await adapter.reply({ chatId: '1', messageId: 1 }, { files: [photo, document] }); expect(calls).toEqual(['photo', 'document']) } finally { rmSync(root, { recursive: true, force: true }) } })
  test('rejects outbound files outside roots, through symlinks, or above the size bound before delivery', async () => { const root = mkdtempSync(join(tmpdir(), 'telegram-media-')); const outside = mkdtempSync(join(tmpdir(), 'telegram-outside-')); const safe = join(root, 'safe.txt'); const external = join(outside, 'external.txt'); const link = join(root, 'link.txt'); const oversized = join(root, 'large.bin'); writeFileSync(safe, 'x'); writeFileSync(external, 'x'); symlinkSync(safe, link); writeFileSync(oversized, ''); truncateSync(oversized, 50 * 1024 * 1024 + 1); let sends = 0; const bot = { api: { async sendDocument() { sends++; return { message_id: sends } } } }; const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}, undefined, [realpathSync(root)]); try { for (const file of [external, link, oversized]) await expect(adapter.reply({ chatId: '1', messageId: 7 }, { files: [file] })).rejects.toThrow('bounded workspace/inbox'); expect(sends).toBe(0) } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) } })
  test('downloads an attachment only into the bounded inbox with a safe suffix fallback', async () => { const root = mkdtempSync(join(tmpdir(), 'telegram-inbox-')); const originalFetch = globalThis.fetch; const bot = { api: { async getFile() { return { file_path: 'documents/receipt' } } } }; globalThis.fetch = (async () => new Response('receipt')) as unknown as typeof fetch; const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}, undefined, [], root, 'https://api.telegram.org/bot-test'); try { const path = await adapter.downloadAttachment({ chatId: '1' }, 'file-1', 'document', 'receipt'); expect(path.startsWith(`${root}/`)).toBeTrue(); expect(path.endsWith('.bin')).toBeTrue(); expect(existsSync(path)).toBeTrue() } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }) } })
  test('keeps a provider photo extension so a downloaded attachment can be replied as a photo', async () => { const root = mkdtempSync(join(tmpdir(), 'telegram-photo-roundtrip-')); const originalFetch = globalThis.fetch; const calls: string[] = []; const bot = { api: { async getFile() { return { file_path: 'photos/provider-image.jpg' } }, async sendPhoto() { calls.push('photo'); return { message_id: 1 } }, async sendDocument() { calls.push('document'); return { message_id: 2 } } } }; globalThis.fetch = (async () => new Response('photo')) as unknown as typeof fetch; const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}, undefined, [realpathSync(root)], root, 'https://api.telegram.org/bot-test'); try { const path = await adapter.downloadAttachment({ chatId: '1' }, 'file-1', 'photo', 'provider-image'); await adapter.reply({ chatId: '1', messageId: 7 }, { files: [path] }); expect(calls).toEqual(['photo']) } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }) } })
  test('uses an injected direct download URL while retaining the existing API-root path by default', async () => { const root = mkdtempSync(join(tmpdir(), 'telegram-direct-download-')); const originalFetch = globalThis.fetch; const urls: string[] = []; const bot = { api: { async getFile() { return { file_path: 'documents/receipt.txt' } } } }; globalThis.fetch = (async (value: string) => { urls.push(value); return new Response('receipt') }) as unknown as typeof fetch; const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}, undefined, [], root, 'http://127.0.0.1:19999/legacy', undefined, undefined, undefined, filePath => `https://api.telegram.org/file/bot000000:synthetic/${encodeURI(filePath)}`); try { await adapter.downloadAttachment({ chatId: '1' }, 'file-1', 'document', 'receipt'); expect(urls).toEqual(['https://api.telegram.org/file/bot000000:synthetic/documents/receipt.txt']) } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }) } })
  test('preflights files and the 16-part limit before sending any text', async () => { let sends = 0; const bot = { api: { async sendMessage() { sends++; return { message_id: sends } } } }; const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}); await expect(adapter.reply({ chatId: '1', messageId: 7 }, { text: 'text', files: ['/definitely/not/allowed'] })).rejects.toThrow(); expect(sends).toBe(0); await expect(adapter.reply({ chatId: '1', messageId: 7 }, { text: 'x'.repeat(17 * 4096) })).rejects.toThrow('16-part'); expect(sends).toBe(0) })
  test('does not repoll or redeliver a photo while stock queue admission is pending', async () => {
    const seen: number[] = []; let release!: () => void; let firstStarted!: () => void; const first = new Promise<void>(resolve => { firstStarted = resolve })
    const message = (message_id: number, photo = false) => ({ message_id, date: Date.parse('2023-11-14T22:13:20Z') / 1000, text: 'hello', ...(photo ? { photo: [{ file_id: 'photo-1' }] } : {}), chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Mira' } })
    let polls = 0; const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getFile() { return {} }, async getUpdates() { polls++; return polls === 1 ? [{ update_id: 1, message: message(7, true) }] : [{ update_id: 2, message: message(8) }] } } }
    let adapter!: TelegramTextAdapter; adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async route => { seen.push(route.messageId); if (route.messageId === 7) { firstStarted(); await new Promise<void>(resolve => { release = resolve }) } else adapter.close() })
    const polling = adapter.poll()
    try {
      await Promise.race([first, polling.then(() => { throw new Error('poll stopped before admission started') })])
      expect(polls).toBe(1); expect(seen).toEqual([7]); release(); await polling
      expect(polls).toBe(2); expect(seen).toEqual([7, 8])
    } finally { adapter.close(); release?.(); await polling.catch(() => {}) }
  })
  test('retries the same provider offset after a failed admission, then advances once', async () => {
    const offsets: number[] = []; const seen: number[] = []; const message = (message_id: number) => ({ message_id, date: Date.parse('2023-11-14T22:13:20Z') / 1000, text: 'hello', chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Mira' } })
    let polls = 0; const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates(args: { offset: number }) { offsets.push(args.offset); polls++; return polls < 3 ? [{ update_id: 1, message: message(7) }] : [{ update_id: 2, message: message(8) }] } } }
    let attempts = 0; let adapter!: TelegramTextAdapter; adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async route => { seen.push(route.messageId); if (route.messageId === 7 && attempts++ === 0) throw new Error('stock queue write failed'); if (route.messageId === 8) adapter.close() }, async () => {})
    await adapter.poll()
    expect(offsets).toEqual([0, 0, 2]); expect(seen).toEqual([7, 7, 8])
  })
  test('aborts a hung poll, reports Telegram unhealthy, and retries without advancing the offset', async () => {
    const offsets: number[] = []; const health: boolean[] = []; let aborted = false; let polls = 0
    const message = { message_id: 7, date: Date.parse('2023-11-14T22:13:20Z') / 1000, text: 'hello', chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Mira' } }
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, getUpdates(args: { offset: number }, signal?: AbortSignal) { offsets.push(args.offset); polls++; if (polls === 1) return new Promise<never>((_resolve, reject) => { signal?.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic abort')) }) }); return Promise.resolve([{ update_id: 1, message }]) } } }
    let adapter!: TelegramTextAdapter; adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => { adapter.close() }, async () => {}, [], undefined, undefined, undefined, ok => { health.push(ok) }, 25)
    await adapter.poll()
    expect(aborted).toBeTrue(); expect(offsets).toEqual([0, 0]); expect(health).toEqual([false, true])
  })
  test('keeps retrying transient startup failures past five attempts and recovers on a later poll', async () => {
    const health: boolean[] = []; const waits: number[] = []; let identities = 0; let polls = 0
    let adapter!: TelegramTextAdapter
    const bot = { api: { async getMe() { identities++; if (identities <= 6) throw new Error('502 bad gateway'); return { id: 1, username: 'bot' } }, async getUpdates() { polls++; return [] } } }
    adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}, async milliseconds => { waits.push(milliseconds) }, [], undefined, undefined, undefined, ok => { health.push(ok); if (ok) adapter.close() })
    await adapter.poll()
    expect(identities).toBe(7); expect(polls).toBe(1); expect(waits).toHaveLength(6); expect(waits.every(wait => wait >= 1_000 && wait <= 15_000)).toBeTrue(); expect(health).toEqual([false, false, false, false, false, false, true])
  })
  test('stops on the eighth consecutive 409 and resets that counter after a successful poll', async () => { const waits: number[] = []; let polls = 0; const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { polls++; if (polls <= 7 || polls >= 9) throw new Error('409 conflict'); return [] } } }; const adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async () => {}, async milliseconds => { waits.push(milliseconds) }); await adapter.poll(); expect(polls).toBe(16); expect(waits).toHaveLength(14); expect(waits.every(wait => wait === 1_000)).toBeTrue() })
  test('resumes polling after one stock-admitted message without redelivering it', async () => {
    const offsets: number[] = []; let resolveAdmission!: () => void; let starts = 0; let adapter!: TelegramTextAdapter
    let firstStarted!: () => void; const first = new Promise<void>(resolve => { firstStarted = resolve })
    const message = (id: number) => ({ message_id: id, date: 1, text: 'inbound', chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Example' } })
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates(args: { offset: number }) { offsets.push(args.offset); return offsets.length === 1 ? [{ update_id: 1, message: message(7) }] : [{ update_id: 2, message: message(8) }] } } }
    adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async route => { starts++; if (route.messageId === 7) { firstStarted(); await new Promise<void>(resolve => { resolveAdmission = resolve }) } else adapter.close() })
    const polling = adapter.poll()
    try {
      await Promise.race([first, polling.then(() => { throw new Error('poll stopped before admission started') })])
      expect(offsets).toEqual([0]); expect(starts).toBe(1)
      resolveAdmission(); await polling
      expect(offsets).toEqual([0, 2]); expect(starts).toBe(2)
    } finally { adapter.close(); resolveAdmission?.(); await polling.catch(() => {}) }
  })
  test('advances the provider offset exactly once after a matching stock item admits a delayed idle turn/start', async () => {
    const thread = '11111111-1111-1111-1111-111111111111'; const offsets: number[] = []; let turnStarts = 0; let queueAdds = 0
    let notification: ((method: string, params: Record<string, unknown>) => void) | undefined
    const rpc = {
      async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
        if (method === 'initialize') return {}
        if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: thread, cwd: '/workspace', status: { type: 'idle' } } }
        if (method === 'thread/queue/list') return { data: [] }
        if (method === 'thread/queue/add') { queueAdds++; return {} }
        if ((method === 'turn/start' || method === 'turn/steer') && params?.threadId === 'codex-telegram-invalid-thread-id') return {}
        if (method === 'turn/start') { turnStarts++; return await new Promise<never>(() => {}) }
        return {}
      },
      notify() {},
      onNotification(listener: (method: string, params: Record<string, unknown>) => void) { notification = listener; return () => { notification = undefined } },
      onClose() { return () => {} },
    }
    const controller = new AppServerController(rpc as never, 'test', '/workspace', false, 200); await controller.attach(rpc as never); await controller.awaitTuiThread(thread)
    const message = { message_id: 7, date: 1, text: 'inbound', chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Example' } }
    let adapter!: TelegramTextAdapter
    const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates(args: { offset: number }) { offsets.push(args.offset); if (offsets.length === 2) adapter.close(); return offsets.length === 1 ? [{ update_id: 1, message }] : [] } } }
    adapter = new TelegramTextAdapter(bot as never, parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }), async route => { await controller.admit({ id: route.id, route: thread, source: 'telegram', text: route.text, clientUserMessageId: route.id }, 'steer') })
    const polling = adapter.poll()
    try {
      for (let attempt = 0; attempt < 100 && turnStarts !== 1; attempt++) await Bun.sleep(1)
      expect(turnStarts).toBe(1)
      notification?.('turn/started', { threadId: thread }); notification?.('item/started', { threadId: thread, item: { type: 'userMessage', clientId: 'wrong-client' } }); notification?.('item/completed', { threadId: '22222222-2222-2222-2222-222222222222', item: { type: 'userMessage', client_id: 'telegram:1:7' } })
      await Bun.sleep(0); expect(offsets).toEqual([0])
      notification?.('item/started', { threadId: thread, item: { type: 'userMessage', client_user_message_id: 'telegram:1:7' } })
      await polling
      expect(offsets).toEqual([0, 2]); expect(turnStarts).toBe(1); expect(queueAdds).toBe(0)
    } finally {
      adapter.close()
      notification?.('item/started', { threadId: thread, item: { type: 'userMessage', client_user_message_id: 'telegram:1:7' } })
      await polling.catch(() => {}); controller.disconnect()
    }
  })
})
