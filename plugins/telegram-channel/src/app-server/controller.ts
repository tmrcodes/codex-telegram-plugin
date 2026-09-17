import type { DeliveryMode } from '../policy/policy'
import { isRecord, type JsonObject, toError } from '../shared/guards'
import { AdmissionUncertainError, AppServerRpcError, type AppServerTransport, type Origin } from './transport'

const ADMISSION_TIMEOUT_MS = 10_000
const CAPABILITY_PROBE_TIMEOUT_MS = 2_000

export type Disposition = 'started' | 'queued'
type ThreadStatus = 'notLoaded' | 'idle' | 'systemError' | 'active'
type PendingTurnStart = { clientUserMessageId: string; resolve: () => void }

/**
 * Admits Telegram messages into one host-owned thread through the stock turn and queue API.
 * It never creates or selects a thread, and after an ambiguous admission it refuses further
 * work rather than risk delivering a message twice.
 */
export class ThreadController {
  #rpc: AppServerTransport | undefined
  #unlisten: (() => void) | undefined
  #unclose: (() => void) | undefined
  #busy = false
  #activeTurnId: string | undefined
  #pendingTurnStart: PendingTurnStart | undefined
  /** A loaded but still empty thread has no rollout yet; refresh its state before first use. */
  #resumePending = false
  #admissionInFlight = false
  #admissionUncertain = false

  private constructor(
    rpc: AppServerTransport,
    readonly threadId: string,
    readonly cwd: string,
    private readonly untrustedContextCapable: boolean,
    private readonly admissionTimeoutMs: number,
  ) {
    this.#rpc = rpc
  }

  /** Initializes this connection and binds exactly the named, already loaded thread. */
  static async bind(
    rpc: AppServerTransport,
    options: { clientVersion: string; threadId: string; admissionTimeoutMs?: number },
  ): Promise<ThreadController> {
    const { threadId } = options
    await rpc.request('initialize', {
      clientInfo: { name: 'codex-telegram-channel', version: options.clientVersion },
      capabilities: { experimentalApi: true },
    })
    rpc.notify('initialized')
    const untrustedContextCapable = await supportsUntrustedAdditionalContext(rpc)
    const thread = readThread(await rpc.request('thread/read', { threadId, includeTurns: false }))
    const status = thread === undefined ? undefined : threadStatus(thread.status)
    if (
      thread?.id !== threadId ||
      typeof thread.cwd !== 'string' ||
      thread.cwd === '' ||
      (status !== 'idle' && status !== 'active')
    ) {
      throw new Error('thread/read did not return the requested loaded host thread')
    }
    const controller = new ThreadController(
      rpc,
      threadId,
      thread.cwd,
      untrustedContextCapable,
      options.admissionTimeoutMs ?? ADMISSION_TIMEOUT_MS,
    )
    controller.#listen(rpc)
    try {
      await controller.#completeBinding(rpc)
    } catch (error) {
      controller.disconnect()
      throw toError(error, 'failed to bind the host thread')
    }
    return controller
  }

