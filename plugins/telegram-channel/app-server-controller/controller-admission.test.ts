import { expect, test } from 'bun:test'
import { AppServerController } from './controller'
import { AppServerAdmissionUncertainError, type AppServerTransport } from './protocol'

const thread = '11111111-1111-1111-1111-111111111111'
type Call = { method: string; params?: Record<string, unknown> }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function origin(id = 'telegram:synthetic:1') { return { id, route: thread, source: 'telegram' as const, text: 'synthetic input' } }

class Rpc implements AppServerTransport {
  calls: Call[] = []
  listener: ((method: string, params: Record<string, unknown>) => void) | undefined
  closeListener: ((error: Error) => void) | undefined
  threadStatus: unknown = { type: 'idle' }
  handler: ((method: string, params: Record<string, unknown>) => Promise<unknown> | unknown) | undefined
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if ((method === 'turn/start' || method === 'turn/steer') && params.threadId === 'codex-telegram-invalid-thread-id') return {}
    this.calls.push({ method, params })
    if (method === 'initialize') return {}
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: thread, cwd: '/workspace', status: this.threadStatus } }
    if (method === 'thread/queue/list') return { data: [] }
    if (this.handler !== undefined) return await this.handler(method, params)
    if (method === 'turn/start') return { turn: { id: 'turn-started' } }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId }
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queue-submission', input: params.input, clientUserMessageId: params.clientUserMessageId } }
    throw new Error(`unexpected method ${method}`)
  }
  notify(): void {}
  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void { this.listener = listener; return () => { this.listener = undefined } }
  onClose(listener: (error: Error) => void): () => void { this.closeListener = listener; return () => { this.closeListener = undefined } }
  emit(method: string, params: Record<string, unknown>): void { this.listener?.(method, params) }
  close(error = new Error('synthetic transport close')): void { this.closeListener?.(error) }
}

async function connected(rpc: Rpc, timeout = 20): Promise<AppServerController> {
  const controller = new AppServerController(rpc, 'admission-fixture', '/workspace', true, timeout)
  await controller.attach(rpc); await controller.awaitTuiThread(thread)
  return controller
}

