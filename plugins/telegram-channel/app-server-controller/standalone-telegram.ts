#!/usr/bin/env bun
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bot } from 'grammy'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { bindExactHostThread, type AppServerController } from './controller'
import { SERVER_REQUEST_CANCELLED, type AppServerTransport } from './protocol'
import { createTelegramChannel, type TelegramChannel } from './telegram-channel'
import { buildTelegramMcp } from './telegram-mcp'
import { TelegramPolicySource } from '../telegram-policy'
import type { TelegramToolRequest, TelegramToolResult } from './telegram-tools-protocol'
import { UnixWebSocketTransport } from './unix-websocket'
import { privateDirectory, privateFile, readPrivateJson, readStandaloneTelegramConfig } from './standalone-telegram-config'
import { ApprovalRelay } from './approval-relay'
import { TelegramHealthFile } from './telegram-health'
import { acquireTelegramOwnerLease, type TelegramOwnerLease } from './telegram-owner-lease'
import { TelegramOwnerBridge, forwardTelegramOwnerBridge, telegramOwnerBridgePath } from './telegram-owner-bridge'

type OwnerLock = { release: () => void }
type Relay = Pick<ApprovalRelay, 'callback' | 'install' | 'isQuiescent'>
type CleanupResources = { controller?: AppServerController; transport?: UnixWebSocketTransport; closeRelay?: () => Promise<void>; unobserve?: () => void }
type ActiveConnection = { threadId: string; profile: string; controller: AppServerController; transport: AppServerTransport & { close: () => void }; bot: Bot; channel: TelegramChannel; health: TelegramHealthFile; relay: Relay; closeRelay: () => Promise<void>; unobserve: () => void; cleanupResources: CleanupResources; lock: OwnerLock; lease: TelegramOwnerLease; workspaceRoot: string; stopped: boolean; close: () => Promise<void> }
type PendingConnection = { threadId: string; promise: Promise<Record<string, unknown>> }
export type StandaloneTelegramDependencies = {
  connectTransport?: (path: string) => Promise<UnixWebSocketTransport>
  createBot?: (token: string) => Bot
  bindThread?: typeof bindExactHostThread
  processAlive?: (pid: number) => boolean
  acquireOwnerLease?: (botUserId: string, stateDir: string) => TelegramOwnerLease
  createChannel?: typeof createTelegramChannel
  createRelay?: (transport: AppServerTransport, bot: Bot, policy: TelegramPolicySource, scope: { threadId: string }) => Relay
}

