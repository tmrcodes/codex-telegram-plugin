import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { launchArguments, observeThread, connectTelegram, loadedPrimaryThread, runLauncher, type OwnedChild } from './telegram-launcher'
import { SERVER_REQUEST_CANCELLED } from '../app-server-controller/protocol'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
class Rpc {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  listener?: (method: string, params: Record<string, unknown>) => void
  passive?: () => Promise<unknown>
  closed = false
  failConnect = false
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'plugin_namespace_telegram', pluginId: 'telegram-channel@codex-telegram', tools: { connect: { name: 'connect' } } }], nextCursor: null }
    if (method === 'mcpServer/tool/call') return this.failConnect ? { isError: true } : { structuredContent: { threadId: params?.threadId, connected: true } }
    return {}
  }
  notify() {}
  onNotification(listener: typeof this.listener) { this.listener = listener; return () => { this.listener = undefined } }
  onServerRequest(listener: (id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown>) { this.passive = () => listener(1, 'approval/request', {}); return () => {} }
  onClose() { return () => {} }
  close() { this.closed = true }
}
function terminal() {
  const descriptors = [Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')]
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true }); Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  return () => { for (const [i, stream] of [process.stdin, process.stdout].entries()) { const value = descriptors[i]; if (value) Object.defineProperty(stream, 'isTTY', value); else delete (stream as any).isTTY } }
}

