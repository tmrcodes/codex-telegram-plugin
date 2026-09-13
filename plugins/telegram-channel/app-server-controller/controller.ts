import { AppServerAdmissionUncertainError, AppServerRpcError, type AppServerTransport, type Origin } from './protocol'
import type { TelegramDeliveryMode } from '../telegram-policy'

type PendingThread = { expectedThreadId?: string; resolve: (threadId: string) => void; reject: (error: Error) => void }
type PendingTurnStart = { threadId: string; clientUserMessageId: string; resolve: () => void }
export type ThreadSettings = { model?: string; effort?: string }
const TUI_BIND_TIMEOUT_MS = 10_000
const TUI_BIND_POLL_MS = 100
const ADMISSION_TIMEOUT_MS = 10_000
const ADDITIONAL_CONTEXT_PROBE_TIMEOUT_MS = 2_000
const CAPABILITY_THREAD_ID = 'codex-telegram-invalid-thread-id'
const CAPABILITY_TURN_ID = 'codex-telegram-invalid-turn-id'
const CAPABILITY_KEY = 'codex-telegram-capability-probe'
const CAPABILITY_KIND = 'codex-telegram-invalid-kind-probe'

/** A thin binding to the stock queue and its authoritative TUI thread notification. */
export class AppServerController {
  #rpc: AppServerTransport | undefined
  #attached = false
  #busy = false
  #activeTurnId: string | undefined
  #boundThreadId: string | undefined
  #pendingThread: PendingThread | undefined
  #pendingTurnStart: PendingTurnStart | undefined
  #unlisten: (() => void) | undefined
  #unclose: (() => void) | undefined
  #additionalContextCapable = false
  #resumePending = false
  #admissionInFlight = false
  #admissionUncertain = false

