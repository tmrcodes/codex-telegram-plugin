import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TelegramTextAdapter, parseTelegramTextConfig } from './telegram-text-adapter'

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function config() { return parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }) }
function route() { return { chatId: '1', messageId: 7 } }
function message(id = 1) { return { update_id: id, message: { message_id: id, date: 1, text: `message-${id}`, chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Example' } } } }
function policySource() { return { read: () => ({ dmPolicy: 'allowlist', allowFrom: new Set(['2']), groups: new Map(), allowAllGroups: false, mentionPatterns: [], ackReaction: '✅', typing: false, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'length', deliveryMode: 'auto', permissions: { enabled: false, operatorDmChatIds: new Set() }, pending: [], fingerprint: 'fixture' }) } as never }

test('closeAndDrain waits for an abort-ignoring timed-out getUpdates and never overlaps it', async () => {
  const updates = deferred<ReturnType<typeof message>[]>(); const started = deferred<void>(); let polls = 0; let aborted = false
  const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, getUpdates(_args: unknown, signal?: AbortSignal) { polls++; started.resolve(); signal?.addEventListener('abort', () => { aborted = true }); return updates.promise } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {}, async () => {}, [], undefined, undefined, undefined, undefined, 5)
  const polling = adapter.poll(); await started.promise; await Bun.sleep(15); expect(polls).toBe(1)
  let drained = false; const drain = adapter.closeAndDrain(); void drain.then(() => { drained = true }); expect(aborted).toBeTrue(); await Bun.sleep(0); expect(drained).toBeFalse()
  updates.resolve([]); await polling; await drain; expect(polls).toBe(1); expect(adapter.drain()).toBe(drain)
})

test('drain retains admitted receive and best-effort ACK until both settle', async () => {
  const receive = deferred<void>(); const received = deferred<void>(); const ack = deferred<void>(); const ackStarted = deferred<void>()
  const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [message()] }, setMessageReaction() { ackStarted.resolve(); return ack.promise } } }
  const adapter = new TelegramTextAdapter(bot as never, policySource(), async () => { received.resolve(); await receive.promise })
  const polling = adapter.poll(); await received.promise; let drained = false; const drain = adapter.closeAndDrain(); void drain.then(() => { drained = true }); receive.resolve(); await ackStarted.promise; await Bun.sleep(0); expect(drained).toBeFalse()
  ack.resolve(); await polling; await drain; expect(drained).toBeTrue()
})

test('drain waits for callback acknowledgement and records its rejected completion without leaking it', async () => {
  const answer = deferred<void>(); const started = deferred<void>()
  const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return [{ update_id: 1, callback_query: { id: 'callback' } }] }, answerCallbackQuery() { started.resolve(); return answer.promise } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {}, undefined, [], undefined, undefined, () => true)
  const polling = adapter.poll(); await started.promise; const drain = adapter.closeAndDrain(); let drained = false; void drain.then(() => { drained = true }); await Bun.sleep(0); expect(drained).toBeFalse()
  answer.reject(new Error('synthetic callback failure')); await polling; await drain; expect(drained).toBeTrue()
})

test('an already-started multipart/file reply drains, while late public egress is rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-drain-')); const file = join(root, 'file.txt'); writeFileSync(file, 'fixture')
  const first = deferred<{ message_id: number }>(); const second = deferred<{ message_id: number }>(); const document = deferred<{ message_id: number }>(); const firstStarted = deferred<void>(); const secondStarted = deferred<void>(); const documentStarted = deferred<void>(); let sends = 0
  const bot = { api: { sendMessage() { sends++; if (sends === 1) { firstStarted.resolve(); return first.promise } secondStarted.resolve(); return second.promise }, sendDocument() { documentStarted.resolve(); return document.promise }, async setMessageReaction() {}, async editMessageText() {}, async getFile() { return { file_path: 'unused' } } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {}, undefined, [root])
  try {
    const reply = adapter.reply(route(), { text: 'x'.repeat(4097), files: [file] }); await firstStarted.promise; const drain = adapter.closeAndDrain()
    expect(() => adapter.reply(route(), { text: 'late' })).toThrow('Telegram adapter is closed'); expect(() => adapter.react(route(), '✅')).toThrow('Telegram adapter is closed'); expect(() => adapter.edit(route(), 'late')).toThrow('Telegram adapter is closed'); expect(() => adapter.downloadAttachment(route(), 'file', 'document')).toThrow('Telegram adapter is closed')
    first.resolve({ message_id: 1 }); await secondStarted.promise; second.resolve({ message_id: 2 }); await documentStarted.promise; document.resolve({ message_id: 3 }); await expect(reply).resolves.toEqual([1, 2, 3]); await drain
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('drain waits for download body consumption and synchronous reentrant egress failure leaves no pending work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telegram-download-drain-')); const bodyStarted = deferred<void>(); const bodyRelease = deferred<void>(); let controller!: ReadableStreamDefaultController<Uint8Array>
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; bodyStarted.resolve(); void bodyRelease.promise.then(() => { value.enqueue(new TextEncoder().encode('fixture')); value.close() }) } }); return new Response(body) } })
  const bot = { api: { async getFile() { return { file_path: 'fixture.txt' } } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {}, undefined, [], root, undefined, undefined, undefined, undefined, path => `${server.url.href}${path}`)
  try {
    const download = adapter.downloadAttachment(route(), 'file', 'document'); await bodyStarted.promise; const drain = adapter.closeAndDrain(); let drained = false; void drain.then(() => { drained = true }); await Bun.sleep(0); expect(drained).toBeFalse(); bodyRelease.resolve(); await download; await drain
  } finally { controller?.error(); server.stop(true); rmSync(root, { recursive: true, force: true }) }
  let reentrant!: Promise<void>; const boom = new Error('synchronous egress failure'); let reentrantAdapter!: TelegramTextAdapter
  const reentrantBot = { api: { sendMessage() { reentrant = reentrantAdapter.closeAndDrain(); throw boom } } }
  reentrantAdapter = new TelegramTextAdapter(reentrantBot as never, config(), async () => {})
  const rejected = reentrantAdapter.reply(route(), { text: 'reentrant' }); expect(reentrantAdapter.closeAndDrain()).toBe(reentrant); await expect(rejected).rejects.toBe(boom); await reentrant; expect(reentrantAdapter.terminalOutcome()?.reason).toBe('explicit-close')
})
