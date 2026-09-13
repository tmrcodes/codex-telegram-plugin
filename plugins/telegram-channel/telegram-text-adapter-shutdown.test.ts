import { expect, test } from 'bun:test'
import { TelegramTextAdapter, parseTelegramTextConfig } from './telegram-text-adapter'
import { AppServerAdmissionUncertainError } from './app-server-controller/protocol'

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function config() { return parseTelegramTextConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1', TELEGRAM_ALLOWED_SENDER_IDS: '2' }) }
function update(id: number) { return { update_id: id, message: { message_id: id, date: 1, text: `message-${id}`, chat: { id: 1, type: 'private' }, from: { id: 2, first_name: 'Example' } } } }

test('close during identity aborts getMe and prevents polling after a late identity result', async () => {
  const identity = deferred<{ id: number; username: string }>(); const started = deferred<void>(); const health: boolean[] = []; let aborted = false; let polls = 0
  const bot = { api: { getMe(signal?: AbortSignal) { started.resolve(); signal?.addEventListener('abort', () => { aborted = true }); return identity.promise }, async getUpdates() { polls++; return [] } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {}, undefined, [], undefined, undefined, undefined, ok => { health.push(ok) })
  const polling = adapter.poll(); await started.promise; adapter.close(); expect(aborted).toBeTrue(); identity.resolve({ id: 1, username: 'synthetic_bot' }); await polling
  expect(polls).toBe(0); expect(health).toEqual([])
})

test('close aborts a blocked getUpdates and does not admit a late returned batch or report a stop failure', async () => {
  const updates = deferred<ReturnType<typeof update>[]>(); const started = deferred<void>(); const seen: number[] = []; const health: boolean[] = []; const sleeps: number[] = []; let aborted = false
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, getUpdates(_args: unknown, signal?: AbortSignal) { started.resolve(); signal?.addEventListener('abort', () => { aborted = true }); return updates.promise } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async route => { seen.push(route.messageId) }, async milliseconds => { sleeps.push(milliseconds) }, [], undefined, undefined, undefined, ok => { health.push(ok) })
  const polling = adapter.poll(); await started.promise; await Bun.sleep(10); adapter.close(); expect(aborted).toBeTrue(); updates.resolve([update(1)]); await polling
  expect(seen).toEqual([]); expect(health).toEqual([]); expect(sleeps).toEqual([])
})

test('close drains an already admitted receive but stops the rest of its batch', async () => {
  const gate = deferred<void>(); const started = deferred<void>(); const seen: number[] = []
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { return [update(1), update(2)] } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async route => { seen.push(route.messageId); if (route.messageId === 1) { started.resolve(); await gate.promise } })
  const polling = adapter.poll(); await started.promise; adapter.close()
  let settled = false; void polling.then(() => { settled = true }); await Bun.sleep(0); expect(settled).toBeFalse()
  gate.resolve(); await polling; expect(seen).toEqual([1])
})

test('duplicate poll calls share one active getUpdates request', async () => {
  const updates = deferred<ReturnType<typeof update>[]>(); const started = deferred<void>(); let polls = 0
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, getUpdates() { polls++; started.resolve(); return updates.promise } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {})
  const first = adapter.poll(); const second = adapter.poll(); expect(first).toBe(second); await started.promise; expect(polls).toBe(1)
  adapter.close(); updates.resolve([]); await first
})

test('close before poll causes no Telegram I/O', async () => {
  let identity = 0; let updates = 0
  const bot = { api: { async getMe() { identity++; return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { updates++; return [] } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {})
  adapter.close(); expect(adapter.terminalOutcome()).toEqual({ reason: 'explicit-close' }); await adapter.poll(); expect(identity).toBe(0); expect(updates).toBe(0)
})

test('a synchronous getUpdates close rejects its returned messages and callbacks', async () => {
  const seen: number[] = []; let callbacks = 0; let adapter!: TelegramTextAdapter
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { adapter.close(); return [update(1), { update_id: 2, callback_query: { id: 'synthetic-callback' } }] }, async answerCallbackQuery() { callbacks++ } } }
  adapter = new TelegramTextAdapter(bot as never, config(), async route => { seen.push(route.messageId) }, undefined, [], undefined, undefined, () => { callbacks++; return true })
  await adapter.poll(); expect(seen).toEqual([]); expect(callbacks).toBe(0)
})