  constructor(rpc: AppServerTransport | undefined, private readonly releaseVersion: string, private readonly workspaceCwd: string, private readonly turnSteerCapable = false, private readonly admissionTimeoutMilliseconds = ADMISSION_TIMEOUT_MS, private readonly threadSettings: ThreadSettings = {}, additionalContextCapable = false, private readonly allowUnpersistedBinding = false) { this.#rpc = rpc; this.#additionalContextCapable = additionalContextCapable }

  async connect(): Promise<void> {
    const rpc = this.#requireRpc()
    this.disconnect(); this.#rpc = rpc
    await rpc.request('initialize', { clientInfo: { name: 'codex-telegram-channel', version: this.releaseVersion }, capabilities: { experimentalApi: true } })
    rpc.notify('initialized'); this.#additionalContextCapable = await supportsUntrustedAdditionalContext(rpc); this.#listen(rpc)
    this.#attached = true
  }
  async attach(rpc: AppServerTransport): Promise<void> { this.#rpc = rpc; await this.connect() }
  attachInitialized(rpc: AppServerTransport): void { this.disconnect(); this.#rpc = rpc; this.#listen(rpc); this.#attached = true }
  async awaitTuiThread(expectedThreadId?: string): Promise<string> {
    if (!this.#attached) throw new Error('cannot await a detached controller thread')
    if (this.#boundThreadId !== undefined) return this.#boundThreadId
    if (this.#pendingThread !== undefined) throw new Error('controller is already awaiting a TUI thread')
    return await new Promise<string>((resolve, reject) => {
      const pending = { expectedThreadId, resolve, reject }
      this.#pendingThread = pending
      if (expectedThreadId !== undefined) void this.#awaitLoadedTuiThread(this.#requireRpc(), expectedThreadId, pending)
    })
  }
  disconnect(): void { if (this.#admissionInFlight) this.#admissionUncertain = true; this.#unlisten?.(); this.#unclose?.(); this.#unlisten = undefined; this.#unclose = undefined; this.#pendingThread?.reject(new Error('App Server transport is detached')); this.#pendingThread = undefined; this.#pendingTurnStart = undefined; this.#attached = false; this.#busy = false; this.#activeTurnId = undefined; this.#boundThreadId = undefined; this.#rpc = undefined; this.#resumePending = false }

  async admit(origin: Origin, deliveryMode: TelegramDeliveryMode = 'auto'): Promise<{ duplicate: false; disposition: 'started' | 'queued' }> {
    if (!this.#attached || this.#boundThreadId === undefined || origin.route !== this.#boundThreadId) throw new Error('origin route is not the bound controller thread')
    if (this.#admissionUncertain) throw new AppServerAdmissionUncertainError('a prior stock admission is uncertain; explicit lifecycle reconciliation is required')
    if (this.#admissionInFlight) throw new Error('an App Server admission is already in progress')
    this.#admissionInFlight = true
    try {
      if (this.#resumePending) await this.#refreshUnpersistedBinding(origin.route)
      if (origin.source === 'peer' || (this.#busy && (deliveryMode === 'queue' || (deliveryMode === 'auto' && await this.#hasQueueBacklog(origin.route))))) {
        await this.#queue(origin)
        return { duplicate: false, disposition: 'queued' }
      }
      if (!this.#busy) return await this.#startIdle(origin)
      if (this.turnSteerCapable && this.#activeTurnId !== undefined) return await this.#steer(origin, this.#activeTurnId)
      await this.#queue(origin)
      return { duplicate: false, disposition: 'queued' }
    } finally { this.#admissionInFlight = false }
  }
  async admitPeer(origin: Omit<Origin, 'source'>): Promise<{ duplicate: false; disposition: 'queued' }> { const admitted = await this.admit({ ...origin, source: 'peer' }); return { ...admitted, disposition: 'queued' } }
  /** Read-only transition fence; no lifecycle event clears an uncertain admission. */
  /** A transition fence needs an observed idle root and an empty stock queue. */
  async isQuiescent(): Promise<boolean> {
    const rpc = this.#rpc; const threadId = this.#boundThreadId
    if (rpc === undefined || !this.#attached || threadId === undefined || this.#busy || this.#admissionInFlight || this.#pendingTurnStart !== undefined || this.#admissionUncertain) return false
    try {
      const result = await rpc.request('thread/queue/list', { threadId, limit: 1 })
      return this.#rpc === rpc && this.#attached && this.#boundThreadId === threadId && !this.#busy && !this.#admissionInFlight && this.#pendingTurnStart === undefined && !this.#admissionUncertain && record(result) && Array.isArray(result.data) && result.data.length === 0
    } catch { return false }
  }
  async #queue(origin: Origin): Promise<void> {
    const clientUserMessageId = origin.clientUserMessageId ?? origin.id
    const result = await this.#mutatingRequest('thread/queue/add', { threadId: origin.route, clientUserMessageId, input: input(origin) }, 'thread/queue/add')
    if (!queueReceipt(result, clientUserMessageId)) throw this.#uncertain('stock thread/queue/add acknowledgement is invalid')
  }
  async #hasQueueBacklog(threadId: string): Promise<boolean> {
    const result = await this.#requireRpc().request('thread/queue/list', { threadId, limit: 1 })
    if (!record(result) || !Array.isArray(result.data)) throw new Error('thread/queue/list returned an invalid response')
    return result.data.length > 0
  }
  async #startIdle(origin: Origin): Promise<{ duplicate: false; disposition: 'started' }> {
    this.#busy = true
    const clientUserMessageId = origin.clientUserMessageId ?? origin.id
    const pending: PendingTurnStart = { threadId: origin.route, clientUserMessageId, resolve: () => {} }
    const visible = new Promise<void>(resolve => { pending.resolve = resolve; this.#pendingTurnStart = pending })
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => { timeoutHandle = setTimeout(() => reject(new AppServerAdmissionUncertainError('stock turn/start admission timed out')), this.admissionTimeoutMilliseconds) })
    try {
      const response = this.#requireRpc().request('turn/start', { threadId: origin.route, clientUserMessageId, input: input(origin, this.#additionalContextCapable), ...additionalContext(origin, this.#additionalContextCapable) }).then(result => {
        if (!startReceipt(result)) throw new AppServerAdmissionUncertainError('stock turn/start acknowledgement is invalid')
      })
      await Promise.race([response, visible, timeout])
      return { duplicate: false, disposition: 'started' }
    } catch (error) {
      this.#busy = false
      throw this.#uncertain(error instanceof AppServerAdmissionUncertainError ? error.message : 'stock turn/start admission is uncertain')
    } finally { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); if (this.#pendingTurnStart === pending) this.#pendingTurnStart = undefined }
  }
  async #steer(origin: Origin, expectedTurnId: string): Promise<{ duplicate: false; disposition: 'started' | 'queued' }> {
    const clientUserMessageId = origin.clientUserMessageId ?? origin.id
    let result: unknown
    try { result = await this.#requestWithTimeout('turn/steer', { threadId: origin.route, expectedTurnId, clientUserMessageId, input: input(origin, this.#additionalContextCapable), ...additionalContext(origin, this.#additionalContextCapable) }, 'turn/steer') }
    catch (error) {
      if (isActiveTurnRace(error)) { await this.#queue(origin); return { duplicate: false, disposition: 'queued' } }
      throw this.#uncertain(error instanceof AppServerAdmissionUncertainError ? error.message : 'stock turn/steer admission is uncertain')
    }
    if (!steerReceipt(result, expectedTurnId)) throw this.#uncertain('stock turn/steer acknowledgement is invalid')
    return { duplicate: false, disposition: 'started' }
  }
  async #mutatingRequest(method: string, params: Record<string, unknown>, label: string): Promise<unknown> {
    try { return await this.#requestWithTimeout(method, params, label) }
    catch (error) { throw this.#uncertain(error instanceof AppServerAdmissionUncertainError ? error.message : `stock ${label} admission is uncertain`) }
  }
  async #requestWithTimeout(method: string, params: Record<string, unknown>, label: string): Promise<unknown> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => { timeoutHandle = setTimeout(() => reject(new AppServerAdmissionUncertainError(`stock ${label} admission timed out`)), this.admissionTimeoutMilliseconds) })
    try { return await Promise.race([this.#requireRpc().request(method, params), timeout]) }
    finally { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle) }
  }
  #uncertain(message: string): AppServerAdmissionUncertainError { this.#admissionUncertain = true; return new AppServerAdmissionUncertainError(message) }
  #listen(rpc: AppServerTransport): void {
    this.#unlisten = rpc.onNotification((method, params) => {
      if (method === 'thread/started' && this.#pendingThread !== undefined) {
        const thread = threadStarted(params)
        const pending = this.#pendingThread
        if (thread !== undefined && thread.cwd === this.workspaceCwd && (pending.expectedThreadId === undefined || pending.expectedThreadId === thread.id)) {
          this.#boundThreadId = thread.id; this.#pendingThread = undefined
          void this.#completeTuiBinding(rpc, thread.id, pending)
        }
      }
      if (params.threadId !== this.#boundThreadId) return
      if (method === 'turn/started') { this.#busy = true; this.#activeTurnId = turnId(params) }
      const pendingTurnStart = this.#pendingTurnStart
      if ((method === 'item/started' || method === 'item/completed') && pendingTurnStart !== undefined && pendingTurnStart.threadId === params.threadId && userMessageClientId(params) === pendingTurnStart.clientUserMessageId) { pendingTurnStart.resolve(); this.#pendingTurnStart = undefined }
      if (method === 'turn/completed' && turnId(params) === this.#activeTurnId) { this.#busy = false; this.#activeTurnId = undefined }
      if (method === 'thread/status/changed') {
        try { this.#busy = threadStatusIsActive(params.status); if (!this.#busy) this.#activeTurnId = undefined }
        catch { this.disconnect() }
      }
    })
    this.#unclose = rpc.onClose(error => this.disconnectWith(error))
  }
  async #completeTuiBinding(rpc: AppServerTransport, threadId: string, pending: PendingThread): Promise<void> {
    try {
      const resumed = await rpc.request('thread/resume', { threadId, excludeTurns: true }) as { thread?: { id?: string; cwd?: string; status?: unknown } }
      if (this.#rpc !== rpc || !this.#attached || this.#boundThreadId !== threadId) throw new Error('App Server transport detached while binding the TUI thread')
      if (resumed.thread?.id !== threadId || resumed.thread.cwd !== this.workspaceCwd) throw new Error('thread/resume returned a mismatched thread or cwd')
      if (this.threadSettings.model !== undefined || this.threadSettings.effort !== undefined) {
        const updated = await rpc.request('thread/settings/update', { threadId, ...this.threadSettings })
        validateThreadSettingsUpdate(updated, this.threadSettings)
        const observed = await rpc.request('thread/read', { threadId, includeTurns: false })
        validateThreadSettingsRead(observed, threadId, this.workspaceCwd, this.threadSettings)
      }
      this.#busy = this.#busy || threadStatusIsActive(resumed.thread.status)
      pending.resolve(threadId)
    } catch (error) {
      if (this.allowUnpersistedBinding && noRolloutYet(error, threadId)) {
        // A real, loaded empty TUI thread has no rollout until its first input.
        // Retain its verified identity; refresh live status before admission.
        this.#resumePending = true; pending.resolve(threadId); return
      }
      this.disconnect()
      pending.reject(error instanceof Error ? error : new Error('failed to bind the TUI thread'))
    }
  }
  async #refreshUnpersistedBinding(threadId: string): Promise<void> {
    const rpc = this.#requireRpc()
    const loaded = await rpc.request('thread/read', { threadId, includeTurns: false })
    const thread = record(loaded) && record(loaded.thread) ? loaded.thread : undefined
    if (thread?.id !== threadId || thread.cwd !== this.workspaceCwd) throw new Error('loaded host thread identity changed before admission')
    this.#busy = threadStatusIsActive(thread.status)
    try {
      const resumed = await rpc.request('thread/resume', { threadId, excludeTurns: true })
      const value = record(resumed) && record(resumed.thread) ? resumed.thread : undefined
      if (value?.id !== threadId || value.cwd !== this.workspaceCwd) throw new Error('thread/resume returned a mismatched thread or cwd')
      this.#busy = threadStatusIsActive(value.status); this.#resumePending = false
    } catch (error) { if (!noRolloutYet(error, threadId)) throw error }
  }
  async #awaitLoadedTuiThread(rpc: AppServerTransport, threadId: string, pending: PendingThread): Promise<void> {
    const deadline = Date.now() + TUI_BIND_TIMEOUT_MS
    try {
      while (this.#pendingThread === pending && this.#rpc === rpc && this.#attached) {
        const result = await rpc.request('thread/read', { threadId, includeTurns: false }) as { thread?: { id?: string; cwd?: string; status?: unknown } }
        if (this.#pendingThread !== pending) return
        if (result.thread?.id !== threadId || result.thread.cwd !== this.workspaceCwd) throw new Error('thread/read returned a mismatched thread or cwd')
        const status = threadStatus(result.thread.status)
        if (status === 'idle' || status === 'active') {
          this.#boundThreadId = threadId; this.#pendingThread = undefined
          await this.#completeTuiBinding(rpc, threadId, pending)
          return
        }
        if (status === 'systemError') throw new Error('TUI-owned thread entered systemError while binding')
        if (Date.now() >= deadline) throw new Error('timed out waiting for the TUI to resume its thread')
        await new Promise(resolve => setTimeout(resolve, TUI_BIND_POLL_MS))
      }
    } catch (error) {
      if (this.#pendingThread !== pending) return
      this.#pendingThread = undefined
      this.disconnect()
      pending.reject(error instanceof Error ? error : new Error('failed to observe the TUI thread'))
    }
  }
  disconnectWith(error: Error): void { const pending = this.#pendingThread; this.disconnect(); pending?.reject(error) }
  #requireRpc(): AppServerTransport { if (this.#rpc === undefined) throw new Error('App Server transport is detached'); return this.#rpc }
}

function input(origin: Origin, compact = false): Array<Record<string, unknown>> { return [{ type: 'text', text: compact && origin.source === 'telegram' && origin.displayText !== undefined ? origin.displayText : origin.text, text_elements: [] }, ...(origin.localImagePaths ?? (origin.localImagePath === undefined ? [] : [origin.localImagePath])).map(path => ({ type: 'localImage', path }))] }
function additionalContext(origin: Origin, enabled: boolean): Record<string, unknown> {
  return enabled && origin.source === 'telegram' && origin.displayText !== undefined ? { additionalContext: { [origin.id]: { kind: 'untrusted', value: origin.text } } } : {}
}

function threadStatusIsActive(value: unknown): boolean {
  const status = threadStatus(value)
  if (status === 'idle') return false
  if (status === 'active') return true
  throw new Error('thread state thread.status is unsupported or invalid')
}

function threadStatus(value: unknown): 'notLoaded' | 'idle' | 'systemError' | 'active' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('thread state omitted thread.status')
  const status = value as Record<string, unknown>
  if (status.type === 'notLoaded' || status.type === 'idle' || status.type === 'systemError') return status.type
  if (status.type === 'active' && Array.isArray(status.activeFlags) && status.activeFlags.every(flag => typeof flag === 'string')) return 'active'
  throw new Error('thread state thread.status is unsupported or invalid')
}

function isActiveTurnRace(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false
  if (error.code === -32601) return true
  if (activeTurnNotSteerable(error.data)) return true
  return error.code === -32603 && /^failed to submit turn input: ActiveTurnNotSteerable \{ turn_kind: (Review|Compact|Finalization) \}$/.test(error.message)
}

function activeTurnNotSteerable(data: unknown): boolean {
  if (!record(data)) return false
  const info = record(data.codexErrorInfo) ? data.codexErrorInfo : data
  return record(info) && record(info.activeTurnNotSteerable)
}

function threadStarted(params: Record<string, unknown>): { id: string; cwd: string } | undefined {
  const thread = params.thread
  if (typeof thread !== 'object' || thread === null || Array.isArray(thread)) return undefined
  const value = thread as Record<string, unknown>
  return typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.id) && typeof value.cwd === 'string' ? { id: value.id, cwd: value.cwd } : undefined
}
function userMessageClientId(params: Record<string, unknown>): string | undefined {
  const item = record(params.item) ? params.item : undefined
  if (item === undefined || item.type !== 'userMessage') return undefined
  const value = item.clientUserMessageId ?? item.client_user_message_id ?? item.clientId ?? item.client_id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
function turnId(params: Record<string, unknown>): string | undefined {
  const turn = record(params.turn) ? params.turn : undefined
  const value = turn?.id ?? params.turnId ?? params.turn_id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nonemptyId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function startReceipt(value: unknown): boolean { return record(value) && record(value.turn) && nonemptyId(value.turn.id) }
function steerReceipt(value: unknown, expectedTurnId: string): boolean { return record(value) && value.turnId === expectedTurnId }
function queueReceipt(value: unknown, clientUserMessageId: string): boolean { return record(value) && record(value.queuedSubmission) && nonemptyId(value.queuedSubmission.id) && value.queuedSubmission.clientUserMessageId === clientUserMessageId }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function noRolloutYet(error: unknown, threadId: string): boolean { return error instanceof AppServerRpcError && error.code === -32600 && error.message === `no rollout found for thread id ${threadId}` }

/** Bind exactly the host-owned thread after one initialization; never creates or selects a thread. */
export async function bindExactHostThread(rpc: AppServerTransport, releaseVersion: string, threadId: string, turnSteerCapable = true): Promise<{ controller: AppServerController; cwd: string }> {
  await rpc.request('initialize', { clientInfo: { name: 'codex-telegram-channel', version: releaseVersion }, capabilities: { experimentalApi: true } })
  rpc.notify('initialized')
  const additionalContextCapable = await supportsUntrustedAdditionalContext(rpc)
  const loaded = await rpc.request('thread/read', { threadId, includeTurns: false })
  const thread = record(loaded) && record(loaded.thread) ? loaded.thread : undefined
  if (thread?.id !== threadId || typeof thread.cwd !== 'string' || thread.cwd.length === 0 || (threadStatus(thread.status) !== 'idle' && threadStatus(thread.status) !== 'active')) throw new Error('thread/read did not return the requested loaded host thread')
  const controller = new AppServerController(rpc, releaseVersion, thread.cwd, turnSteerCapable, undefined, {}, additionalContextCapable, true)
  controller.attachInitialized(rpc)
  const bound = await controller.awaitTuiThread(threadId)
  if (bound !== threadId) { controller.disconnect(); throw new Error('host thread binding was mismatched') }
  return { controller, cwd: thread.cwd }
}

/** Detect only the typed parser recognition needed for same-request untrusted context. */
export async function supportsUntrustedAdditionalContext(rpc: AppServerTransport, timeoutMilliseconds = ADDITIONAL_CONTEXT_PROBE_TIMEOUT_MS): Promise<boolean> {
  const context = { [CAPABILITY_KEY]: { kind: CAPABILITY_KIND, value: '' } }
  const start = await parserRecognized(rpc, 'turn/start', { threadId: CAPABILITY_THREAD_ID, input: [], additionalContext: context }, timeoutMilliseconds)
  const steer = await parserRecognized(rpc, 'turn/steer', { threadId: CAPABILITY_THREAD_ID, expectedTurnId: CAPABILITY_TURN_ID, input: [], additionalContext: context }, timeoutMilliseconds)
  return start && steer
}

async function parserRecognized(rpc: AppServerTransport, method: 'turn/start' | 'turn/steer', params: Record<string, unknown>, timeoutMilliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('additional context capability probe timed out')), timeoutMilliseconds) })
    await Promise.race([rpc.request(method, params), timeout])
    return false
  } catch (error) { return recognizedAdditionalContextError(error) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

function recognizedAdditionalContextError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32600 && new RegExp('unknown variant `' + CAPABILITY_KIND + '`, expected .*`untrusted`').test(error.message)
}

function validateThreadSettingsUpdate(response: unknown, expected: ThreadSettings): void {
  if (!record(response)) throw new Error('thread/settings/update returned an invalid response')
  const settings = record(response.settings) ? response.settings : response
  if (expected.model !== undefined && 'model' in settings && settings.model !== expected.model) throw new Error('thread/settings/update returned a mismatched model')
  if (expected.effort !== undefined && 'effort' in settings && settings.effort !== expected.effort) throw new Error('thread/settings/update returned a mismatched effort')
}

function validateThreadSettingsRead(response: unknown, threadId: string, cwd: string, expected: ThreadSettings): void {
  const thread = record(response) && record(response.thread) ? response.thread : undefined
  if (thread?.id !== threadId || thread.cwd !== cwd) throw new Error('thread/settings/update verification returned a mismatched thread or cwd')
  if (expected.model !== undefined && thread.model !== expected.model) throw new Error('thread/settings/update verification returned a mismatched model')
  if (expected.effort !== undefined && thread.reasoningEffort !== expected.effort) throw new Error('thread/settings/update verification returned a mismatched effort')
}
