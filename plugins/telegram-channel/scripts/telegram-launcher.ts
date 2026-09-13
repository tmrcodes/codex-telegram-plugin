#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { UnixWebSocketTransport } from '../app-server-controller/unix-websocket'
import { SERVER_REQUEST_CANCELLED, type AppServerTransport } from '../app-server-controller/protocol'
import { privateDirectory, privateFile, readPrivateJson } from '../app-server-controller/standalone-telegram-config'
import { StandaloneTelegram } from '../app-server-controller/standalone-telegram'
import { startTuiThreadTransitionProxy, type TelegramOwnerTransition, type TuiThreadTransitionProxy } from './tui-thread-transition-proxy'

export type LauncherConfig = { codexBinary: string; botTokenFile: string; policyFile: string; stateDir: string; codexHome?: string }
type Rpc = AppServerTransport & { close(): void }
const object = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const ADMIN = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'app', 'plugin', 'plugins', 'completion', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'features', 'help', 'agents'])
const VALUE_FLAGS = new Set(['-m', '--model', '-C', '--cd', '-p', '--profile', '-a', '--ask-for-approval', '-s', '--sandbox', '-i', '--image', '--add-dir'])

/** TUI argv is preserved byte-for-byte; only host-global configuration is duplicated. */
export function launchArguments(args: string[]): { passthrough: boolean; host: string[]; tui: string[] } {
  const globals: string[] = []; let strict = false; let positional: string | undefined; let passthrough = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') break
    if (['--help', '-h', '--version', '-V'].includes(arg)) passthrough = true
    if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
      if (args[i + 1] === undefined) throw new Error(`${arg} requires a value`)
      globals.push(arg, args[++i]!); continue
    }
    if (/^(?:--config|--enable|--disable)=/u.test(arg) || /^-c.+/u.test(arg)) { globals.push(arg); continue }
    if (arg === '--strict-config') { strict = true; continue }
    if (arg === '--remote' || arg.startsWith('--remote=')) throw new Error('Telegram launcher owns its private --remote endpoint; use stock Codex for another endpoint')
    if (VALUE_FLAGS.has(arg)) { if (args[i + 1] === undefined) throw new Error(`${arg} requires a value`); i++; continue }
    if (!arg.startsWith('-') && positional === undefined) positional = arg
  }
  return { passthrough: passthrough || (positional !== undefined && ADMIN.has(positional)), host: [...globals, 'app-server', ...(strict ? ['--strict-config'] : [])], tui: [...args] }
}

export function readLauncherConfig(path: string, telegram = true): LauncherConfig {
  const raw = readPrivateJson(path, 'Telegram launcher settings')
  if (!object(raw) || Object.keys(raw).some(k => !['codexBinary', 'botTokenFile', 'policyFile', 'stateDir', 'codexHome'].includes(k))) throw new Error('Invalid Telegram launcher settings')
  for (const key of ['codexBinary', 'botTokenFile', 'policyFile', 'stateDir']) if (typeof raw[key] !== 'string' || !isAbsolute(raw[key])) throw new Error(`Invalid ${key}`)
  if (raw.codexHome !== undefined && (typeof raw.codexHome !== 'string' || !isAbsolute(raw.codexHome) || normalize(raw.codexHome) !== raw.codexHome)) throw new Error('Invalid codexHome')
  const binary = realpathSync(raw.codexBinary)
  if (!statSync(binary).isFile() || !(statSync(binary).mode & 0o111)) throw new Error('Configured stock Codex binary is not executable')
  if (telegram) { privateFile(raw.botTokenFile, 'Telegram token'); privateFile(raw.policyFile, 'Telegram policy'); privateDirectory(raw.stateDir, 'Telegram state') }
  return { codexBinary: binary, botTokenFile: raw.botTokenFile, policyFile: raw.policyFile, stateDir: raw.stateDir, ...(raw.codexHome === undefined ? {} : { codexHome: raw.codexHome }) }
}

async function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}