test('a synchronous identity close prevents every poll request', async () => {
  let polls = 0; let adapter!: TelegramTextAdapter
  const bot = { api: { async getMe() { adapter.close(); return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { polls++; return [] } } }
  adapter = new TelegramTextAdapter(bot as never, config(), async () => {})
  await adapter.poll(); expect(polls).toBe(0)
})

test('a synchronous poll throw clears its deadline and abort slot before the quiet stop', async () => {
  const health: boolean[] = []; const sleeps: number[] = []; let signal: AbortSignal | undefined; let adapter!: TelegramTextAdapter
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, getUpdates(_args: unknown, value?: AbortSignal) { signal = value; throw new Error('synthetic synchronous failure') } } }
  adapter = new TelegramTextAdapter(bot as never, config(), async () => {}, async milliseconds => { sleeps.push(milliseconds); adapter.close() }, [], undefined, undefined, undefined, ok => { health.push(ok) }, 10)
  await adapter.poll(); await Bun.sleep(20)
  expect(health).toEqual([false]); expect(sleeps).toHaveLength(1); expect(signal?.aborted).toBeFalse()
})

test('a synchronous reentrant identity call observes the already-published single-flight promise', async () => {
  let identities = 0; let updates = 0; let reentrant: Promise<void> | undefined; let adapter!: TelegramTextAdapter
  const bot = { api: { async getMe() { identities++; reentrant = adapter.poll(); return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { updates++; adapter.close(); return [] } } }
  adapter = new TelegramTextAdapter(bot as never, config(), async () => {})
  const first = adapter.poll(); expect(reentrant).toBe(first); await first
  expect(identities).toBe(1); expect(updates).toBe(1)
})

test('close then uncertain admitted receive latches only the uncertain terminal outcome without health callback', async () => {
  const gate = deferred<void>(); const started = deferred<void>(); const sleeps: number[] = []; let polls = 0
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { polls++; return [update(1)] } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => { started.resolve(); await gate.promise }, async milliseconds => { sleeps.push(milliseconds) })
  const polling = adapter.poll(); await started.promise; adapter.close(); expect(adapter.terminalOutcome()).toBeUndefined()
  const uncertain = new AppServerAdmissionUncertainError('synthetic uncertain admission'); gate.reject(uncertain); await polling
  const outcome = adapter.terminalOutcome(); expect(outcome?.reason).toBe('admission-uncertain'); if (outcome?.reason === 'admission-uncertain') expect(outcome.error).toBe(uncertain)
  expect(sleeps).toEqual([]); await adapter.poll(); expect(polls).toBe(1)
})

test('health callback failures cannot hide an uncertain terminal admission outcome', async () => {
  const gate = deferred<void>(); const started = deferred<void>(); const uncertain = new AppServerAdmissionUncertainError('synthetic uncertain admission')
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { return [update(1)] } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => { started.resolve(); await gate.promise }, undefined, [], undefined, undefined, undefined, () => { throw new Error('health observer failed') })
  const polling = adapter.poll(); await started.promise; adapter.close(); gate.reject(uncertain); await polling
  const outcome = adapter.terminalOutcome(); expect(outcome?.reason).toBe('admission-uncertain'); if (outcome?.reason === 'admission-uncertain') expect(outcome.error).toBe(uncertain)
})

test('eight 409 conflicts latch once without a terminal sleep, stop polling, and survive idempotent close', async () => {
  const conflict = new Error('409 conflict: another getUpdates owner'); let polls = 0; const delays: number[] = []; const terminalSleep = new Error('terminal sleep must not run')
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { polls++; throw conflict } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {}, async milliseconds => { if (milliseconds === 0) throw terminalSleep; delays.push(milliseconds) })
  await adapter.poll(); expect(polls).toBe(8); expect(delays).toHaveLength(7)
  const outcome = adapter.terminalOutcome(); expect(outcome?.reason).toBe('repeated-409-conflict'); if (outcome?.reason === 'repeated-409-conflict') expect(outcome.error).toBe(conflict)
  expect(Object.isFrozen(outcome)).toBeTrue(); try { (outcome as unknown as { reason: string }).reason = 'explicit-close' } catch { /* frozen outcome may throw in strict mode */ }; expect(adapter.terminalOutcome()?.reason).toBe('repeated-409-conflict')
  adapter.close(); adapter.close(); expect(adapter.terminalOutcome()).toBe(outcome)
  await adapter.poll(); expect(polls).toBe(8)
})

test('an unexpected fatal polling failure latches before the rejected poll settles and prevents restart', async () => {
  const fatal = new Error('synthetic sleep failure'); let polls = 0
  const bot = { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { polls++; throw new Error('synthetic transient failure') } } }
  const adapter = new TelegramTextAdapter(bot as never, config(), async () => {}, async () => { throw fatal })
  await expect(adapter.poll()).rejects.toBe(fatal)
  const outcome = adapter.terminalOutcome(); expect(outcome?.reason).toBe('unexpected-fatal-failure'); if (outcome?.reason === 'unexpected-fatal-failure') expect(outcome.error).toBe(fatal)
  await adapter.poll(); expect(polls).toBe(1)
})
