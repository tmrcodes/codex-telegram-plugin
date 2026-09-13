import { describe, expect, test } from 'bun:test'
import { AppServerController, bindExactHostThread, supportsUntrustedAdditionalContext } from './controller'
import { AppServerAdmissionUncertainError, AppServerRpcError, type AppServerTransport } from './protocol'

class Rpc implements AppServerTransport {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  probes: Array<{ method: string; params?: Record<string, unknown> }> = []
  listener: ((method: string, params: Record<string, unknown>) => void) | undefined
  threadStatus: unknown = { type: 'idle' }
  resumeNotification: { method: string; params: Record<string, unknown> } | undefined
  resumeError: Error | undefined
  turnStartError: Error | undefined
  turnSteerError: Error | undefined
  settingsUpdateError: Error | undefined
  settingsUpdateResponse: unknown = {}
  threadModel: string | undefined
  threadReasoningEffort: string | undefined
  queue: unknown[] = []
  probeStart: 'supported' | 'unsupported' | 'timeout' = 'unsupported'
  probeSteer: 'supported' | 'unsupported' | 'timeout' = 'unsupported'
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if ((method === 'turn/start' || method === 'turn/steer') && params?.threadId === 'codex-telegram-invalid-thread-id') {
      this.probes.push({ method, params })
      const mode = method === 'turn/start' ? this.probeStart : this.probeSteer
      if (mode === 'timeout') return await new Promise<never>(() => {})
      if (mode === 'supported') throw new AppServerRpcError(-32600, 'Invalid request: unknown variant `codex-telegram-invalid-kind-probe`, expected `untrusted` or `application`')
      return {}
    }
    this.calls.push({ method, params })
    if (method === 'thread/read') return { thread: { id: params?.threadId, cwd: '/workspace', status: this.threadStatus, ...(this.threadModel === undefined ? {} : { model: this.threadModel }), ...(this.threadReasoningEffort === undefined ? {} : { reasoningEffort: this.threadReasoningEffort }) } }
    if (method === 'thread/resume') { if (this.resumeError !== undefined) throw this.resumeError; if (this.resumeNotification !== undefined) this.emit(this.resumeNotification.method, this.resumeNotification.params); return { thread: { id: params?.threadId, cwd: '/workspace', status: this.threadStatus } } }
    if (method === 'thread/settings/update') { if (this.settingsUpdateError !== undefined) throw this.settingsUpdateError; return this.settingsUpdateResponse }
    if (method === 'turn/start' && this.turnStartError !== undefined) throw this.turnStartError
    if (method === 'turn/steer' && this.turnSteerError !== undefined) throw this.turnSteerError
    if (method === 'turn/start') return { turn: { id: 'turn-started' } }
    if (method === 'turn/steer') return { turnId: params?.expectedTurnId }
    if (method === 'thread/queue/list') return { data: this.queue }
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queued-submission', input: params?.input, clientUserMessageId: params?.clientUserMessageId } }
    return {}
  }
  notify(): void {}
  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void { this.listener = listener; return () => { this.listener = undefined } }
  onClose(): () => void { return () => {} }
  emit(method: string, params: Record<string, unknown>): void { this.listener?.(method, params) }
}

const thread = '11111111-1111-1111-1111-111111111111'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function telegram(overrides: Partial<{ id: string; route: string; text: string; displayText: string; localImagePath: string }> = {}) { return { id: 'telegram:-100:7', route: thread, source: 'telegram' as const, text: '<channel source="telegram">hello</channel>', ...overrides } }
async function connected(rpc: Rpc, turnSteerCapable = false, admissionTimeoutMilliseconds?: number): Promise<AppServerController> {
  const controller = new AppServerController(rpc, '0.152.0', '/workspace', turnSteerCapable, admissionTimeoutMilliseconds)
  await controller.attach(rpc)
  await controller.awaitTuiThread(thread)
  return controller
}

