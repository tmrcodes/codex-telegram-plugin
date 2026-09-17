#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type AppServerTransport, SERVER_REQUEST_CANCELLED } from '../app-server/transport'
import { UnixWebSocketTransport } from '../app-server/unix-websocket'
import { OWNER_SOCKET_NAME } from '../owner/bridge'
import { SessionOwner, type StartStage } from '../owner/session-owner'
import { runAccessCli } from '../policy/access-cli'
import { type LauncherSettings, readLauncherSettings } from '../setup/profile'
import { sleep, toError, withDeadline } from '../shared/guards'
import { privateDirectory, privateFile } from '../shared/private-fs'
import { VERSION } from '../version'
import { launchArguments } from './args'
import { type OwnerTransition, startTuiProxy, type TuiProxy } from './tui-proxy'

/**
 * What `codex` runs once this plugin is configured. It starts the stock App Server on a private
 * socket, the stock TUI against it, and owns the Telegram channel for as long as the TUI lives.
 * Administrative commands pass straight through to the stock binary.
 */
type Rpc = AppServerTransport & { close(): void }
export type OwnedChild = { exited: Promise<number>; stop(): Promise<void> }

export type LauncherDependencies = {
  spawn?: typeof spawnOwned
  connect?: (socketPath: string) => Promise<Rpc>
  report?: (message: string) => void
  createOwner?: (context: {
    appServerSocket: string
    ownerSocket: string
    settings: LauncherSettings
    report: (message: string) => void
  }) => OwnerTransition
  startProxy?: typeof startTuiProxy
}

const HOST_START_TIMEOUT_MS = 10_000
const CHILD_STOP_GRACE_MS = 1_500

/**
 * The App Server gets its own process group so that its MCP children are stopped with it;
 * the TUI stays in the foreground group and receives terminal signals itself.
 */
export function spawnOwned(binary: string, args: string[], env: NodeJS.ProcessEnv, interactive: boolean): OwnedChild {
  const child = spawn(binary, args, {
    env,
    detached: !interactive,
    stdio: interactive ? 'inherit' : ['ignore', 'ignore', 'inherit'],
  })
  let done = false
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      done = true
      resolve(code ?? (signal ? 128 : 1))
    })
  })
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      if (interactive) child.kill(value)
      else process.kill(-child.pid, value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  return {
    exited,
    async stop() {
      if (!done || !interactive) signal('SIGTERM')
      await Promise.race([exited.catch(() => 1), sleep(CHILD_STOP_GRACE_MS)])
      if (!done || !interactive) signal('SIGKILL')
      await withDeadline(
        exited.catch(() => 1),
        CHILD_STOP_GRACE_MS,
        'Owned child cleanup',
      )
    },
  }
}

export function ownerStartFailureMessage(stage: StartStage): string {
  return `Telegram owner startup stage failed: ${stage}; provider details were withheld`
}

function createSessionOwner(context: {
  appServerSocket: string
  ownerSocket: string
  settings: LauncherSettings
  report: (message: string) => void
}): OwnerTransition {
  const { settings, report } = context
  const owner = new SessionOwner(
    {
      appServerSocket: context.appServerSocket,
      botTokenFile: settings.botTokenFile,
      policyFile: settings.policyFile,
      stateDir: settings.stateDir,
      codexHome: settings.codexHome,
    },
    {
      onStartStageFailure: stage => report(ownerStartFailureMessage(stage)),
      onSessionHandoff: () =>
        report('Telegram moved to a newer session of this profile; this TUI no longer receives Telegram.'),
    },
  )
  return {
    start: threadId => owner.start(threadId, context.ownerSocket),
    prepare: fromThreadId => owner.prepareThreadTransition(fromThreadId),
    commit: (_fromThreadId, toThreadId) => owner.commitThreadTransition(toThreadId),
    abort: fromThreadId => owner.abortThreadTransition(fromThreadId),
    close: () => owner.close(),
  }
}