  disconnect(): void {
    if (this.#admissionInFlight) this.#admissionUncertain = true
    this.#unlisten?.()
    this.#unclose?.()
    this.#unlisten = undefined
    this.#unclose = undefined
    this.#pendingTurnStart = undefined
    this.#busy = false
    this.#activeTurnId = undefined
    this.#rpc = undefined
    this.#resumePending = false
  }

  /**
   * An idle thread starts a turn. A busy thread is steered or queued according to the delivery
   * mode; `auto` queues behind an existing backlog and steers otherwise.
   */
  async admit(origin: Origin, deliveryMode: DeliveryMode): Promise<Disposition> {
    if (this.#rpc === undefined) throw new Error('App Server transport is detached')
    if (origin.threadId !== this.threadId) throw new Error('message is not addressed to the bound thread')
    if (this.#admissionUncertain)
      throw new AdmissionUncertainError('a prior admission is uncertain; restart the session to reconcile it')
    if (this.#admissionInFlight) throw new Error('an App Server admission is already in progress')
    this.#admissionInFlight = true
    try {
      if (this.#resumePending) await this.#refreshUnpersistedBinding()
      if (this.#busy && (deliveryMode === 'queue' || (deliveryMode === 'auto' && (await this.#hasQueueBacklog())))) {
        await this.#queue(origin)
        return 'queued'
      }
      if (!this.#busy) return await this.#startIdle(origin)
      if (this.#activeTurnId !== undefined) return await this.#steer(origin, this.#activeTurnId)
      await this.#queue(origin)
      return 'queued'
    } finally {
      this.#admissionInFlight = false
    }
  }

  /** True only for an observed idle thread with an empty queue and no admission in doubt. */
  async isQuiescent(): Promise<boolean> {
    const rpc = this.#rpc
    const settled = () =>
      this.#rpc === rpc &&
      rpc !== undefined &&
      !this.#busy &&
      !this.#admissionInFlight &&
      this.#pendingTurnStart === undefined &&
      !this.#admissionUncertain
    if (rpc === undefined || !settled()) return false
    try {
      const result = await rpc.request('thread/queue/list', { threadId: this.threadId, limit: 1 })
      return settled() && isRecord(result) && Array.isArray(result.data) && result.data.length === 0
    } catch {
      return false
    }
  }

  // ---- admission ---------------------------------------------------------------------------

  async #startIdle(origin: Origin): Promise<Disposition> {
    this.#busy = true
    const pending: PendingTurnStart = { clientUserMessageId: origin.clientUserMessageId, resolve: () => {} }
    // The user message becoming visible in the thread proves admission even if the RPC reply is lost.
    const visible = new Promise<void>(resolve => {
      pending.resolve = resolve
      this.#pendingTurnStart = pending
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AdmissionUncertainError('turn/start admission timed out')),
        this.admissionTimeoutMs,
      )
    })
    try {
      const acknowledged = this.#requireRpc()
        .request('turn/start', {
          threadId: origin.threadId,
          clientUserMessageId: origin.clientUserMessageId,
          input: this.#input(origin),
          ...this.#additionalContext(origin),
        })
        .then(result => {
          if (!isRecord(result) || !isRecord(result.turn) || !nonEmptyString(result.turn.id))
            throw new AdmissionUncertainError('turn/start acknowledgement is invalid')
        })
      await Promise.race([acknowledged, visible, timeout])
      return 'started'
    } catch (error) {
      this.#busy = false
      throw this.#uncertain(
        error instanceof AdmissionUncertainError ? error.message : 'turn/start admission is uncertain',
      )
    } finally {
      clearTimeout(timer)
      if (this.#pendingTurnStart === pending) this.#pendingTurnStart = undefined
    }
  }

  async #steer(origin: Origin, expectedTurnId: string): Promise<Disposition> {
    let result: unknown
    try {
      result = await this.#requestWithTimeout('turn/steer', {
        threadId: origin.threadId,
        expectedTurnId,
        clientUserMessageId: origin.clientUserMessageId,
        input: this.#input(origin),
        ...this.#additionalContext(origin),
      })
    } catch (error) {
      // The turn ended or cannot be steered: the message was provably not admitted, so queue it.
      if (isActiveTurnRace(error)) {
        await this.#queue(origin)
        return 'queued'
      }
      throw this.#uncertain(
        error instanceof AdmissionUncertainError ? error.message : 'turn/steer admission is uncertain',
      )
    }
    if (!isRecord(result) || result.turnId !== expectedTurnId)
      throw this.#uncertain('turn/steer acknowledgement is invalid')
    return 'started'
  }