/** Discover only the installed plugin's actual server namespace on this exact thread. */
export async function connectTelegram(rpc: AppServerTransport, threadId: string): Promise<void> {
  const until = Date.now() + 75_000
  let matches: string[] = []
  do {
  let cursor: string | undefined; matches = []
  for (let page = 0; page < 8; page++) {
    const response = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}) })
    if (!object(response) || !Array.isArray(response.data)) throw new Error('Invalid MCP inventory from stock host')
    for (const entry of response.data) {
      if (object(entry) && typeof entry.pluginId === 'string' && entry.pluginId === 'telegram-channel@codex-telegram' && object(entry.tools) && Object.values(entry.tools).some(tool => object(tool) && tool.name === 'connect')) matches.push(entry.name)
    }
    if (response.nextCursor == null) break
    if (typeof response.nextCursor !== 'string' || page === 7) throw new Error('MCP inventory exceeds bounded pagination')
    cursor = response.nextCursor
  }
  if (!matches.length && Date.now() < until) await sleep(100)
  } while (!matches.length && Date.now() < until)
  if (matches.length !== 1 || typeof matches[0] !== 'string') throw new Error('Enable exactly one installed telegram-channel@codex-telegram plugin in this Codex home')
  const result = await rpc.request('mcpServer/tool/call', { threadId, server: matches[0], tool: 'connect', arguments: {} })
  if (!object(result) || result.isError === true) throw new Error('Telegram connect failed; check token, policy and existing poll owner. No other owner was stopped')
  const payload = result.structuredContent
  if (!object(payload) || payload.threadId !== threadId || payload.connected !== true) throw new Error('Telegram did not confirm the exact host thread binding')
}

function backgroundThread(candidate: Record<string, any>): boolean {
  return candidate.ephemeral === true || typeof candidate.parentThreadId === 'string' || (object(candidate.source) && ('internal' in candidate.source || 'subagent' in candidate.source))
}

/** Resume can load a TUI task without broadcasting thread/started to other clients. */
export async function loadedPrimaryThread(rpc: AppServerTransport): Promise<string | undefined> {
  const loaded = await rpc.request('thread/loaded/list', { limit: 100 })
  if (!object(loaded) || !Array.isArray(loaded.data) || loaded.nextCursor != null) throw new Error('Cannot identify one loaded TUI task on this owned host')
  const roots: string[] = []
  for (const id of loaded.data) {
    if (typeof id !== 'string') throw new Error('Invalid loaded task identity')
    const result = await rpc.request('thread/read', { threadId: id, includeTurns: false })
    const candidate = object(result) && object(result.thread) ? result.thread : undefined
    if (!candidate || candidate.id !== id) throw new Error('Loaded task identity mismatch')
    if (!backgroundThread(candidate) && candidate.status?.type !== 'notLoaded') roots.push(id)
  }
  if (roots.length > 1) throw new Error('More than one primary task is loaded on this owned host; refusing to guess the TUI task')
  return roots[0]
}

export function observeThread(rpc: AppServerTransport, connect: (id: string) => Promise<void>, fail: (error: Error) => void): () => void {
  let thread: string | undefined
  return rpc.onNotification((method, params) => {
    if (method !== 'thread/started') return
    const candidate = object(params.thread) ? params.thread : undefined
    // One host also creates memory/internal work and model subagents. Neither is a TUI /new.
    if (candidate && backgroundThread(candidate)) return
    const id = candidate?.id
    if (typeof id !== 'string' || !id || id.length > 256) { fail(new Error('Invalid host thread/started identity')); return }
    if (thread === id) return
    if (thread !== undefined) { fail(new Error(`/new is not supported in this Telegram launch; exit and relaunch to select a new task (source=${JSON.stringify(candidate?.source ?? 'unknown')})`)); return }
    thread = id
    void deadline(connect(id), 90_000, 'Telegram connection').catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  })
}

export type OwnedChild = { exited: Promise<number>; stop(): Promise<void> }
export function spawnOwned(binary: string, args: string[], env: NodeJS.ProcessEnv, interactive: boolean): OwnedChild {
  const child = spawn(binary, args, { env, detached: !interactive, stdio: interactive ? 'inherit' : ['ignore', 'ignore', 'inherit'] })
  let done = false
  const exited = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { done = true; resolve(code ?? (signal ? 128 : 1)) }) })
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return
    try { if (interactive) child.kill(value); else process.kill(-child.pid, value) } catch (error: any) { if (error.code !== 'ESRCH') throw error }
  }
  return { exited, async stop() {
    // App Server has its own group; include its inherited MCP children after parent exit.
    if (!done || !interactive) signal('SIGTERM')
    await Promise.race([exited.catch(() => 1), sleep(1500)])
    if (!done || !interactive) signal('SIGKILL')
    await deadline(exited.catch(() => 1), 1500, 'Owned child cleanup')
  } }
}