describe('generic foreground Telegram launcher', () => {
  test('preserves TUI argv while forwarding explicit host-global settings', () => {
    const args = ['-c', 'model="chosen"', '--enable', 'foo', '--disable=bar', '--strict-config', '-m', 'user-model', '-C', '/user/work', 'resume', '--last']
    expect(launchArguments(args)).toEqual({ passthrough: false, host: ['-c', 'model="chosen"', '--enable', 'foo', '--disable=bar', 'app-server', '--strict-config'], tui: args })
    for (const args of [['plugin', 'list', '--json'], ['--help'], ['-c', 'x=1', 'login'], ['exec', 'hi']]) expect(launchArguments(args).passthrough).toBeTrue()
    expect(() => launchArguments(['--remote', 'unix:///other'])).toThrow('owns')
    expect(() => launchArguments(['-c'])).toThrow('requires')
  })
  test('binds only the notified exact thread once and rejects new task rebinding', async () => {
    const rpc = new Rpc(); const ids: string[] = []; const errors: string[] = []
    observeThread(rpc, async id => { ids.push(id) }, error => errors.push(error.message))
    rpc.listener!('thread/status/changed', { threadId: 'guessed' })
    rpc.listener!('thread/started', { thread: { id: 'internal-first', source: { internal: 'memory_consolidation' } } })
    rpc.listener!('thread/started', { thread: { id: 'temporary-first', source: 'vscode', ephemeral: true, parentThreadId: null } })
    rpc.listener!('thread/started', { thread: { id: 'host-owned' } }); rpc.listener!('thread/started', { thread: { id: 'host-owned' } })
    rpc.listener!('thread/started', { thread: { id: 'child', parentThreadId: 'host-owned', source: { subagent: 'other' } } })
    rpc.listener!('thread/started', { thread: { id: 'internal-later', source: { internal: 'memory_consolidation' } } })
    rpc.listener!('thread/started', { thread: { id: 'temporary-later', source: 'vscode', ephemeral: true, parentThreadId: null } })
    expect(errors).toEqual([])
    rpc.listener!('thread/started', { thread: { id: 'new-task' } })
    expect(ids).toEqual(['host-owned']); expect(errors[0]).toContain('/new')
  })
  test('resume lookup uses only the sole loaded primary task and rejects ambiguity', async () => {
    const tasks = new Map<string, object>([
      ['memory', { id: 'memory', source: { internal: 'memory' }, status: { type: 'idle' } }],
      ['temporary', { id: 'temporary', source: 'vscode', ephemeral: true, parentThreadId: null, status: { type: 'idle' } }],
      ['actual-resume', { id: 'actual-resume', source: 'vscode', parentThreadId: null, status: { type: 'idle' } }],
    ])
    const rpc = new Rpc()
    rpc.request = async (method, params) => method === 'thread/loaded/list' ? { data: [...tasks.keys()], nextCursor: null } : { thread: tasks.get(String(params?.threadId)) }
    expect(await loadedPrimaryThread(rpc)).toBe('actual-resume')
    tasks.set('another-root', { id: 'another-root', source: 'vscode', status: { type: 'idle' } })
    await expect(loadedPrimaryThread(rpc)).rejects.toThrow('refusing to guess')
    tasks.delete('actual-resume'); tasks.delete('another-root')
    expect(await loadedPrimaryThread(rpc)).toBeUndefined()
  })
  test('discovers installed plugin namespace and refuses failed connect', async () => {
    const rpc = new Rpc(); await connectTelegram(rpc, 'exact')
    expect(rpc.calls.at(-1)).toEqual({ method: 'mcpServer/tool/call', params: { threadId: 'exact', server: 'plugin_namespace_telegram', tool: 'connect', arguments: {} } })
    rpc.failConnect = true; await expect(connectTelegram(rpc, 'exact')).rejects.toThrow('existing poll owner')
  })
  for (const failConnect of [false, true]) test(`owned foreground cleanup after ${failConnect ? 'connect failure' : 'TUI exit'}`, async () => {
    const restore = terminal(); const rpc = new Rpc(); rpc.failConnect = failConnect
    const hostExit = deferred<number>(); const tuiExit = deferred<number>(); const stopped: boolean[] = []
    const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv; interactive: boolean }> = []
    let connection = ''
    try {
      const result = runLauncher({ codexBinary: '/stock/codex', botTokenFile: '/private/token', policyFile: '/private/policy', stateDir: '/private/state' }, ['-C', '/user/cwd'], { HOME: '/same/home', CODEX_HOME: '/same/codex', USER_SETTING: 'kept' }, {
        connect: async () => rpc,
        report: () => { tuiExit.resolve(7) },
        spawn: (_binary, args, env, interactive): OwnedChild => {
          spawned.push({ args, env, interactive }); connection = env.CODEX_TELEGRAM_CONFIG!
          if (interactive) { expect(rpc.listener).toBeDefined(); rpc.listener!('thread/started', { thread: { id: 'real-host-thread' } }) }
          return { exited: interactive ? tuiExit.promise : hostExit.promise, async stop() { stopped.push(interactive); (interactive ? tuiExit : hostExit).resolve(0) } }
        },
      })
      if (failConnect) await expect(result).rejects.toThrow('connect failed'); else expect(await result).toBe(7)
      expect(stopped).toEqual([true, false]); expect(rpc.closed).toBeTrue(); expect(existsSync(connection)).toBeFalse()
      expect(spawned[0]!.env.HOME).toBe('/same/home'); expect(spawned[0]!.env.CODEX_HOME).toBe('/same/codex')
      expect(spawned[1]!.args.slice(2)).toEqual(['-C', '/user/cwd']); expect(await rpc.passive!()).toBe(SERVER_REQUEST_CANCELLED)
    } finally { restore() }
  })
  test('cleans its host when startup fails before TUI launch', async () => {
    const restore = terminal(); let stopped = false; let connection = ''; let spawned = 0
    try {
      await expect(runLauncher({ codexBinary: '/stock', botTokenFile: '/token', policyFile: '/policy', stateDir: '/state' }, [], {}, {
        spawn: (_binary, _args, env) => { spawned++; connection = env.CODEX_TELEGRAM_CONFIG!; return { exited: Promise.resolve(9), async stop() { stopped = true } } },
        connect: async () => { throw new Error('not listening') },
      })).rejects.toThrow('App Server exited')
      expect(stopped).toBeTrue(); expect(spawned).toBe(1); expect(existsSync(connection)).toBeFalse()
    } finally { restore() }
  })
  test('a rejected root replaces only the foreground TUI on the exact old root', async () => {
    const restore = terminal(); const rpc = new Rpc(); const hostExit = deferred<number>(); const firstTuiExit = deferred<number>(); const secondTuiExit = deferred<number>(); const recovery = deferred<string>(); const calls: Array<{ args: string[]; interactive: boolean }> = []; const stopped: boolean[] = []; let ownerClosed = 0
    const owner = { childEnvironment: () => ({ CODEX_TELEGRAM_OWNER_SOCKET: '/tmp/owner.sock', CODEX_TELEGRAM_OWNER_CONFIG: '/tmp/connection.json' }), start: async () => {}, prepare: async () => {}, commit: async () => {}, abort: async () => {}, close: async () => { ownerClosed++ } }
    try {
      let recoveryReads = 0
      const running = runLauncher({ codexBinary: '/stock', botTokenFile: '/token', policyFile: '/policy', stateDir: '/state' }, [], {}, {
        connect: async () => rpc,
        ownerBridge: owner,
        startTransition: async () => ({ boundThreadId: () => 'old-root', transitionPending: () => false, nextRecovery: () => ++recoveryReads === 1 ? recovery.promise : new Promise<string>(() => {}), close: async () => { await owner.close() } }),
        spawn: (_binary, args, _env, interactive): OwnedChild => {
          calls.push({ args, interactive })
          const first = interactive && calls.filter(call => call.interactive).length === 1
          const exited = !interactive ? hostExit.promise : first ? firstTuiExit.promise : secondTuiExit.promise
          return { exited, async stop() { stopped.push(interactive); if (first) firstTuiExit.resolve(0); else if (interactive) secondTuiExit.resolve(0) } }
        },
      })
      await Bun.sleep(0); recovery.resolve('11111111-1111-1111-1111-111111111111'); await Bun.sleep(0)
      expect(calls.filter(call => call.interactive)).toHaveLength(2)
      expect(calls.filter(call => call.interactive)[1]!.args).toEqual(['--remote', expect.stringContaining('tui-transition.sock'), 'resume', '11111111-1111-1111-1111-111111111111'])
      expect(stopped).toEqual([true]); expect(ownerClosed).toBe(0)
      secondTuiExit.resolve(0); await expect(running).resolves.toBe(0)
      expect(stopped).toEqual([true, true, false]); expect(ownerClosed).toBe(1)
    } finally { restore() }
  })
  test('a delayed owner abort recovery wins even after the transition TUI child has exited', async () => {
    const restore = terminal(); const rpc = new Rpc(); const hostExit = deferred<number>(); const firstExit = deferred<number>(); const secondExit = deferred<number>(); const recovery = deferred<string>(); const calls: Array<{ args: string[]; interactive: boolean }> = []; const stopped: boolean[] = []; let pending = true; let ownerClosed = 0; let recoveryReads = 0
    const owner = { childEnvironment: () => ({ CODEX_TELEGRAM_OWNER_SOCKET: '/tmp/owner.sock', CODEX_TELEGRAM_OWNER_CONFIG: '/tmp/connection.json' }), start: async () => {}, prepare: async () => {}, commit: async () => {}, abort: async () => {}, close: async () => { ownerClosed++ } }
    recovery.promise.then(() => { pending = false })
    try {
      const running = runLauncher({ codexBinary: '/stock', botTokenFile: '/token', policyFile: '/policy', stateDir: '/state' }, [], {}, {
        connect: async () => rpc, ownerBridge: owner,
        startTransition: async () => ({ boundThreadId: () => 'old-root', transitionPending: () => pending, nextRecovery: () => ++recoveryReads === 1 ? recovery.promise : new Promise<string>(() => {}), close: async () => { await owner.close() } }),
        spawn: (_binary, args, _env, interactive): OwnedChild => {
          calls.push({ args, interactive }); const first = interactive && calls.filter(call => call.interactive).length === 1
          return { exited: !interactive ? hostExit.promise : first ? firstExit.promise : secondExit.promise, async stop() { stopped.push(interactive) } }
        },
      })
      await Bun.sleep(0); firstExit.resolve(17); await Bun.sleep(1)
      expect(calls.filter(call => call.interactive)).toHaveLength(1); expect(stopped).toEqual([]); expect(ownerClosed).toBe(0)
      recovery.resolve('11111111-1111-1111-1111-111111111111'); await Bun.sleep(1)
      expect(calls.filter(call => call.interactive)).toHaveLength(2); expect(calls.filter(call => call.interactive)[1]!.args).toEqual(['--remote', expect.stringContaining('tui-transition.sock'), 'resume', '11111111-1111-1111-1111-111111111111']); expect(ownerClosed).toBe(0)
      secondExit.resolve(0); await expect(running).resolves.toBe(0); expect(stopped).toEqual([true, true, false]); expect(ownerClosed).toBe(1)
    } finally { restore() }
  })
  test('administrative command passes through without host or connection', async () => {
    let calls = 0
    expect(await runLauncher({ codexBinary: '/stock', botTokenFile: '', policyFile: '', stateDir: '' }, ['plugin', 'list'], {}, { spawn: (_binary, args) => { calls++; expect(args).toEqual(['plugin', 'list']); return { exited: Promise.resolve(3), async stop() {} } }, connect: async () => { throw new Error('must not connect') } })).toBe(3)
    expect(calls).toBe(1)
  })
  test('has no private profile runtime, ledger or tmux dependency', () => {
    const source = readFileSync(new URL('./telegram-launcher.ts', import.meta.url), 'utf8')
    for (const forbidden of ["from '../app-server-controller/runtime'", 'sqlite', 'tmux', 'thread/start\'', 'thread/settings/update', 'auth.json']) expect(source).not.toContain(forbidden)
  })
})