describe('native App Server admission controller', () => {
  test('transition quiescence requires both an idle turn and an empty stock admission queue', async () => {
    const busyRpc = new Rpc(); const busy = await connected(busyRpc, true)
    busyRpc.emit('turn/started', { threadId: thread, turn: { id: 'active-turn' } })
    await expect(busy.isQuiescent()).resolves.toBeFalse()
    busyRpc.emit('turn/completed', { threadId: thread, turn: { id: 'active-turn' } })
    await expect(busy.isQuiescent()).resolves.toBeTrue()

    const queuedRpc = new Rpc(); queuedRpc.queue = [{ id: 'queued-admission' }]; const queued = await connected(queuedRpc)
    await expect(queued.isQuiescent()).resolves.toBeFalse()
    queuedRpc.queue = []
    await expect(queued.isQuiescent()).resolves.toBeTrue()
  })
  test('transition quiescence revalidates busy and in-flight admission after its queue read', async () => {
    const busyRpc = new Rpc(); const busy = await connected(busyRpc); const busyQueue = deferred<unknown>(); const busyRequest = busyRpc.request.bind(busyRpc)
    busyRpc.request = async (method, params) => method === 'thread/queue/list' ? await busyQueue.promise : await busyRequest(method, params)
    const busyCheck = busy.isQuiescent(); await Bun.sleep(0); busyRpc.emit('turn/started', { threadId: thread, turn: { id: 'late-busy' } }); busyQueue.resolve({ data: [] })
    await expect(busyCheck).resolves.toBeFalse()

    const admissionRpc = new Rpc(); const admission = await connected(admissionRpc); const admissionQueue = deferred<unknown>(); const start = deferred<unknown>(); const admissionRequest = admissionRpc.request.bind(admissionRpc)
    admissionRpc.request = async (method, params) => method === 'thread/queue/list' ? await admissionQueue.promise : method === 'turn/start' ? await start.promise : await admissionRequest(method, params)
    const admissionCheck = admission.isQuiescent(); await Bun.sleep(0); const admitted = admission.admit(telegram({ id: 'late-admission' })); await Bun.sleep(0); admissionQueue.resolve({ data: [] })
    await expect(admissionCheck).resolves.toBeFalse(); start.resolve({ turn: { id: 'late-admission-turn' } }); await expect(admitted).resolves.toEqual({ duplicate: false, disposition: 'started' })
  })
  test('recognizes only both exact typed parser rejections and fails closed otherwise', async () => {
    const supported = new Rpc(); supported.probeStart = 'supported'; supported.probeSteer = 'supported'
    await expect(supportsUntrustedAdditionalContext(supported, 1)).resolves.toBeTrue()
    expect(supported.probes).toEqual([
      { method: 'turn/start', params: { threadId: 'codex-telegram-invalid-thread-id', input: [], additionalContext: { 'codex-telegram-capability-probe': { kind: 'codex-telegram-invalid-kind-probe', value: '' } } } },
      { method: 'turn/steer', params: { threadId: 'codex-telegram-invalid-thread-id', expectedTurnId: 'codex-telegram-invalid-turn-id', input: [], additionalContext: { 'codex-telegram-capability-probe': { kind: 'codex-telegram-invalid-kind-probe', value: '' } } } },
    ])
    const unsupported = new Rpc(); unsupported.probeStart = 'supported'
    await expect(supportsUntrustedAdditionalContext(unsupported, 1)).resolves.toBeFalse()
    const timeout = new Rpc(); timeout.probeStart = 'timeout'; timeout.probeSteer = 'timeout'
    await expect(supportsUntrustedAdditionalContext(timeout, 1)).resolves.toBeFalse()
  })
  test('binds only the exact loaded host thread with empty settings after one initialization', async () => {
    const rpc = new Rpc(); rpc.probeStart = 'supported'; rpc.probeSteer = 'supported'; const bound = await bindExactHostThread(rpc, 'standalone-test', thread)
    expect(bound.cwd).toBe('/workspace'); expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/read', 'thread/resume']); expect(rpc.calls.some(call => call.method === 'thread/settings/update')).toBeFalse()
    expect(rpc.probes.map(call => call.method)).toEqual(['turn/start', 'turn/steer'])
    await expect(bound.controller.admit(telegram({ displayText: 'Telegram · sender: Mira · request: short' }))).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: thread, clientUserMessageId: 'telegram:-100:7', input: [{ type: 'text', text: 'Telegram · sender: Mira · request: short', text_elements: [] }], additionalContext: { 'telegram:-100:7': { kind: 'untrusted', value: '<channel source="telegram">hello</channel>' } } })
    bound.controller.disconnect()
  })
  test('binds first start only from the authoritative stock TUI notification', async () => {
    const rpc = new Rpc(); const controller = new AppServerController(rpc, '0.152.0', '/workspace'); await controller.attach(rpc); const binding = controller.awaitTuiThread()
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize'])
    rpc.emit('thread/started', { thread: { id: thread, cwd: '/other' } }); rpc.emit('thread/started', { thread: { id: thread, cwd: '/workspace' } })
    await expect(binding).resolves.toBe(thread); expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/resume'])
  })
  test('admits the first real input to a verified loaded empty thread without a synthetic turn', async () => {
    const rpc = new Rpc(); rpc.resumeError = new AppServerRpcError(-32600, `no rollout found for thread id ${thread}`)
    const bound = await bindExactHostThread(rpc, 'empty-tui', thread)
    expect(rpc.calls.some(call => call.method === 'turn/start' || call.method === 'thread/start')).toBeFalse()
    await expect(bound.controller.admit(telegram(), 'queue')).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.at(-1)?.method).toBe('turn/start')
    // The first real turn persisted the thread; a later input subscribes normally.
    rpc.resumeError = undefined; rpc.threadStatus = { type: 'active', activeFlags: [] }
    await expect(bound.controller.admit(telegram({ id: 'second' }), 'queue')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    expect(rpc.calls.at(-1)?.method).toBe('thread/queue/add')
    const reads = rpc.calls.filter(call => call.method === 'thread/read').length
    await bound.controller.admit(telegram({ id: 'third' }), 'queue')
    expect(rpc.calls.filter(call => call.method === 'thread/read').length).toBe(reads)
    bound.controller.disconnect()
  })
  test('does not treat unrelated resume errors or another thread as an empty-thread binding', async () => {
    for (const error of [new AppServerRpcError(-32600, 'no rollout found for thread id another'), new AppServerRpcError(-32603, `no rollout found for thread id ${thread}`), new Error('resume timed out')]) {
      const rpc = new Rpc(); rpc.resumeError = error
      await expect(bindExactHostThread(rpc, 'empty-tui', thread)).rejects.toThrow(error.message)
      expect(rpc.calls.some(call => call.method === 'turn/start' || call.method === 'thread/queue/add')).toBeFalse()
    }
  })
  test('binds a resumed TUI through read-only loaded-state observation without a cross-client notification', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'idle' }; const controller = new AppServerController(rpc, '0.152.0', '/workspace'); await controller.attach(rpc)
    await expect(controller.awaitTuiThread(thread)).resolves.toBe(thread)
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume'])
  })
  test('applies configured profile thread settings immediately after resume before admission', async () => {
    const rpc = new Rpc(); rpc.threadModel = 'configured-model'; rpc.threadReasoningEffort = 'configured-effort'; const controller = new AppServerController(rpc, 'release-fixture', '/workspace', false, undefined, { model: 'configured-model', effort: 'configured-effort' }); await controller.attach(rpc)
    await expect(controller.awaitTuiThread(thread)).resolves.toBe(thread)
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/settings/update', 'thread/read'])
    expect(rpc.calls.at(-2)?.params).toEqual({ threadId: thread, model: 'configured-model', effort: 'configured-effort' })
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: thread, includeTurns: false })
    await expect(controller.admit(telegram())).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/settings/update', 'thread/read', 'turn/start'])
  })
  test('applies configured profile thread settings after a TUI-owned thread notification', async () => {
    const rpc = new Rpc(); rpc.threadModel = 'configured-model'; rpc.threadReasoningEffort = 'configured-effort'; const controller = new AppServerController(rpc, 'release-fixture', '/workspace', false, undefined, { model: 'configured-model', effort: 'configured-effort' }); await controller.attach(rpc)
    const binding = controller.awaitTuiThread(); rpc.emit('thread/started', { thread: { id: thread, cwd: '/workspace' } })
    await expect(binding).resolves.toBe(thread)
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/resume', 'thread/settings/update', 'thread/read'])
    expect(rpc.calls.at(-2)?.params).toEqual({ threadId: thread, model: 'configured-model', effort: 'configured-effort' })
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: thread, includeTurns: false })
  })
  test('fails closed when configured thread settings are rejected, non-object, or inspectably mismatched', async () => {
    for (const response of [new Error('settings rejected'), null, { settings: { model: 'other-model', effort: 'configured-effort' } }]) {
      const rpc = new Rpc(); if (response instanceof Error) rpc.settingsUpdateError = response; else rpc.settingsUpdateResponse = response
      const controller = new AppServerController(rpc, 'release-fixture', '/workspace', false, undefined, { model: 'configured-model', effort: 'configured-effort' }); await controller.attach(rpc)
      await expect(controller.awaitTuiThread(thread)).rejects.toThrow(response instanceof Error ? 'settings rejected' : response === null ? 'invalid response' : 'mismatched model')
      expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/settings/update'])
      await expect(controller.admit(telegram())).rejects.toThrow('bound controller thread')
    }
  })
  test('fails closed when the post-update stock thread settings do not match the profile', async () => {
    const rpc = new Rpc(); rpc.threadModel = 'other-model'; rpc.threadReasoningEffort = 'configured-effort'; const controller = new AppServerController(rpc, 'release-fixture', '/workspace', false, undefined, { model: 'configured-model', effort: 'configured-effort' }); await controller.attach(rpc)
    await expect(controller.awaitTuiThread(thread)).rejects.toThrow('verification returned a mismatched model')
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/settings/update', 'thread/read'])
    await expect(controller.admit(telegram())).rejects.toThrow('bound controller thread')
  })
  test('fails closed when the TUI-owned thread enters systemError', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'systemError' }; const controller = new AppServerController(rpc, '0.152.0', '/workspace'); await controller.attach(rpc)
    await expect(controller.awaitTuiThread(thread)).rejects.toThrow('systemError')
    await expect(controller.admit(telegram())).rejects.toThrow('bound controller thread')
  })
  test('starts idle resumed Telegram input with its stable client id and local image', async () => {
    const rpc = new Rpc(); const controller = await connected(rpc)
    await expect(controller.admit(telegram({ localImagePath: '/tmp/photo.jpg' }))).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'turn/start'])
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: thread, clientUserMessageId: 'telegram:-100:7', input: [{ type: 'text', text: '<channel source="telegram">hello</channel>', text_elements: [] }, { type: 'localImage', path: '/tmp/photo.jpg' }] })
  })
  test('passes both current and quoted images to the stock model input', async () => {
    const rpc = new Rpc(); const controller = await connected(rpc)
    await controller.admit({ ...telegram(), localImagePaths: ['/tmp/current.jpg', '/tmp/reply.jpg'] })
    expect((rpc.calls.at(-1)?.params?.input as unknown[]).slice(1)).toEqual([{ type: 'localImage', path: '/tmp/current.jpg' }, { type: 'localImage', path: '/tmp/reply.jpg' }])
  })
  test('uses compact Telegram input plus a complete same-request untrusted context only after both probes recognize it', async () => {
    const rpc = new Rpc(); rpc.probeStart = 'supported'; rpc.probeSteer = 'supported'; const controller = await connected(rpc)
    await expect(controller.admit(telegram({ displayText: 'Telegram · sender: Mira · request: short', localImagePath: '/tmp/photo.jpg' }))).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: thread, clientUserMessageId: 'telegram:-100:7', input: [{ type: 'text', text: 'Telegram · sender: Mira · request: short', text_elements: [] }, { type: 'localImage', path: '/tmp/photo.jpg' }], additionalContext: { 'telegram:-100:7': { kind: 'untrusted', value: '<channel source="telegram">hello</channel>' } } })
    expect(rpc.probes.map(call => call.method)).toEqual(['turn/start', 'turn/steer'])
  })
  test('queue mode queues Telegram input after active resume', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; const controller = await connected(rpc)
    await expect(controller.admit(telegram(), 'queue')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/queue/add'])
  })
  test('steer mode queues an attached-active thread until it observes its active turn ID', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; const controller = await connected(rpc, true)
    await expect(controller.admit(telegram(), 'steer')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/queue/add'])
  })
  test('uses capable direct turn/steer only after a same-thread active turn ID is observed', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; const controller = await connected(rpc, true)
    rpc.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
    await expect(controller.admit(telegram(), 'steer')).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'turn/steer'])
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: thread, expectedTurnId: 'turn-1', clientUserMessageId: 'telegram:-100:7', input: [{ type: 'text', text: '<channel source="telegram">hello</channel>', text_elements: [] }] })
  })
  test('uses compact Telegram input and complete context for recognized direct steer', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; rpc.probeStart = 'supported'; rpc.probeSteer = 'supported'; const controller = await connected(rpc, true); rpc.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
    await expect(controller.admit(telegram({ displayText: 'Telegram · sender: Mira · request: short' }), 'steer')).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: thread, expectedTurnId: 'turn-1', clientUserMessageId: 'telegram:-100:7', input: [{ type: 'text', text: 'Telegram · sender: Mira · request: short', text_elements: [] }], additionalContext: { 'telegram:-100:7': { kind: 'untrusted', value: '<channel source="telegram">hello</channel>' } } })
  })
  test('ignores stale completion events until the matching active turn completes', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; const controller = await connected(rpc, true); rpc.emit('turn/started', { threadId: thread, turn: { id: 'turn-current' } })
    rpc.emit('turn/completed', { threadId: thread, turn: { id: 'turn-stale' } })
    await expect(controller.admit(telegram(), 'steer')).resolves.toEqual({ duplicate: false, disposition: 'started' })
    rpc.emit('turn/completed', { threadId: thread, turn: { id: 'turn-current' } })
    await expect(controller.admit(telegram({ id: 'idle-after-complete' }))).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.filter(call => call.method === 'turn/steer')).toHaveLength(1)
    expect(rpc.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
  })
  test('fails closed without a queue fallback for a malformed or mismatched direct-steer response', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; const controller = await connected(rpc, true); rpc.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
    rpc.request = async (method: string, params?: Record<string, unknown>) => { rpc.calls.push({ method, params }); if (method === 'turn/steer') return { turnId: 'other-turn' }; return method === 'thread/queue/list' ? { data: [] } : {} }
    await expect(controller.admit(telegram(), 'steer')).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'turn/steer'])
  })
  test('treats only the matching completed user message as idle turn/start admission when its RPC response is delayed', async () => {
    let release!: () => void; const rpc = new Rpc(); const controller = await connected(rpc); rpc.request = async (method: string, params?: Record<string, unknown>) => { rpc.calls.push({ method, params }); if (method === 'turn/start') { rpc.emit('turn/started', { threadId: thread }); rpc.emit('item/completed', { threadId: thread, item: { type: 'userMessage', client_id: 'unrelated' } }); rpc.emit('item/completed', { threadId: '22222222-2222-2222-2222-222222222222', item: { type: 'userMessage', client_id: params?.clientUserMessageId } }); await new Promise<void>(resolve => { release = resolve }); rpc.emit('item/completed', { threadId: thread, item: { type: 'userMessage', clientId: params?.clientUserMessageId } }); rpc.emit('item/started', { threadId: thread, item: { type: 'userMessage', clientId: params?.clientUserMessageId } }); return await new Promise<never>(() => {}) } return method === 'thread/read' ? { thread: rpc.threadStatus } : method === 'thread/resume' ? { thread: { id: thread, cwd: '/workspace', status: rpc.threadStatus } } : {} }
    let settled = false; const admitted = controller.admit(telegram({ id: 'visible-user-message' }), 'steer').then(value => { settled = true; return value }); await Bun.sleep(0); expect(settled).toBeFalse(); release(); await expect(admitted).resolves.toEqual({ duplicate: false, disposition: 'started' })
  })
  test('auto mode queues without an observed active ID and steers only with capability plus an empty backlog', async () => {
    const empty = new Rpc(); empty.threadStatus = { type: 'active', activeFlags: [] }; const controller = await connected(empty, true)
    await expect(controller.admit(telegram(), 'auto')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    expect(empty.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/queue/list', 'thread/queue/add'])
    const direct = new Rpc(); direct.threadStatus = { type: 'active', activeFlags: [] }; const capable = await connected(direct, true); direct.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
    await expect(capable.admit(telegram(), 'auto')).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(direct.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/queue/list', 'turn/steer'])
    const backlog = new Rpc(); backlog.threadStatus = { type: 'active', activeFlags: [] }; backlog.queue = [{ id: 'queued' }]; const queued = await connected(backlog, true); backlog.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
    await expect(queued.admit(telegram(), 'auto')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    expect(backlog.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/queue/list', 'thread/queue/add'])
  })
  test('retains bound-route activity reported while subscribing after the TUI', async () => {
    const rpc = new Rpc(); rpc.resumeNotification = { method: 'turn/started', params: { threadId: thread } }; const controller = await connected(rpc)
    await expect(controller.admit(telegram(), 'queue')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/queue/add'])
  })
  test('uses bound-route turn and status activity to apply the selected delivery mode', async () => {
    const rpc = new Rpc(); const controller = await connected(rpc)
    rpc.emit('turn/started', { threadId: thread }); await expect(controller.admit(telegram({ id: 'started-event' }), 'queue')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    rpc.emit('turn/completed', { threadId: thread }); await expect(controller.admit(telegram({ id: 'completed' }))).resolves.toEqual({ duplicate: false, disposition: 'started' })
    rpc.emit('thread/status/changed', { threadId: thread, status: { type: 'active', activeFlags: [] } }); await expect(controller.admit(telegram({ id: 'active-status' }), 'steer')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    rpc.emit('thread/status/changed', { threadId: thread, status: { type: 'idle' } }); await expect(controller.admit(telegram({ id: 'idle' }))).resolves.toEqual({ duplicate: false, disposition: 'started' })
    expect(rpc.calls.filter(call => call.method === 'turn/start').map(call => call.params?.clientUserMessageId)).toEqual(['completed', 'idle'])
  })
  test('fails closed on malformed bound-route status notifications', async () => {
    const rpc = new Rpc(); const controller = await connected(rpc)
    expect(() => rpc.emit('thread/status/changed', { threadId: thread, status: { type: 'unknown' } })).not.toThrow()
    await expect(controller.admit(telegram())).rejects.toThrow('bound controller thread')
  })
  test('falls back exactly once for deterministic direct-steer non-steerable errors', async () => {
    for (const kind of ['Review', 'Compact', 'Finalization']) {
      const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; rpc.turnSteerError = new AppServerRpcError(-32603, `failed to submit turn input: ActiveTurnNotSteerable { turn_kind: ${kind} }`); const controller = await connected(rpc, true); rpc.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
      await expect(controller.admit(telegram())).resolves.toEqual({ duplicate: false, disposition: 'queued' })
      expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/queue/list', 'turn/steer', 'thread/queue/add'])
    }
  })
  test('falls back once to the stock queue when the observed turn/steer method is unavailable', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; rpc.turnSteerError = new AppServerRpcError(-32601, 'method not found'); const controller = await connected(rpc, true); rpc.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
    await expect(controller.admit(telegram(), 'steer')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'turn/steer', 'thread/queue/add'])
  })
  test('uses the structured stock non-steerable error for queue fallback', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; rpc.turnSteerError = new AppServerRpcError(-32600, 'cannot steer a review turn', { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } }); const controller = await connected(rpc, true); rpc.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
    await expect(controller.admit(telegram(), 'steer')).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'turn/steer', 'thread/queue/add'])
  })
  test('latches generic turn-start failures as uncertain without a queue fallback', async () => {
    for (const error of [new Error('network'), new AppServerRpcError(-32603, 'failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Other }')]) {
      const rpc = new Rpc(); rpc.turnStartError = error; const controller = await connected(rpc)
      await expect(controller.admit(telegram())).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
      expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'turn/start'])
    }
  })
  test('times out an idle admission without queue fallback', async () => {
    const rpc = new Rpc(); const controller = await connected(rpc, false, 1)
    rpc.request = async (method: string, params?: Record<string, unknown>) => { rpc.calls.push({ method, params }); if (method === 'turn/start') return await new Promise<never>(() => {}); return {} }
    await expect(controller.admit(telegram())).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'turn/start'])
  })
  test('times out direct steer without a second submission or queue fallback', async () => {
    const rpc = new Rpc(); rpc.threadStatus = { type: 'active', activeFlags: [] }; const controller = await connected(rpc, true, 1); rpc.emit('turn/started', { threadId: thread, turn: { id: 'turn-1' } })
    rpc.request = async (method: string, params?: Record<string, unknown>) => { rpc.calls.push({ method, params }); if (method === 'turn/steer') return await new Promise<never>(() => {}); return method === 'thread/queue/list' ? { data: [] } : {} }
    await expect(controller.admit(telegram(), 'steer')).rejects.toBeInstanceOf(AppServerAdmissionUncertainError)
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'turn/steer'])
  })
  test('keeps peer input queue-only and preserves route binding', async () => {
    const rpc = new Rpc(); rpc.probeStart = 'supported'; rpc.probeSteer = 'supported'; const controller = await connected(rpc)
    await expect(controller.admitPeer({ id: 'peer:1', route: thread, text: 'peer', clientUserMessageId: 'peer-client' })).resolves.toEqual({ duplicate: false, disposition: 'queued' })
    await expect(controller.admit(telegram({ id: 'wrong', route: '22222222-2222-2222-2222-222222222222' }))).rejects.toThrow('bound controller thread')
    expect(rpc.calls.map(call => call.method)).toEqual(['initialize', 'thread/read', 'thread/resume', 'thread/queue/add'])
    expect(rpc.calls.at(-1)?.params).toEqual({ threadId: thread, clientUserMessageId: 'peer-client', input: [{ type: 'text', text: 'peer', text_elements: [] }] })
  })
})