  async #queue(origin: Origin): Promise<void> {
    let result: unknown
    try {
      result = await this.#requestWithTimeout('thread/queue/add', {
        threadId: origin.threadId,
        clientUserMessageId: origin.clientUserMessageId,
        input: this.#input(origin, false),
      })
    } catch (error) {
      throw this.#uncertain(
        error instanceof AdmissionUncertainError ? error.message : 'thread/queue/add admission is uncertain',
      )
    }
    const queued = isRecord(result) && isRecord(result.queuedSubmission) ? result.queuedSubmission : undefined
    if (
      queued === undefined ||
      !nonEmptyString(queued.id) ||
      queued.clientUserMessageId !== origin.clientUserMessageId
    ) {
      throw this.#uncertain('thread/queue/add acknowledgement is invalid')
    }
  }

  async #hasQueueBacklog(): Promise<boolean> {
    const result = await this.#requireRpc().request('thread/queue/list', { threadId: this.threadId, limit: 1 })
    if (!isRecord(result) || !Array.isArray(result.data))
      throw new Error('thread/queue/list returned an invalid response')
    return result.data.length > 0
  }

  async #requestWithTimeout(method: string, params: JsonObject): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AdmissionUncertainError(`${method} admission timed out`)),
        this.admissionTimeoutMs,
      )
    })
    try {
      return await Promise.race([this.#requireRpc().request(method, params), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  #uncertain(message: string): AdmissionUncertainError {
    this.#admissionUncertain = true
    return new AdmissionUncertainError(message)
  }

  /**
   * Hosts that accept same-request context show a short preview as the user message; the full
   * channel block travels as untrusted context and the plugin's guidance as application context,
   * which the host gives to the model as a developer note. Other hosts, and the queue, get the
   * block and the guidance inline.
   */
  #input(origin: Origin, compact = this.untrustedContextCapable): JsonObject[] {
    return [
      { type: 'text', text: compact ? origin.displayText : `${origin.text}\n\n${origin.guidance}`, text_elements: [] },
      ...origin.localImagePaths.map(path => ({ type: 'localImage', path })),
    ]
  }

  /** The keys become tag names in the model's context, so they carry no chat or message ID. */
  #additionalContext(origin: Origin): JsonObject {
    if (!this.untrustedContextCapable) return {}
    return {
      additionalContext: {
        'channel-message': { kind: 'untrusted', value: origin.text },
        'channel-guidance': { kind: 'application', value: origin.guidance },
      },
    }
  }

  // ---- thread state ------------------------------------------------------------------------

  #listen(rpc: AppServerTransport): void {
    this.#unlisten = rpc.onNotification((method, params) => {
      if (params.threadId !== this.threadId) return
      if (method === 'turn/started') {
        this.#busy = true
        this.#activeTurnId = turnId(params)
      }
      const pending = this.#pendingTurnStart
      if (
        (method === 'item/started' || method === 'item/completed') &&
        pending !== undefined &&
        userMessageClientId(params) === pending.clientUserMessageId
      ) {
        pending.resolve()
        this.#pendingTurnStart = undefined
      }
      if (method === 'turn/completed' && turnId(params) === this.#activeTurnId) {
        this.#busy = false
        this.#activeTurnId = undefined
      }
      if (method === 'thread/status/changed') {
        try {
          this.#busy = threadStatusIsActive(params.status)
          if (!this.#busy) this.#activeTurnId = undefined
        } catch {
          this.disconnect()
        }
      }
    })
    this.#unclose = rpc.onClose(() => this.disconnect())
  }

  async #completeBinding(rpc: AppServerTransport): Promise<void> {
    try {
      const thread = readThread(await rpc.request('thread/resume', { threadId: this.threadId, excludeTurns: true }))
      if (this.#rpc !== rpc) throw new Error('App Server transport detached while binding the thread')
      if (thread?.id !== this.threadId || thread.cwd !== this.cwd)
        throw new Error('thread/resume returned a mismatched thread or cwd')
      this.#busy = this.#busy || threadStatusIsActive(thread.status)
    } catch (error) {
      // A loaded, still empty thread has no rollout until its first input. Keep the verified
      // identity and refresh the live status right before the first admission.
      if (!noRolloutYet(error, this.threadId)) throw error
      this.#resumePending = true
    }
  }

  async #refreshUnpersistedBinding(): Promise<void> {
    const rpc = this.#requireRpc()
    const thread = readThread(await rpc.request('thread/read', { threadId: this.threadId, includeTurns: false }))
    if (thread?.id !== this.threadId || thread.cwd !== this.cwd)
      throw new Error('loaded host thread identity changed before admission')
    this.#busy = threadStatusIsActive(thread.status)
    try {
      const resumed = readThread(await rpc.request('thread/resume', { threadId: this.threadId, excludeTurns: true }))
      if (resumed?.id !== this.threadId || resumed.cwd !== this.cwd)
        throw new Error('thread/resume returned a mismatched thread or cwd')
      this.#busy = threadStatusIsActive(resumed.status)
      this.#resumePending = false
    } catch (error) {
      if (!noRolloutYet(error, this.threadId)) throw error
    }
  }

  #requireRpc(): AppServerTransport {
    if (this.#rpc === undefined) throw new Error('App Server transport is detached')
    return this.#rpc
  }
}