/**
 * This contract is intentionally local until standalone-telegram supplies the
 * owner bridge implementation. Its two environment values are private,
 * per-launch paths inherited only by thread-scoped MCP children.
 */
export type LauncherOwnerBridge = TelegramOwnerTransition & {
  childEnvironment(): Readonly<{ CODEX_TELEGRAM_OWNER_SOCKET: string; CODEX_TELEGRAM_OWNER_CONFIG: string }>
}
export type Dependencies = { spawn?: typeof spawnOwned; connect?: (path: string) => Promise<Rpc>; report?: (message: string) => void; ownerBridge?: LauncherOwnerBridge; createOwnerBridge?: (env: NodeJS.ProcessEnv, connection: string, config: LauncherConfig) => LauncherOwnerBridge; startTransition?: typeof startTuiThreadTransitionProxy }
export function createStandaloneOwnerBridge(env: NodeJS.ProcessEnv, connection: string, config: LauncherConfig): LauncherOwnerBridge {
  const owner = new StandaloneTelegram(env)
  const ownerSocket = join(dirname(connection), 'telegram-owner.sock')
  return {
    childEnvironment: () => ({ CODEX_TELEGRAM_OWNER_SOCKET: ownerSocket, CODEX_TELEGRAM_OWNER_CONFIG: connection }),
    start: async threadId => { await owner.connect(threadId); await owner.startOwnerBridge(ownerSocket) },
    prepare: async fromThreadId => { await owner.prepareThreadTransition(fromThreadId) },
    commit: async (_fromThreadId, toThreadId) => { await owner.commitThreadTransition(toThreadId) },
    abort: async fromThreadId => { await owner.abortThreadTransition(fromThreadId) },
    close: async () => { await owner.close() },
  }
}
export async function runLauncher(config: LauncherConfig, args: string[], env: NodeJS.ProcessEnv = process.env, deps: Dependencies = {}): Promise<number> {
  const plan = launchArguments(args); const create = deps.spawn ?? spawnOwned; const report = deps.report ?? (message => process.stderr.write(`telegram-launcher: ${message}\n`))
  if (plan.passthrough) return await create(config.codexBinary, args, env, true).exited
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive Telegram launch requires a terminal; administrative stock commands pass through')
  const runtime = mkdtempSync('/tmp/codextg-'); chmodSync(runtime, 0o700)
  const socket = join(runtime, 'host.sock'); const transitionSocket = join(runtime, 'tui-transition.sock'); const connection = join(runtime, 'connection.json')
  let childEnv: NodeJS.ProcessEnv = { ...env, CODEX_TELEGRAM_CONFIG: connection }
  const ownerBridge = deps.ownerBridge ?? deps.createOwnerBridge?.(childEnv, connection, config)
  const ownerEnvironment = ownerBridge?.childEnvironment()
  if (ownerEnvironment && (!isAbsolute(ownerEnvironment.CODEX_TELEGRAM_OWNER_SOCKET) || !isAbsolute(ownerEnvironment.CODEX_TELEGRAM_OWNER_CONFIG))) throw new Error('Owner bridge must provide absolute ephemeral socket and config paths')
  childEnv = { ...childEnv, ...(ownerEnvironment ?? {}) }
  let host: OwnedChild | undefined; let tui: OwnedChild | undefined; let rpc: Rpc | undefined; let transition: TuiThreadTransitionProxy | undefined; let unobserve: (() => void) | undefined; let unapproval: (() => void) | undefined
  let stopping = false; let boundThread: string | undefined; let binding: Promise<void> | undefined
  let rejectFailure!: (error: Error) => void
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject }); void failed.catch(() => {})
  const interrupted = () => rejectFailure(new Error('Foreground launch interrupted'))
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted)
  try {
  writeFileSync(connection, JSON.stringify({ schemaVersion: 1, appServerSocket: socket, botTokenFile: config.botTokenFile, policyFile: config.policyFile, stateDir: config.stateDir }), { mode: 0o600 })
    host = create(config.codexBinary, [...plan.host, '--listen', `unix://${socket}`], childEnv, false)
    void host.exited.then(code => rejectFailure(new Error(`Owned App Server exited (${code})`)), rejectFailure)
    const connect = deps.connect ?? UnixWebSocketTransport.connect
    const until = Date.now() + 10_000
    while (!rpc) {
      try { rpc = await Promise.race([deadline(connect(socket), Math.max(1, until - Date.now()), 'Host socket startup'), failed]) } catch (error) { if (Date.now() >= until) throw error; await Promise.race([sleep(50), failed]) }
    }
    unapproval = rpc.onServerRequest?.(async () => SERVER_REQUEST_CANCELLED)
    const bind = (id: string): Promise<void> => {
      if (boundThread && boundThread !== id) return Promise.reject(new Error('TUI task changed; exit and relaunch Telegram for the new task'))
      if (binding) return binding
      boundThread = id
      binding = connectTelegram(rpc!, id).then(() => report('Telegram bound to this task; polling and reply readiness still require a real message'))
      return binding
    }
    if (!ownerBridge) unobserve = observeThread(rpc, bind, rejectFailure)
    rpc.onClose(rejectFailure)
    await Promise.race([deadline(rpc.request('initialize', { clientInfo: { name: 'codex-telegram-launcher', version: '0.1.0' }, capabilities: { experimentalApi: true } }), 10_000, 'Host initialize'), failed])
    rpc.notify('initialized')
    if (ownerBridge) transition = await (deps.startTransition ?? startTuiThreadTransitionProxy)({ listenSocket: transitionSocket, upstreamSocket: socket, owner: ownerBridge })
    const launchTui = (resumeThreadId?: string): OwnedChild => create(config.codexBinary, ['--remote', `unix://${transition ? transitionSocket : socket}`, ...(resumeThreadId === undefined ? plan.tui : ['resume', resumeThreadId])], childEnv, true)
    tui = launchTui()
    if (!ownerBridge) void (async () => {
      const until = Date.now() + 90_000
      while (!stopping && !boundThread) {
        const id = await deadline(loadedPrimaryThread(rpc!), 10_000, 'Loaded TUI task lookup')
        if (stopping || boundThread) return
        if (id) { await deadline(bind(id), 90_000, 'Telegram connection'); return }
        if (Date.now() >= until) throw new Error('No primary TUI task became loaded within 90 seconds')
        await sleep(100)
      }
    })().catch(error => { if (!stopping) rejectFailure(error) })
    for (;;) {
      const current = tui
      const recovery = transition?.nextRecovery()
      const result = await Promise.race([
        current.exited.then(code => ({ kind: 'exit' as const, code })),
        ...(recovery === undefined ? [] : [recovery.then(threadId => ({ kind: 'recover' as const, threadId }))]),
        failed,
      ])
      if (result.kind === 'exit') {
        // A stock root command may have already detached its listener when its
        // foreground child exits. If the proxy still owns that transition,
        // wait for its abort/commit outcome instead of tearing down the host.
        if (transition?.transitionPending() && recovery !== undefined) {
          const threadId = await Promise.race([recovery, failed])
          await current.stop(); tui = launchTui(threadId)
          report(`TUI root transition was rejected; restored exact root ${threadId}`)
          continue
        }
        return result.code
      }
      // The stock client has already dropped its listener around the rejected
      // root operation. Replace only that foreground client on the exact old
      // (or atomically committed) root; the host and Telegram poll owner stay.
      await current.stop()
      tui = launchTui(result.threadId)
      report(`TUI root transition was rejected; restored exact root ${result.threadId}`)
    }
  } finally {
    stopping = true
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted)
    unobserve?.(); unapproval?.(); rpc?.close()
    try { await tui?.stop() } finally { try { if (transition) await transition.close(); else await ownerBridge?.close() } finally { try { await host?.stop() } finally { rmSync(runtime, { recursive: true, force: true }) } } }
  }
}

if (import.meta.main) {
  try {
    const path = process.env.CODEX_TELEGRAM_LAUNCHER_CONFIG
    if (!path) throw new Error('Set CODEX_TELEGRAM_LAUNCHER_CONFIG to your one-time private launcher settings')
    const config = readLauncherConfig(path, !launchArguments(process.argv.slice(2)).passthrough)
    if (config.codexHome && process.env.CODEX_HOME !== config.codexHome) throw new Error('Launcher Codex home does not match retained setup provenance')
    process.exitCode = await runLauncher(config, process.argv.slice(2), process.env, { createOwnerBridge: createStandaloneOwnerBridge })
  } catch (error) { process.stderr.write(`telegram-launcher: ${error instanceof Error ? error.message : 'launch failed'}\n`); process.exitCode = 1 }
}