/** One opt-in stdio MCP channel for one already-running stock App Server thread. */
export class StandaloneTelegram {
  #active: ActiveConnection | undefined
  #pending: PendingConnection | undefined
  #closed = false
  #closePromise: Promise<void> | undefined
  #transitioning = false
  #preparedFrom: string | undefined
  #bridge: TelegramOwnerBridge | undefined
  constructor(private readonly env: Record<string, string | undefined> = process.env, private readonly dependencies: StandaloneTelegramDependencies = {}) {}
  connect(threadId: string): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new Error('Telegram MCP is closed'))
    if (this.#pending !== undefined) return this.#pending.threadId === threadId ? this.#pending.promise : Promise.reject(new Error('connect rejected for a different host thread'))
    if (this.#active !== undefined) { if (this.#active.threadId !== threadId) return Promise.reject(new Error('connect rejected for a different host thread')); if (this.#active.stopped) return Promise.reject(new Error('Telegram polling is stopped')); return Promise.resolve({ threadId, connected: true }) }
    let resolve!: (value: Record<string, unknown>) => void; let reject!: (error: unknown) => void
    const promise = new Promise<Record<string, unknown>>((done, fail) => { resolve = done; reject = fail })
    const pending: PendingConnection = { threadId, promise }; this.#pending = pending
    void this.#initialize(threadId, pending).then(value => { if (this.#pending === pending) this.#pending = undefined; resolve(value) }, error => { if (this.#pending === pending) this.#pending = undefined; reject(error) })
    return promise
  }
  async #initialize(threadId: string, pending: PendingConnection): Promise<Record<string, unknown>> {
    const config = readStandaloneTelegramConfig(this.env); const lock = acquireOwnerLock(join(config.stateDir, 'standalone-telegram.lock'), this.dependencies.processAlive); const health = new TelegramHealthFile(join(config.stateDir, 'telegram-health.json')); const policy = new TelegramPolicySource(config.policyFile); let value
    try { value = policy.read(); health.start(value.fingerprint) } catch (error) { reportStandalonePolicyError(health, error); stopStandaloneHealth(health); lock.release(); throw new Error(safeStandaloneToolError(error)) }
    let transport: UnixWebSocketTransport | undefined; let controller: AppServerController | undefined; let channel: TelegramChannel | undefined; let closeRelay: (() => Promise<void>) | undefined; let unobserve: (() => void) | undefined; let lease: TelegramOwnerLease | undefined; let cleanupPromise: Promise<void> | undefined; const cleanupResources: CleanupResources = {}
    const cleanup = (): Promise<void> => {
      if (cleanupPromise !== undefined) return cleanupPromise
      let resolve!: () => void; let reject!: (error: unknown) => void
      cleanupPromise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
      void (async () => {
        let firstError: unknown
        const attempt = async (action: () => void | Promise<void>) => { try { await action() } catch (error) { firstError ??= error } }
        await attempt(async () => { await this.#bridge?.close(); this.#bridge = undefined }); await attempt(async () => { await channel?.closeAndDrain() }); await attempt(() => { stopStandaloneHealth(health) }); await attempt(async () => { await cleanupResources.closeRelay?.() }); await attempt(() => { cleanupResources.controller?.disconnect() }); await attempt(() => { cleanupResources.transport?.close() }); await attempt(() => { cleanupResources.unobserve?.() }); await attempt(() => { lease?.release() }); await attempt(() => { lock.release() })
        if (firstError === undefined) resolve(); else reject(firstError)
      })()
      return cleanupPromise
    }
    try {
      if (this.#closed) throw new Error('Telegram MCP is closed')
      const token = readPrivateText(config.botTokenFile, 'Telegram bot token')
      if (Array.from(token).length > 512 || /[\u0000-\u001f\u007f]/u.test(token)) throw new Error('Telegram bot token is invalid')
      transport = await (this.dependencies.connectTransport ?? UnixWebSocketTransport.connect)(config.appServerSocket)
      cleanupResources.transport = transport
      if (this.#closed) throw new Error('Telegram MCP is closed')
      unobserve = transport.onServerRequest?.(async () => SERVER_REQUEST_CANCELLED)
      cleanupResources.unobserve = unobserve ?? (() => {})
      if (this.#closed) throw new Error('Telegram MCP is closed')
      const bound = await (this.dependencies.bindThread ?? bindExactHostThread)(transport, 'standalone-telegram', threadId, true); controller = bound.controller
      cleanupResources.controller = controller
      if (this.#closed) throw new Error('Telegram MCP is closed')
      const inbox = join(config.stateDir, 'inbox'); mkdirSync(inbox, { recursive: true, mode: 0o700 }); privateDirectory(inbox, 'Telegram inbox')
      const namespace = `thread-${createHash('sha256').update(threadId).digest('hex').slice(0, 32)}`; const bot = (this.dependencies.createBot ?? (value => new Bot(value)))(token); if (this.#closed) throw new Error('Telegram MCP is closed'); const identity = await bot.api.getMe(); if (!Number.isSafeInteger(identity.id) || identity.id < 1) throw new Error('Telegram bot identity is invalid'); lease = (this.dependencies.acquireOwnerLease ?? acquireTelegramOwnerLease)(String(identity.id), config.stateDir); if (this.#closed) throw new Error('Telegram MCP is closed'); const relay = (this.dependencies.createRelay ?? ((transport, bot, source, scope) => new ApprovalRelay(transport, bot, source, scope)))(transport, bot, policy, { threadId }); closeRelay = relay.install(); cleanupResources.closeRelay = closeRelay; if (this.#closed) throw new Error('Telegram MCP is closed')
      const createChannel = this.dependencies.createChannel ?? createTelegramChannel
      channel = createChannel({ bot, policy, route: threadId, profile: namespace, handleKey: randomBytes(32).toString('base64url'), workspaceRoot: bound.cwd, inboxRoot: inbox, apiRoot: 'https://api.telegram.org', downloadUrl: filePath => `https://api.telegram.org/file/bot${token}/${encodeURI(filePath)}`, admit: async (origin, deliveryMode) => { await controller!.admit(origin, deliveryMode) }, onCallback: query => relay.callback(query), onHealth: (ok, error) => reportStandaloneHealth(health, policy, ok, error) })
      if (this.#closed) throw new Error('Telegram MCP is closed')
      this.#active = { threadId, profile: namespace, controller, transport, bot, channel, health, relay, closeRelay, unobserve: unobserve ?? (() => {}), cleanupResources, lock, lease, workspaceRoot: bound.cwd, stopped: false, close: cleanup }
      if (this.#closed) throw new Error('Telegram MCP is closed')
      const polling = channel.poll()
      if (this.#closed) throw new Error('Telegram MCP is closed')
      void polling.then(() => this.#markStopped(threadId)).catch(() => this.#markStopped(threadId))
      return { threadId, connected: true }
    } catch (error) {
      try { health.failure(new Error(safeStandaloneToolError(error))) } catch { /* diagnostics must not prevent owned-resource cleanup */ }
      let cleanupError: unknown; try { await cleanup() } catch (cleanupFailure) { cleanupError = cleanupFailure }
      throw cleanupError ?? (error instanceof Error ? error : new Error('standalone Telegram connection failed'))
    } finally { if (this.#pending === pending) this.#pending = undefined }
  }
  async executeTool(request: TelegramToolRequest): Promise<TelegramToolResult> { const active = this.#active; if (active === undefined || active.stopped || this.#transitioning) throw new Error('Telegram channel is not connected'); try { return await active.channel.executeTool(request) } catch (error) { throw new Error(safeStandaloneToolError(error)) } }
  async executeToolForThread(threadId: string, request: TelegramToolRequest): Promise<TelegramToolResult> {
    const active = this.#active
    if (active === undefined || active.stopped || this.#transitioning) throw new Error('Telegram owner is bound to a different host thread')
    if (threadId === active.threadId) return await this.executeTool(request)
    // The supplied thread metadata is host-scoped, but it is not sufficient
    // authority. A non-active child can egress only with a handle whose
    // signature embeds this exact deterministic root profile; the channel then
    // enforces the handle's normal expiry, route grant, and live policy. This
    // needs no retirement ledger, so valid one-hour handles survive any number
    // of later root transitions.
    try { return await active.channel.executeRetainedTool(threadProfile(threadId), request) } catch (error) { throw new Error(safeStandaloneToolError(error)) }
  }
  async startOwnerBridge(path = telegramOwnerBridgePath(readStandaloneTelegramConfig(this.env).stateDir)): Promise<void> { if (this.#bridge !== undefined) return; const active = this.#active; if (active === undefined) throw new Error('Telegram owner is not connected'); const bridge = new TelegramOwnerBridge(path, { connect: threadId => this.connect(threadId), executeTool: (threadId, request) => this.executeToolForThread(threadId, request) }); await bridge.start(); this.#bridge = bridge }
  async prepareThreadTransition(fromThreadId: string): Promise<void> {
    const active = this.#active
    if (active === undefined || active.stopped || this.#closed) throw new Error('Telegram owner is not connected')
    if (active.threadId !== fromThreadId) throw new Error('Telegram owner is bound to a different host thread')
    if (this.#transitioning) throw new Error('Telegram owner transition is already in progress')
    // Do not fence a usable old root merely to discover an already-active turn
    // or queued host submission. The second check below closes the preflight
    // race after channel draining has established the transition fence.
    if (!await active.controller.isQuiescent()) throw new Error('Telegram owner is not quiescent for a thread transition')
    this.#transitioning = true
    try {
      await active.channel.pauseAndDrain()
      if (!active.channel.isQuiescent() || !await active.controller.isQuiescent() || !active.relay.isQuiescent()) throw new Error('Telegram owner is not quiescent for a thread transition')
      this.#preparedFrom = fromThreadId
    } catch (error) {
      active.channel.resume(); this.#transitioning = false; throw error
    }
  }
  async commitThreadTransition(threadId: string): Promise<void> {
    const active = this.#active
    if (active === undefined || this.#closed || !this.#transitioning || this.#preparedFrom !== active.threadId) throw new Error('Telegram owner transition is not prepared')
    if (active.threadId === threadId) { await this.abortThreadTransition(active.threadId); return }
    let nextTransport: UnixWebSocketTransport | undefined; let nextController: AppServerController | undefined; let nextRelay: Relay | undefined; let nextCloseRelay: (() => Promise<void>) | undefined; let nextUnobserve: (() => void) | undefined
    try {
      const config = readStandaloneTelegramConfig(this.env)
      nextTransport = await (this.dependencies.connectTransport ?? UnixWebSocketTransport.connect)(config.appServerSocket)
      nextUnobserve = nextTransport.onServerRequest?.(async () => SERVER_REQUEST_CANCELLED)
      const bound = await (this.dependencies.bindThread ?? bindExactHostThread)(nextTransport, 'standalone-telegram', threadId, true)
      nextController = bound.controller
      if (bound.cwd !== active.workspaceRoot) throw new Error('Telegram thread transition changed the bound workspace')
      const policy = new TelegramPolicySource(config.policyFile)
      nextRelay = (this.dependencies.createRelay ?? ((transport, bot, source, scope) => new ApprovalRelay(transport, bot, source, scope)))(nextTransport, active.bot, policy, { threadId }); nextCloseRelay = nextRelay.install()
      const nextProfile = threadProfile(threadId)
      active.channel.rebind(threadId, nextProfile, async (origin, deliveryMode) => { await nextController!.admit(origin, deliveryMode) }, query => nextRelay!.callback(query))
      const old = { controller: active.controller, transport: active.transport, relayClose: active.closeRelay, unobserve: active.unobserve }
      active.threadId = threadId; active.profile = nextProfile; active.controller = nextController; active.transport = nextTransport; active.relay = nextRelay; active.closeRelay = nextCloseRelay; active.unobserve = nextUnobserve ?? (() => {})
      // Keep the owner-level cleanup closure aligned with the committed
      // replacement, rather than retrying retired old host resources later.
      active.cleanupResources.controller = active.controller; active.cleanupResources.transport = active.transport as UnixWebSocketTransport; active.cleanupResources.closeRelay = active.closeRelay; active.cleanupResources.unobserve = active.unobserve
      nextTransport = undefined; nextController = undefined; nextRelay = undefined; nextCloseRelay = undefined; nextUnobserve = undefined
      let cleanupFailure: unknown
      const retire = async (operation: () => void | Promise<void>) => { try { await operation() } catch (error) { cleanupFailure ??= error } }
      await retire(old.relayClose); await retire(() => { old.controller.disconnect() }); await retire(() => { old.transport.close() }); await retire(old.unobserve)
      if (cleanupFailure !== undefined) reportStandaloneHealth(active.health, new TelegramPolicySource(config.policyFile), false, cleanupFailure)
      active.channel.resume(); this.#preparedFrom = undefined; this.#transitioning = false
    } finally {
      if (nextCloseRelay !== undefined) await nextCloseRelay().catch(() => {})
      nextController?.disconnect(); nextTransport?.close(); nextUnobserve?.()
    }
  }
  async abortThreadTransition(fromThreadId: string): Promise<void> {
    const active = this.#active
    if (!this.#transitioning) return
    if (active === undefined || this.#preparedFrom !== fromThreadId || active.threadId !== fromThreadId) throw new Error('Telegram owner transition does not match its prepared root')
    active.channel.resume(); this.#preparedFrom = undefined; this.#transitioning = false
  }
  async switchThread(threadId: string): Promise<void> {
    const from = this.#active?.threadId
    if (from === undefined || from === threadId) { if (from === threadId) return; throw new Error('Telegram owner is not connected') }
    await this.prepareThreadTransition(from)
    try { await this.commitThreadTransition(threadId) } catch (error) { await this.abortThreadTransition(from).catch(() => {}); throw error }
  }
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true; const active = this.#active; this.#active = undefined; const pending = this.#pending
    let resolve!: () => void; let reject!: (error: unknown) => void
    const closing = new Promise<void>((done, fail) => { resolve = done; reject = fail }); this.#closePromise = closing
    void (async () => {
      let firstError: unknown
      const attempt = async (action: () => Promise<void>) => { try { await action() } catch (error) { firstError ??= error } }
      await attempt(async () => { await active?.close() })
      if (pending !== undefined) { void pending.promise.catch(() => {}); await attempt(async () => { try { await pending.promise } catch (error) { if (!(error instanceof Error) || error.message !== 'Telegram MCP is closed') throw error } }) }
      if (firstError === undefined) resolve(); else reject(firstError)
    })()
    return closing
  }
  #markStopped(threadId: string): void { if (this.#active?.threadId === threadId) { this.#active.stopped = true; stopStandaloneHealth(this.#active.health) } }
}

export async function serveStandaloneTelegram(standalone: StandaloneTelegram, transport = new StdioServerTransport(), stdin: NodeJS.ReadStream = process.stdin, exit: (code: number) => never = code => process.exit(code)): Promise<void> {
  const server = buildTelegramMcp(request => standalone.executeTool(request), { onConnect: threadId => standalone.connect(threadId), onTool: (threadId, request) => standalone.executeToolForThread(threadId, request) }); let shuttingDown = false
  const shutdown = (terminate: boolean) => { if (shuttingDown) return; shuttingDown = true; stdin.off('end', eof); stdin.off('close', eof); void standalone.close().catch(() => {}).finally(() => { void transport.close().catch(() => {}).finally(() => { if (terminate) exit(0) }) }) }
  const eof = () => shutdown(true); stdin.once('end', eof); stdin.once('close', eof); process.once('SIGINT', () => shutdown(true)); process.once('SIGTERM', () => shutdown(true))
  await server.connect(transport)
  const serverClosed = transport.onclose; transport.onclose = () => { serverClosed?.(); shutdown(false) }
}

/** Thread-scoped plugin children use the launch owner's bridge; they never poll. */
export async function serveStandaloneTelegramOwnerProxy(path: string, transport = new StdioServerTransport(), stdin: NodeJS.ReadStream = process.stdin, exit: (code: number) => never = code => process.exit(code)): Promise<void> {
  const server = buildTelegramMcp(async () => { throw new Error('owner bridge requires thread metadata') }, {
    onConnect: threadId => forwardTelegramOwnerBridge(path, { version: 1, operation: 'connect', threadId }),
    onTool: async (threadId, request) => await forwardTelegramOwnerBridge(path, { version: 1, operation: 'tool', threadId, request }) as TelegramToolResult,
  })
  let shuttingDown = false
  const shutdown = (terminate: boolean) => { if (shuttingDown) return; shuttingDown = true; stdin.off('end', eof); stdin.off('close', eof); void transport.close().catch(() => {}).finally(() => { if (terminate) exit(0) }) }
  const eof = () => shutdown(true); stdin.once('end', eof); stdin.once('close', eof); process.once('SIGINT', () => shutdown(true)); process.once('SIGTERM', () => shutdown(true))
  await server.connect(transport)
  const serverClosed = transport.onclose; transport.onclose = () => { serverClosed?.(); shutdown(false) }
}

function acquireOwnerLock(path: string, alive: (pid: number) => boolean = processAlive): OwnerLock {
  if (existsSync(path)) { privateFile(path, 'Telegram owner lock'); const value = readPrivateJson(path, 'Telegram owner lock'); const pid = record(value) ? value.pid : undefined; const nonce = record(value) ? value.nonce : undefined; if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || typeof nonce !== 'string') throw new Error('Telegram owner lock is invalid'); if (alive(pid)) throw new Error('Telegram state already has a live standalone owner'); unlinkSync(path) }
  const nonce = randomBytes(16).toString('hex'); writeFileSync(path, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' })
  return { release: () => { try { privateFile(path, 'Telegram owner lock'); const value = readPrivateJson(path, 'Telegram owner lock'); if (record(value) && value.pid === process.pid && value.nonce === nonce) unlinkSync(path) } catch { /* never remove a lock we cannot prove is ours */ } } }
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
function threadProfile(threadId: string): string { return `thread-${createHash('sha256').update(threadId).digest('hex').slice(0, 32)}` }
function readPrivateText(path: string, label: string): string { privateFile(path, label); try { const value = readFileSync(path, 'utf8').trim(); if (!value) throw new Error(); return value } catch { throw new Error(`${label} is invalid`) } }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function reportStandaloneHealth(health: TelegramHealthFile, policy: TelegramPolicySource, ok: boolean, error?: unknown): void {
  try { const current = policy.read(); ok ? health.success(current.fingerprint) : health.failure(new Error(safeStandaloneToolError(error)), current.fingerprint) } catch (policyError) { reportStandalonePolicyError(health, policyError) }
}
function reportStandalonePolicyError(health: TelegramHealthFile, error: unknown): void { try { const safe = new Error(safeStandaloneToolError(error)); health.failure(safe); health.invalidPolicy(safe) } catch { /* health reporting cannot affect polling or its host */ } }
function stopStandaloneHealth(health: TelegramHealthFile): void { try { health.stop() } catch { /* shutdown must still release host and owner resources */ } }
export function safeStandaloneToolError(error: unknown): string { const raw = error instanceof Error ? error.message : 'Telegram request failed'; const scrubbed = raw.replace(/https?:\/\/\S+/gu, '[redacted URL]').replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/gu, '[redacted token]').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim(); return Array.from(scrubbed || 'Telegram request failed').slice(0, 256).join('') }