/**
 * Detects whether the host parses same-request context of both kinds this plugin uses. The probe
 * is a request that can never succeed (invalid thread and an unknown context kind); only the
 * parser's complaint that names `untrusted` and `application` as known kinds proves support.
 */
export async function supportsUntrustedAdditionalContext(
  rpc: AppServerTransport,
  timeoutMs = CAPABILITY_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const kind = 'codex-telegram-invalid-kind-probe'
  const context = { 'codex-telegram-capability-probe': { kind, value: '' } }
  const threadId = 'codex-telegram-invalid-thread-id'
  const recognized = async (method: string, params: JsonObject): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('additional context capability probe timed out')), timeoutMs)
    })
    try {
      await Promise.race([rpc.request(method, params), timeout])
      return false
    } catch (error) {
      return (
        error instanceof AppServerRpcError &&
        error.code === -32600 &&
        new RegExp('unknown variant `' + kind + '`, expected ').test(error.message) &&
        error.message.includes('`untrusted`') &&
        error.message.includes('`application`')
      )
    } finally {
      clearTimeout(timer)
    }
  }
  const start = await recognized('turn/start', { threadId, input: [], additionalContext: context })
  const steer = await recognized('turn/steer', {
    threadId,
    expectedTurnId: 'codex-telegram-invalid-turn-id',
    input: [],
    additionalContext: context,
  })
  return start && steer
}

function readThread(response: unknown): JsonObject | undefined {
  return isRecord(response) && isRecord(response.thread) ? response.thread : undefined
}

function threadStatus(value: unknown): ThreadStatus {
  if (!isRecord(value)) throw new Error('thread state omitted thread.status')
  if (value.type === 'notLoaded' || value.type === 'idle' || value.type === 'systemError') return value.type
  if (
    value.type === 'active' &&
    Array.isArray(value.activeFlags) &&
    value.activeFlags.every(flag => typeof flag === 'string')
  )
    return 'active'
  throw new Error('thread state thread.status is unsupported or invalid')
}

function threadStatusIsActive(value: unknown): boolean {
  const status = threadStatus(value)
  if (status === 'idle') return false
  if (status === 'active') return true
  throw new Error('thread state thread.status is unsupported or invalid')
}

/** Steering lost a race with the end of the turn, or the turn kind cannot be steered. */
function isActiveTurnRace(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false
  if (error.code === -32601) return true
  const data = isRecord(error.data) ? error.data : undefined
  const info = data !== undefined && isRecord(data.codexErrorInfo) ? data.codexErrorInfo : data
  if (info !== undefined && isRecord(info.activeTurnNotSteerable)) return true
  return (
    error.code === -32603 &&
    /^failed to submit turn input: ActiveTurnNotSteerable \{ turn_kind: (Review|Compact|Finalization) \}$/.test(
      error.message,
    )
  )
}

function noRolloutYet(error: unknown, threadId: string): boolean {
  return (
    error instanceof AppServerRpcError &&
    error.code === -32600 &&
    error.message === `no rollout found for thread id ${threadId}`
  )
}

function userMessageClientId(params: JsonObject): string | undefined {
  const item = isRecord(params.item) ? params.item : undefined
  if (item === undefined || item.type !== 'userMessage') return undefined
  const value = item.clientUserMessageId ?? item.client_user_message_id ?? item.clientId ?? item.client_id
  return nonEmptyString(value) ? value : undefined
}

function turnId(params: JsonObject): string | undefined {
  const turn = isRecord(params.turn) ? params.turn : undefined
  const value = turn?.id ?? params.turnId ?? params.turn_id
  return nonEmptyString(value) ? value : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
