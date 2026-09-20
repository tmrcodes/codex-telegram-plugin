import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ApprovalRelay } from '../app-server/approvals'
import { ThreadController } from '../app-server/controller'
import { type AppServerTransport, SERVER_REQUEST_CANCELLED } from '../app-server/transport'
import { UnixWebSocketTransport } from '../app-server/unix-websocket'
import { TelegramPolicySource } from '../policy/policy'
import { hasControlCharacters, type JsonObject } from '../shared/guards'
import { privateDirectory, privateSocket, readPrivateText } from '../shared/private-fs'
import { type TelegramApi, TelegramBotApi, telegramStatus } from '../telegram/bot-api'
import { TelegramChannel, type TelegramChannelOptions } from '../telegram/channel'
import { parseToolRequest, safeToolError } from '../telegram/tools'
import { VERSION } from '../version'
import { type BridgeTarget, callOwnerBridge, type HandoffRequest, OwnerBridge, type ToolCall } from './bridge'
import { HealthFile } from './health'
import { acquireOwnerLease, type OwnerLease } from './lease'
import { acquireOwnerLock, type OwnerLock, processAlive, readLiveOwner } from './lock'

export type OwnerConfig = {
  appServerSocket: string
  botTokenFile: string
  policyFile: string
  stateDir: string
  codexHome: string
}
export type StartStage =
  | 'preflight-profile-validation'
  | 'telegram-bot-identity-check'
  | 'cooperative-old-owner-release'
  | 'new-owner-connect'
  | 'owner-bridge-setup'

type ClosableTransport = AppServerTransport & { close(): void }
type Relay = Pick<ApprovalRelay, 'callback' | 'install' | 'isQuiescent' | 'request' | 'resolved'>
type HostLink = {
  controller: ThreadController
  transport: ClosableTransport
  relay: Relay
  closeRelay: () => Promise<void>
  unobserve: () => void
}

/** Seams for tests; production uses the defaults. */
export type OwnerDependencies = {
  connectTransport?: (socketPath: string) => Promise<ClosableTransport>
  createApi?: (token: string) => TelegramApi
  bindThread?: typeof ThreadController.bind
  processAlive?: (pid: number) => boolean
  acquireLease?: (botUserId: string, stateDir: string) => OwnerLease
  createChannel?: (options: TelegramChannelOptions) => TelegramChannel
  createRelay?: (
    transport: AppServerTransport,
    api: TelegramApi,
    policy: TelegramPolicySource,
    threadId: string,
  ) => Relay
  /** This session gave its channel to a newer launch of the same profile. */
  onSessionHandoff?: () => void
  onStartStageFailure?: (stage: StartStage) => void
}

type Active = HostLink & {
  threadId: string
  profile: string
  api: TelegramApi
  botId: string
  channel: TelegramChannel
  health: HealthFile
  policy: TelegramPolicySource
  lock: OwnerLock
  workspaceRoot: string
  stopped: boolean
  close: () => Promise<void>
}

const CLOSED = 'Telegram owner is closed'

/**
 * The single Telegram owner of one launch: it holds the bot token, the poller, the approval relay
 * and the binding to the visible thread. Per-thread MCP servers and newer launches of the same
 * profile reach it only through the private bridge.
 */
export class SessionOwner implements BridgeTarget {
  #active: Active | undefined
  #starting: Promise<void> | undefined
  #closing: Promise<void> | undefined
  #closed = false
  #transitioning = false
  #preparedFrom: string | undefined
  #bridge: OwnerBridge | undefined
  #handedOff = false
  #handoffPending = false
  #initialOffset = 0

  constructor(
    private readonly config: OwnerConfig,
    private readonly dependencies: OwnerDependencies = {},
  ) {}