test('requires stock-shaped start and queue receipts and passes the exact client correlation to steer', async () => {
  const idle = new Rpc(); const idleController = await connected(idle)
  await expect(idleController.admit(origin('start-correlation'))).resolves.toEqual({ duplicate: false, disposition: 'started' })
  expect(idle.calls.at(-1)).toEqual({ method: 'turn/start', params: { threadId: thread, clientUserMessageId: 'start-correlation', input: [{ type: 'text', text: 'synthetic input', text_elements: [] }] } })

  const queued = new Rpc(); queued.threadStatus = { type: 'active', activeFlags: [] }; const queueController = await connected(queued)
  await expect(queueController.admit(origin('queue-correlation'), 'queue')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
  expect(queued.calls.at(-1)?.params?.clientUserMessageId).toBe('queue-correlation')

  const active = new Rpc(); active.threadStatus = { type: 'active', activeFlags: [] }; const steerController = await connected(active); active.emit('turn/started', { threadId: thread, turn: { id: 'expected-turn' } })
  await expect(steerController.admit(origin('steer-correlation'), 'steer')).resolves.toEqual({ duplicate: false, disposition: 'started' })
  expect(active.calls.at(-1)).toEqual({ method: 'turn/steer', params: { threadId: thread, expectedTurnId: 'expected-turn', clientUserMessageId: 'steer-correlation', input: [{ type: 'text', text: 'synthetic input', text_elements: [] }] } })
})

test('latches malformed mutating acknowledgements and makes later admission pre-I/O', async () => {
  const scenarios: Array<{ mode: 'start' | 'queue' | 'steer'; response: unknown }> = [
    { mode: 'start', response: null },
    { mode: 'queue', response: { queuedSubmission: { id: '', clientUserMessageId: 'queue-bad' } } },
    { mode: 'steer', response: { turnId: 'wrong-turn' } },
  ]
  for (const scenario of scenarios) {
    const rpc = new Rpc(); if (scenario.mode !== 'start') rpc.threadStatus = { type: 'active', activeFlags: [] }
    rpc.handler = method => method === 'turn/start' || method === 'thread/queue/add' || method === 'turn/steer' ? scenario.response : {}
    const controller = await connected(rpc)
    if (scenario.mode === 'steer') rpc.emit('turn/started', { threadId: thread, turn: { id: 'expected-turn' } })
    await expect(controller.admit(origin(`${scenario.mode}-bad`), scenario.mode === 'start' ? 'auto' : scenario.mode)).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
    const writes = rpc.calls.filter(call => ['turn/start', 'thread/queue/add', 'turn/steer'].includes(call.method)).length
    await expect(controller.admit(origin(`${scenario.mode}-after`))).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
    expect(rpc.calls.filter(call => ['turn/start', 'thread/queue/add', 'turn/steer'].includes(call.method))).toHaveLength(writes)
  }
})

test('an exact user-message visibility receipt proves start admission despite a later rejected RPC response', async () => {
  const rpc = new Rpc(); const late = deferred<unknown>(); rpc.handler = method => method === 'turn/start' ? late.promise : { queuedSubmission: { id: 'queue-after-visible', clientUserMessageId: 'after-visible' } }
  const controller = await connected(rpc)
  let settled = false; const admitted = controller.admit(origin('visible-correlation')).then(value => { settled = true; return value })
  await Bun.sleep(0); rpc.emit('item/completed', { threadId: thread, item: { type: 'userMessage', clientUserMessageId: 'other-correlation' } }); await Bun.sleep(0); expect(settled).toBeFalse()
  rpc.emit('item/completed', { threadId: thread, item: { type: 'userMessage', clientUserMessageId: 'visible-correlation' } })
  await expect(admitted).resolves.toEqual({ duplicate: false, disposition: 'started' })
  late.reject(new Error('late transport rejection')); await Bun.sleep(0)
  await expect(controller.admit(origin('after-visible'), 'queue')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
})

test('a queue timeout latches uncertainty even when its request later returns an exact receipt', async () => {
  const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; const late = deferred<unknown>(); rpc.handler = method => method === 'thread/queue/add' ? late.promise : {}
  const controller = await connected(rpc, 1)
  await expect(controller.admit(origin('queue-timeout'), 'queue')).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
  late.resolve({ queuedSubmission: { id: 'late-queue', clientUserMessageId: 'queue-timeout' } }); await Bun.sleep(0)
  const writes = rpc.calls.filter(call => ['turn/start', 'thread/queue/add', 'turn/steer'].includes(call.method)).length
  await expect(controller.admit(origin('after-timeout'))).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
  expect(rpc.calls.filter(call => ['turn/start', 'thread/queue/add', 'turn/steer'].includes(call.method))).toHaveLength(writes)
})

test('a generic mutating transport failure is uncertain, while a concurrent attempt is distinctly not admitted', async () => {
  const disconnected = new Rpc(); disconnected.handler = method => { if (method === 'turn/start') throw new Error('transport disconnected'); return {} }
  const disconnectedController = await connected(disconnected)
  await expect(disconnectedController.admit(origin('disconnect'))).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
  const writes = disconnected.calls.filter(call => call.method === 'turn/start').length
  await expect(disconnectedController.admit(origin('after-disconnect'))).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
  expect(disconnected.calls.filter(call => call.method === 'turn/start')).toHaveLength(writes)
  disconnectedController.disconnect(); await disconnectedController.attach(disconnected); await disconnectedController.awaitTuiThread(thread)
  await expect(disconnectedController.admit(origin('after-reattach'))).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
  expect(disconnected.calls.filter(call => call.method === 'turn/start' && call.params?.threadId === thread)).toHaveLength(writes)

  const rpc = new Rpc(); const delayed = deferred<unknown>(); rpc.handler = method => method === 'turn/start' ? delayed.promise : {}
  const controller = await connected(rpc)
  const first = controller.admit(origin('first'))
  await expect(controller.admit(origin('second'))).rejects.toThrow('already in progress')
  expect(rpc.calls.filter(call => call.method === 'turn/start' && call.params?.threadId === thread)).toHaveLength(1)
  delayed.resolve({ turn: { id: 'first-turn' } }); await expect(first).resolves.toEqual({ duplicate: false, disposition: 'started' })
})

test('an unknown direct-steer RPC error cannot fall back to another mutating submission', async () => {
  const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; rpc.handler = method => { if (method === 'turn/steer') throw new Error('internal transport error'); return {} }
  const controller = await connected(rpc); rpc.emit('turn/started', { threadId: thread, turn: { id: 'expected-turn' } })
  await expect(controller.admit(origin('unknown-steer'), 'steer')).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
  expect(rpc.calls.filter(call => ['turn/steer', 'thread/queue/add'].includes(call.method)).map(call => call.method)).toEqual(['turn/steer'])
})

test('a transport close during a mutating request preserves the uncertainty latch across reattach', async () => {
  const rpc = new Rpc(); const delayed = deferred<unknown>(); rpc.handler = method => method === 'turn/start' ? delayed.promise : {}
  const controller = await connected(rpc); const first = controller.admit(origin('closed-in-flight'))
  await Bun.sleep(0); rpc.close(); await controller.attach(rpc); await controller.awaitTuiThread(thread)
  const writes = rpc.calls.filter(call => call.method === 'turn/start' && call.params?.threadId === thread).length
  await expect(controller.admit(origin('after-transport-close'))).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
  expect(rpc.calls.filter(call => call.method === 'turn/start' && call.params?.threadId === thread)).toHaveLength(writes)
  delayed.resolve({ turn: { id: 'late-turn' } }); await expect(first).resolves.toEqual({ duplicate: false, disposition: 'started' })
})