export async function runLauncher(
  settings: LauncherSettings,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: LauncherDependencies = {},
): Promise<number> {
  const plan = launchArguments(args)
  const start = dependencies.spawn ?? spawnOwned
  const report = dependencies.report ?? (message => process.stderr.write(`telegram-launcher: ${message}\n`))
  if (plan.passthrough) return await start(settings.codexBinary, args, env, true).exited
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Interactive Telegram launch requires a terminal; administrative stock commands pass through')

  // Everything session-local lives in one private directory that disappears with the launch.
  const runtime = mkdtempSync('/tmp/codextg-')
  chmodSync(runtime, 0o700)
  const hostSocket = join(runtime, 'host.sock')
  const tuiSocket = join(runtime, 'tui.sock')
  const ownerSocket = join(runtime, OWNER_SOCKET_NAME)
  const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_TELEGRAM_OWNER_SOCKET: ownerSocket }
  const owner = (dependencies.createOwner ?? createSessionOwner)({
    appServerSocket: hostSocket,
    ownerSocket,
    settings,
    report,
  })

  let host: OwnedChild | undefined
  let tui: OwnedChild | undefined
  let rpc: Rpc | undefined
  let proxy: TuiProxy | undefined
  let unobserve: (() => void) | undefined
  let fail!: (error: Error) => void
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  void failed.catch(() => {})
  const interrupted = () => fail(new Error('Foreground launch interrupted'))
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    host = start(settings.codexBinary, [...plan.host, '--listen', `unix://${hostSocket}`], childEnv, false)
    void host.exited.then(code => fail(new Error(`Owned App Server exited (${code})`)), fail)

    const connect = dependencies.connect ?? UnixWebSocketTransport.connect
    const deadline = Date.now() + HOST_START_TIMEOUT_MS
    while (rpc === undefined) {
      try {
        rpc = await Promise.race([
          withDeadline(connect(hostSocket), Math.max(1, deadline - Date.now()), 'Host socket startup'),
          failed,
        ])
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await Promise.race([sleep(50), failed])
      }
    }
    // This connection only watches the host; approvals belong to the TUI and the owner's relay.
    unobserve = rpc.onServerRequest(async () => SERVER_REQUEST_CANCELLED)
    rpc.onClose(fail)
    await Promise.race([
      withDeadline(
        rpc.request('initialize', {
          clientInfo: { name: 'codex-telegram-launcher', version: VERSION },
          capabilities: { experimentalApi: true },
        }),
        HOST_START_TIMEOUT_MS,
        'Host initialize',
      ),
      failed,
    ])
    rpc.notify('initialized')

    proxy = await (dependencies.startProxy ?? startTuiProxy)({
      listenSocket: tuiSocket,
      upstreamSocket: hostSocket,
      owner,
    })
    const launchTui = (resumeThreadId?: string): OwnedChild =>
      start(
        settings.codexBinary,
        ['--remote', `unix://${tuiSocket}`, ...(resumeThreadId === undefined ? plan.tui : ['resume', resumeThreadId])],
        childEnv,
        true,
      )
    tui = launchTui()
    for (;;) {
      const current = tui
      const recovery = proxy.nextRecovery()
      const result = await Promise.race([
        current.exited.then(code => ({ kind: 'exit' as const, code })),
        recovery.then(threadId => ({ kind: 'recover' as const, threadId })),
        failed,
      ])
      if (result.kind === 'exit') {
        // A stock root command may drop its connection as its foreground child exits. While the
        // proxy still owns that transition, wait for its outcome instead of tearing the host down.
        if (!proxy.transitionPending()) return result.code
        const threadId = await Promise.race([recovery, failed])
        await current.stop()
        tui = launchTui(threadId)
        report(`TUI root transition was rejected; restored exact root ${threadId}`)
        continue
      }
      // The stock client has dropped its listener around the rejected root operation. Replace only
      // that foreground client on the exact old (or committed) root; host and poll owner stay.
      await current.stop()
      tui = launchTui(result.threadId)
      report(`TUI root transition was rejected; restored exact root ${result.threadId}`)
    }
  } finally {
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
    unobserve?.()
    rpc?.close()
    try {
      await tui?.stop()
    } finally {
      try {
        if (proxy !== undefined) await proxy.close()
        else await owner.close()
      } finally {
        try {
          await host?.stop()
        } finally {
          rmSync(runtime, { recursive: true, force: true })
        }
      }
    }
  }
}

/** A Telegram launch needs the whole profile; a pass-through command only the stock binary. */
export function checkLauncherSettings(settings: LauncherSettings, telegram: boolean): LauncherSettings {
  const codexBinary = realpathSync(settings.codexBinary)
  const stat = statSync(codexBinary)
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('Configured stock Codex binary is not executable')
  if (telegram) {
    privateFile(settings.botTokenFile, 'Telegram token')
    privateFile(settings.policyFile, 'Telegram policy')
    privateDirectory(settings.stateDir, 'Telegram state')
  }
  return { ...settings, codexBinary }
}

if (import.meta.main) {
  try {
    const path = process.env.CODEX_TELEGRAM_LAUNCHER_CONFIG
    if (!path) throw new Error('Run the `codex` command written by $telegram-channel:configure')
    const args = process.argv.slice(2)
    const accessCommand = args[0] === 'telegram'
    const settings = checkLauncherSettings(
      readLauncherSettings(path),
      !accessCommand && !launchArguments(args).passthrough,
    )
    if (process.env.CODEX_HOME !== settings.codexHome)
      throw new Error('Launcher Codex home does not match this profile')
    if (accessCommand) await runAccessCli(args.slice(1), process.env)
    else process.exitCode = await runLauncher(settings, args, process.env)
  } catch (error) {
    process.stderr.write(`telegram-launcher: ${toError(error, 'launch failed').message}\n`)
    process.exitCode = 1
  }
}