  /** Launcher startup: take over from an older session of this profile if there is one, then own the channel. */
  start(threadId: string, bridgePath: string): Promise<void> {
    if (this.#starting !== undefined || this.#active !== undefined)
      return Promise.reject(new Error('Telegram owner is already started'))
    const starting = (async () => {
      await this.#takeOverFromPreviousOwner()
      await this.#stage('new-owner-connect', () => this.#connect(threadId))
      await this.#stage('owner-bridge-setup', () => this.#startBridge(bridgePath))
    })()
    // `close` waits for a start in flight, so nothing is left half-acquired behind it.
    this.#starting = starting
    const settled = () => {
      if (this.#starting === starting) this.#starting = undefined
    }
    void starting.then(settled, settled)
    return starting
  }

  // ---- tool calls from MCP servers ---------------------------------------------------------

  async executeTool(call: ToolCall): Promise<JsonObject> {
    const active = this.#active
    if (active === undefined || active.stopped || this.#transitioning)
      throw new Error('Telegram channel is not connected')
    try {
      const request = parseToolRequest(call.tool, call.arguments)
      if (call.threadId === active.threadId) return await active.channel.executeTool(request)
      // A server spawned for an earlier thread of this launch may still answer its own messages.
      // Its thread metadata is not authority by itself: the call succeeds only with a handle
      // signed for exactly that thread, within its expiry and under the live access policy.
      return await active.channel.executeRetainedTool(threadProfile(call.threadId), request)
    } catch (error) {
      throw new Error(safeToolError(error))
    }
  }

  /**
   * An approval request the TUI proxy saw on its way to the terminal. The host addresses such a
   * request to one client only, so the proxy offers every one to the bound thread's relay as well.
   * Resolves undefined when the relay does not answer and the terminal keeps it.
   */
  async offerApproval(request: {
    id: string | number
    method: string
    params: JsonObject
  }): Promise<JsonObject | undefined> {
    const active = this.#active
    if (active === undefined || active.stopped) return undefined
    const result = await active.relay.request(request.id, request.method, request.params)
    return result === SERVER_REQUEST_CANCELLED ? undefined : result
  }

  /** The terminal answered first; the card for that request is stale. */
  approvalResolved(id: string | number): void {
    this.#active?.relay.resolved(id)
  }

  // ---- thread transitions (/new, /resume, fork) --------------------------------------------

  /** Fences the channel before the visible thread changes; refuses while anything is in flight. */
  async prepareThreadTransition(fromThreadId: string): Promise<void> {
    const active = this.#active
    if (active === undefined || active.stopped || this.#closed) throw new Error('Telegram owner is not connected')
    if (active.threadId !== fromThreadId) throw new Error('Telegram owner is bound to a different host thread')
    if (this.#transitioning) throw new Error('Telegram owner transition is already in progress')
    // Do not fence a usable thread merely to discover an active turn or a queued submission.
    // The second check below closes the race once draining has established the fence.
    if (!(await active.controller.isQuiescent()))
      throw new Error('Telegram owner is not quiescent for a thread transition')
    this.#transitioning = true
    try {
      await active.channel.pauseAndDrain()
      if (!active.channel.isQuiescent() || !(await active.controller.isQuiescent()) || !active.relay.isQuiescent()) {
        throw new Error('Telegram owner is not quiescent for a thread transition')
      }
      this.#preparedFrom = fromThreadId
    } catch (error) {
      active.channel.resume()
      this.#transitioning = false
      throw error
    }
  }

  /** Rebinds the fenced channel to the thread the host actually created, then resumes polling. */
  async commitThreadTransition(threadId: string): Promise<void> {
    const active = this.#active
    if (active === undefined || this.#closed || !this.#transitioning || this.#preparedFrom !== active.threadId)
      throw new Error('Telegram owner transition is not prepared')
    if (active.threadId === threadId) {
      await this.abortThreadTransition(active.threadId)
      return
    }
    let next: HostLink | undefined
    try {
      next = await this.#linkHost(threadId, active.api, active.policy)
      if (next.controller.cwd !== active.workspaceRoot)
        throw new Error('Telegram thread transition changed the bound workspace')
      const link = next
      active.channel.rebind(
        threadId,
        threadProfile(threadId),
        async (origin, mode) => {
          await link.controller.admit(origin, mode)
        },
        query => link.relay.callback(query),
      )
      const previous: HostLink = {
        controller: active.controller,
        transport: active.transport,
        relay: active.relay,
        closeRelay: active.closeRelay,
        unobserve: active.unobserve,
      }
      Object.assign(active, link, { threadId, profile: threadProfile(threadId) })
      next = undefined
      try {
        await unlinkHost(previous)
      } catch (error) {
        reportHealth(active, false, error)
      }
      active.channel.resume()
      this.#preparedFrom = undefined
      this.#transitioning = false
    } finally {
      if (next !== undefined) await unlinkHost(next).catch(() => {})
    }
  }

  async abortThreadTransition(fromThreadId: string): Promise<void> {
    const active = this.#active
    if (!this.#transitioning) return
    if (active === undefined || this.#preparedFrom !== fromThreadId || active.threadId !== fromThreadId)
      throw new Error('Telegram owner transition does not match its prepared root')
    active.channel.resume()
    this.#preparedFrom = undefined
    this.#transitioning = false
  }

  // ---- session handoff ---------------------------------------------------------------------

  /** Asked by a newer launch of the same profile: drain, stop polling and report the next update offset. */
  async handoff(request: HandoffRequest): Promise<JsonObject> {
    const active = this.#active
    if (
      active === undefined ||
      this.#closed ||
      this.#handedOff ||
      this.#handoffPending ||
      request.nonce !== active.lock.nonce ||
      request.profile !== this.#sessionProfile() ||
      request.botId !== active.botId
    )
      throw new Error('Telegram handoff does not match the live owner')
    this.#handoffPending = true
    try {
      await this.prepareThreadTransition(active.threadId)
      if (this.#closed || this.#active !== active) throw new Error('Telegram owner is closing')
      const nextOffset = active.channel.adapter.handoffOffset()
      this.#handedOff = true
      this.#active = undefined
      // The bridge stays up long enough to return this receipt; it now refuses tool calls,
      // and the launcher removes it on exit.
      await active.close()
      try {
        this.dependencies.onSessionHandoff?.()
      } catch {
        /* a notification is not authority */
      }
      return { released: true, nonce: request.nonce, nextOffset }
    } catch (error) {
      if (!this.#handedOff && !this.#closed) await this.abortThreadTransition(active.threadId)
      throw error
    } finally {
      this.#handoffPending = false
    }
  }

  async #takeOverFromPreviousOwner(): Promise<void> {
    const previous = await this.#stage('preflight-profile-validation', async () => {
      if (this.#closed || this.#handedOff) throw new Error(CLOSED)
      const owner = readLiveOwner(this.#lockPath(), this.dependencies.processAlive ?? processAlive)
      if (owner === undefined) return undefined
      if (owner.offer === undefined || owner.offer.profile !== this.#sessionProfile()) {
        throw new Error(
          'Telegram profile already has an incompatible live owner; close that session before relaunching',
        )
      }
      privateDirectory(dirname(owner.offer.path), 'Telegram owner bridge directory')
      privateSocket(owner.offer.path, 'Telegram owner bridge socket')
      return { nonce: owner.nonce, offer: owner.offer }
    })
    if (previous === undefined) return
    // Prove the new credential before asking a working owner to step aside.
    await this.#stage('telegram-bot-identity-check', async () => {
      const identity = await this.#createApi(this.#readToken()).getMe(AbortSignal.timeout(10_000))
      if (!Number.isSafeInteger(identity.id) || identity.id < 1 || String(identity.id) !== previous.offer.botId) {
        throw new Error('Telegram handoff bot identity does not match this profile')
      }
    })
    this.#initialOffset = await this.#stage('cooperative-old-owner-release', async () => {
      if (this.#closed) throw new Error(CLOSED)
      const { nonce, offer } = previous
      const receipt = await callOwnerBridge(offer.path, {
        operation: 'handoff',
        nonce,
        profile: offer.profile,
        botId: offer.botId,
      })
      const { nextOffset } = receipt
      if (
        receipt.released !== true ||
        receipt.nonce !== nonce ||
        typeof nextOffset !== 'number' ||
        !Number.isSafeInteger(nextOffset) ||
        nextOffset < 0
      ) {
        throw new Error('Telegram handoff receipt is invalid')
      }
      return nextOffset
    })
  }

  /** Two launches are the same profile only if they share state, policy, token file and Codex home. */
  #sessionProfile(): string {
    const { stateDir, policyFile, botTokenFile, codexHome } = this.config
    return createHash('sha256')
      .update(JSON.stringify([stateDir, policyFile, botTokenFile, codexHome]))
      .digest('hex')
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#closed = true
      // A start in flight notices `#closed` at its next step and unwinds; its caller gets the error.
      await this.#starting?.catch(() => {})
      const active = this.#active
      this.#active = undefined
      let firstError: unknown
      const attempt = async (action: () => Promise<void>) => {
        try {
          await action()
        } catch (error) {
          firstError ??= error
        }
      }
      await attempt(async () => {
        await this.#bridge?.close()
        this.#bridge = undefined
      })
      await attempt(async () => {
        await active?.close()
      })
      if (firstError !== undefined) throw firstError
    })()
    return this.#closing
  }

  async #connect(threadId: string): Promise<void> {
    this.#assertOpen()
    const { config } = this
    const lock = acquireOwnerLock(this.#lockPath(), this.dependencies.processAlive ?? processAlive)
    const health = new HealthFile(join(config.stateDir, 'health.json'))
    const policy = new TelegramPolicySource(config.policyFile)
    try {
      health.start(policy.read().fingerprint)
    } catch (error) {
      quietly(() => health.invalidPolicy(safeToolError(error)))
      quietly(() => health.stop())
      lock.release()
      throw new Error(safeToolError(error))
    }

    let link: HostLink | undefined
    let active: Active | undefined
    let channel: TelegramChannel | undefined
    let lease: OwnerLease | undefined
    let launchInbox: string | undefined
    let cleanup: Promise<void> | undefined
    const close = (): Promise<void> =>
      (cleanup ??= (async () => {
        let firstError: unknown
        const attempt = async (action: () => void | Promise<void>) => {
          try {
            await action()
          } catch (error) {
            firstError ??= error
          }
        }
        await attempt(async () => {
          await channel?.closeAndDrain()
        })
        await attempt(() => {
          health.stop()
        })
        // A thread transition replaces the host link inside `active`; always retire the current one.
        const current: HostLink | undefined = active ?? link
        await attempt(async () => {
          await current?.closeRelay()
        })
        if (launchInbox !== undefined) {
          // Downloaded files may still be referenced by a queued or running turn; remove them
          // only when the host is provably idle, otherwise keep them.
          let safeToRemove = channel === undefined
          if (!safeToRemove && current !== undefined)
            safeToRemove = await current.controller.isQuiescent().catch(() => false)
          if (safeToRemove)
            await attempt(() => {
              rmSync(launchInbox!, { recursive: true, force: true })
            })
        }
        await attempt(() => {
          current?.controller.disconnect()
        })
        await attempt(() => {
          current?.transport.close()
        })
        await attempt(() => {
          current?.unobserve()
        })
        await attempt(() => {
          lease?.release()
        })
        await attempt(() => {
          lock.release()
        })
        if (firstError !== undefined) throw firstError
      })())

    try {
      this.#assertOpen()
      const token = this.#readToken()
      const api = this.#createApi(token)
      link = await this.#linkHost(threadId, api, policy, { deferRelay: true })
      this.#assertOpen()
      const workspaceRoot = link.controller.cwd

      const inbox = join(config.stateDir, 'inbox')
      mkdirSync(inbox, { recursive: true, mode: 0o700 })
      privateDirectory(inbox, 'Telegram inbox')
      launchInbox = mkdtempSync(join(inbox, 'launch-'))
      privateDirectory(launchInbox, 'Telegram launch inbox')

      const identity = await api.getMe()
      if (!Number.isSafeInteger(identity.id) || identity.id < 1) throw new Error('Telegram bot identity is invalid')
      const botId = String(identity.id)
      lease = (this.dependencies.acquireLease ?? acquireOwnerLease)(botId, config.stateDir)
      this.#assertOpen()
      link.closeRelay = link.relay.install()
      this.#assertOpen()

      const profile = threadProfile(threadId)
      const owned: Active = {
        ...link,
        threadId,
        profile,
        api,
        botId,
        health,
        policy,
        lock,
        workspaceRoot,
        stopped: false,
        close,
        channel: undefined as never,
      }
      channel = (this.dependencies.createChannel ?? (options => new TelegramChannel(options)))({
        api,
        policy,
        threadId,
        profile,
        handleKey: randomBytes(32).toString('base64url'),
        workspaceRoot,
        inboxRoot: launchInbox,
        initialOffset: this.#initialOffset,
        // `owned` is read at call time: after a thread transition it carries the new host link.
        admit: async (origin, mode) => {
          await owned.controller.admit(origin, mode)
        },
        onCallback: query => owned.relay.callback(query),
        onHealth: (ok, error) => reportHealth(owned, ok, error),
      })
      owned.channel = channel
      active = owned
      this.#assertOpen()
      this.#active = owned
      const stopped = () => {
        owned.stopped = true
        quietly(() => health.stop())
      }
      void channel.poll().then(stopped, stopped)
    } catch (error) {
      quietly(() => health.failure(safeToolError(error), telegramStatus(error)))
      let cleanupError: unknown
      try {
        await close()
      } catch (failure) {
        cleanupError = failure
      }
      throw cleanupError ?? (error instanceof Error ? error : new Error('Telegram connection failed'))
    }
  }

  /** Opens a dedicated App Server connection bound to one thread, with its approval relay. */
  async #linkHost(
    threadId: string,
    api: TelegramApi,
    policy: TelegramPolicySource,
    options: { deferRelay?: boolean } = {},
  ): Promise<HostLink> {
    const transport = await (this.dependencies.connectTransport ?? UnixWebSocketTransport.connect)(
      this.config.appServerSocket,
    )
    // Approval requests belong to the visible client. This connection never answers one by
    // accident: without an accepting listener a request stays open for the native UI.
    const unobserve = transport.onServerRequest(async () => SERVER_REQUEST_CANCELLED)
    let controller: ThreadController | undefined
    let closeRelay: (() => Promise<void>) | undefined
    try {
      if (this.#closed) throw new Error(CLOSED)
      controller = await (this.dependencies.bindThread ?? ThreadController.bind)(transport, {
        clientVersion: VERSION,
        threadId,
      })
      if (this.#closed) throw new Error(CLOSED)
      const relay = (
        this.dependencies.createRelay ?? ((rpc, bot, source, id) => new ApprovalRelay(rpc, bot, source, id))
      )(transport, api, policy, threadId)
      closeRelay = options.deferRelay ? async () => {} : relay.install()
      return { controller, transport, relay, closeRelay, unobserve }
    } catch (error) {
      await closeRelay?.().catch(() => {})
      controller?.disconnect()
      transport.close()
      unobserve()
      throw error
    }
  }

  async #startBridge(path: string): Promise<void> {
    const active = this.#active
    if (active === undefined) throw new Error('Telegram owner is not connected')
    const bridge = new OwnerBridge(path, this)
    await bridge.start()
    if (this.#closed) {
      await bridge.close()
      throw new Error(CLOSED)
    }
    this.#bridge = bridge
    active.lock.publish({ path, profile: this.#sessionProfile(), botId: active.botId })
  }

  async #stage<T>(stage: StartStage, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch {
      try {
        this.dependencies.onStartStageFailure?.(stage)
      } catch {
        /* diagnostics are not authority */
      }
      throw new Error(START_STAGE_ERRORS[stage])
    }
  }

  #lockPath(): string {
    return join(this.config.stateDir, 'owner.lock')
  }

  #readToken(): string {
    const token = readPrivateText(this.config.botTokenFile, 'Telegram bot token')
    if (Array.from(token).length > 512 || hasControlCharacters(token)) throw new Error('Telegram bot token is invalid')
    return token
  }

  #createApi(token: string): TelegramApi {
    return (this.dependencies.createApi ?? (value => new TelegramBotApi(value)))(token)
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(CLOSED)
  }
}

/** Provider details are withheld on purpose; the stage name is enough to act on. */
const START_STAGE_ERRORS: Record<StartStage, string> = {
  'preflight-profile-validation': 'Telegram owner startup failed during profile validation',
  'telegram-bot-identity-check': 'Telegram owner startup failed during bot identity check',
  'cooperative-old-owner-release':
    'Telegram handoff refused during cooperative old-owner release; no second poller was started',
  'new-owner-connect': 'Telegram owner startup failed during new owner connect; no second poller was started',
  'owner-bridge-setup': 'Telegram owner startup failed during owner bridge setup; no second poller was started',
}

/** Signing namespace of a thread: handles issued for one thread never verify for another. */
function threadProfile(threadId: string): string {
  return `thread-${createHash('sha256').update(threadId).digest('hex').slice(0, 32)}`
}

async function unlinkHost(link: HostLink): Promise<void> {
  let firstError: unknown
  const attempt = async (action: () => void | Promise<void>) => {
    try {
      await action()
    } catch (error) {
      firstError ??= error
    }
  }
  await attempt(link.closeRelay)
  await attempt(() => {
    link.controller.disconnect()
  })
  await attempt(() => {
    link.transport.close()
  })
  await attempt(link.unobserve)
  if (firstError !== undefined) throw firstError
}

function reportHealth(active: Pick<Active, 'health' | 'policy'>, ok: boolean, error?: unknown): void {
  quietly(() => {
    let fingerprint: string
    try {
      fingerprint = active.policy.read().fingerprint
    } catch (policyError) {
      active.health.invalidPolicy(safeToolError(policyError))
      return
    }
    if (ok) active.health.success(fingerprint)
    else active.health.failure(safeToolError(error), telegramStatus(error), fingerprint)
  })
}

/** Health reporting must never affect polling, shutdown or the host. */
function quietly(action: () => void): void {
  try {
    action()
  } catch {
    /* diagnostics only */
  }
}
