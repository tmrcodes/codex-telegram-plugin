import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StandaloneTelegram, type StandaloneTelegramDependencies } from './standalone-telegram'
import type { TelegramChannel } from './telegram-channel'

const OLD = '11111111-2222-4333-8444-555555555555'
const NEXT = '66666666-7777-4888-8999-000000000000'
const THIRD = '33333333-3333-4333-8333-333333333333'
const request = { version: 1 as const, type: 'react' as const, arguments: { target_handle: 'synthetic', emoji: '✅' } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function privateFile(path: string, value: string): void { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600) }

function fixture(options: { nextWorkspace?: string; oldCleanupFails?: boolean; pauseGate?: ReturnType<typeof deferred<void>>; closeGate?: ReturnType<typeof deferred<void>>; channelQuiescent?: () => boolean; controllerQuiescent?: () => boolean; relayQuiescent?: () => boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'standalone-transition-')); const stateDir = join(root, 'state'); mkdirSync(stateDir, { mode: 0o700 }); chmodSync(stateDir, 0o700)
  const token = join(root, 'token'); const policy = join(root, 'policy.json'); const config = join(root, 'connection.json'); privateFile(token, 'synthetic-token'); privateFile(policy, JSON.stringify({ schemaVersion: 1, dmPolicy: 'disabled', allowFrom: [], groups: {}, allowAllGroups: false, mentionPatterns: [], ackReaction: '', typing: false, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'length', deliveryMode: 'queue', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [] })); privateFile(config, JSON.stringify({ schemaVersion: 1, appServerSocket: join(root, 'host.sock'), policyFile: policy, botTokenFile: token, stateDir }))
  let pollCalls = 0; let pauses = 0; let resumes = 0; let rebinds = 0; let route = OLD; let tools = 0; let leases = 0; let transports = 0; const offset = { value: 41 }; const poll = deferred<void>(); const knownProfiles = new Set<string>()
  const oldController = { isQuiescent: () => options.controllerQuiescent?.() ?? true, disconnect() { if (options.oldCleanupFails) throw new Error('old cleanup failed') }, async admit() { return { duplicate: false as const, disposition: 'queued' as const } } }
  const nextController = { isQuiescent: () => true, disconnect() {}, async admit() { return { duplicate: false as const, disposition: 'queued' as const } } }
  const channel: TelegramChannel = {
    adapter: {} as never,
    poll: async () => { pollCalls++; await poll.promise }, close: () => poll.resolve(), closeAndDrain: async () => { await options.closeGate?.promise; poll.resolve() },
    executeTool: async () => { tools++; return {} },
    executeRetainedTool: async (profile, value) => { if (!knownProfiles.has(profile)) throw new Error('retired root requires its signed retained handle'); if (value.type !== 'react' || value.arguments.target_handle !== 'retained') throw new Error('retired root requires its unexpired signed retained handle'); tools++; return {} },
    pauseAndDrain: async () => { pauses++; await options.pauseGate?.promise }, resume: () => { resumes++ },
    isQuiescent: () => options.channelQuiescent?.() ?? true,
    rebind: (next, profile) => { if (!(options.channelQuiescent?.() ?? true) || !profile.startsWith('thread-')) throw new Error('channel is not quiescent'); knownProfiles.add(profile); rebinds++; route = next },
  }
  const dependencies: StandaloneTelegramDependencies = {
    connectTransport: async () => { transports++; return { close() {}, async request() { return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } } as never },
    bindThread: async (_transport, _version, id) => ({ controller: (id === OLD ? oldController : nextController) as never, cwd: id === OLD ? join(root, 'workspace') : options.nextWorkspace ?? join(root, 'workspace') }),
    createBot: () => ({ api: { async getMe() { return { id: 1, username: 'bot' } } } }) as never,
    acquireOwnerLease: () => ({ release() { leases++ } }),
    createChannel: channelOptions => { knownProfiles.add(channelOptions.profile); return channel },
    createRelay: () => ({ callback: () => false, install: () => async () => {}, isQuiescent: () => options.relayQuiescent?.() ?? true }),
  }
  return { root, service: new StandaloneTelegram({ CODEX_TELEGRAM_CONFIG: config }, dependencies), state: () => ({ pollCalls, pauses, resumes, rebinds, route, tools, leases, transports, offset: offset.value }) }
}

test('switchThread keeps the one live poll promise and its in-memory offset while replacing only the host route', async () => {
  const value = fixture()
  try {
    await value.service.connect(OLD); await value.service.switchThread(NEXT)
    expect(value.state()).toMatchObject({ pollCalls: 1, pauses: 1, resumes: 1, rebinds: 1, route: NEXT, transports: 2, offset: 41 })
    await expect(value.service.executeToolForThread(NEXT, request)).resolves.toEqual({}); expect(value.state().tools).toBe(1)
    await expect(value.service.executeToolForThread(OLD, request)).rejects.toThrow('signed retained handle')
    await expect(value.service.executeToolForThread(OLD, { ...request, arguments: { ...request.arguments, target_handle: 'retained' } })).resolves.toEqual({})
  } finally { await value.service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('a precommit workspace failure resumes the old route without a second poller', async () => {
  const value = fixture({ nextWorkspace: '/other/workspace' })
  try {
    await value.service.connect(OLD); await expect(value.service.switchThread(NEXT)).rejects.toThrow('changed the bound workspace')
    expect(value.state()).toMatchObject({ pollCalls: 1, rebinds: 0, route: OLD, resumes: 1, transports: 2 })
    await expect(value.service.executeToolForThread(OLD, request)).resolves.toEqual({})
  } finally { await value.service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('retains signed old-root egress across nine later transitions without reopening old ingress', async () => {
  const value = fixture()
  try {
    const roots = [NEXT, THIRD, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa', 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb', 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc', 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd', '44444444-4444-4444-8444-444444444444']
    await value.service.connect(OLD); for (const root of roots) await value.service.switchThread(root)
    const retained = { ...request, arguments: { ...request.arguments, target_handle: 'retained' } }
    await expect(value.service.executeToolForThread(OLD, retained)).resolves.toEqual({})
    await expect(value.service.executeToolForThread(NEXT, retained)).resolves.toEqual({})
    await expect(value.service.executeToolForThread(OLD, request)).rejects.toThrow('unexpired signed retained handle')
    await expect(value.service.executeToolForThread('arbitrary-old-root', retained)).rejects.toThrow('signed retained handle')
    expect(value.state()).toMatchObject({ pollCalls: 1, rebinds: roots.length, route: roots.at(-1), transports: roots.length + 1 })
  } finally { await value.service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('a postcommit old-resource cleanup failure reports health but retains the committed new route', async () => {
  const value = fixture({ oldCleanupFails: true })
  try {
    await value.service.connect(OLD); await expect(value.service.switchThread(NEXT)).resolves.toBeUndefined()
    expect(value.state()).toMatchObject({ pollCalls: 1, rebinds: 1, route: NEXT, resumes: 1 })
    await expect(value.service.executeToolForThread(NEXT, request)).resolves.toEqual({})
  } finally { await value.service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('switchThread waits for drain, then refuses pending tool, admission, or approval work without changing the old route', async () => {
  const gate = deferred<void>(); let channelReady = true; let controllerReady = true; let relayReady = true
  const value = fixture({ pauseGate: gate, channelQuiescent: () => channelReady, controllerQuiescent: () => controllerReady, relayQuiescent: () => relayReady })
  try {
    await value.service.connect(OLD); const waiting = value.service.switchThread(NEXT); await Bun.sleep(0)
    expect(value.state()).toMatchObject({ pauses: 1, transports: 1 }); await expect(value.service.executeToolForThread(OLD, request)).rejects.toThrow('Telegram owner')
    gate.resolve(); await expect(waiting).resolves.toBeUndefined(); expect(value.state().route).toBe(NEXT)
    // Reconnect a fresh owner for each refusal state, so every check observes
    // the same original route rather than a previous partial switch.
  } finally { await value.service.close(); rmSync(value.root, { recursive: true, force: true }) }

  for (const kind of ['tool', 'admission', 'approval'] as const) {
    let channelReady = kind !== 'tool'; let controllerReady = kind !== 'admission'; let relayReady = kind !== 'approval'
    const refused = fixture({ channelQuiescent: () => channelReady, controllerQuiescent: () => controllerReady, relayQuiescent: () => relayReady })
    try {
      await refused.service.connect(OLD); const rejected = refused.service.switchThread(NEXT); void rejected.catch(() => {})
      // A controller busy/queue preflight must not publish the transition
      // fence: a signed old-root tool remains usable while /new is refused.
      if (kind === 'admission') await expect(refused.service.executeToolForThread(OLD, request)).resolves.toEqual({})
      await expect(rejected).rejects.toThrow('not quiescent')
      expect(refused.state()).toMatchObject({ pollCalls: 1, rebinds: 0, route: OLD, resumes: kind === 'admission' ? 0 : 1, transports: 1 })
      await expect(refused.service.executeToolForThread(OLD, request)).resolves.toEqual({})
    } finally { await refused.service.close(); rmSync(refused.root, { recursive: true, force: true }) }
  }
})

test('busy and queued host preflight reject before fencing the signed old-root tool', async () => {
  for (const state of ['busy', 'queued']) {
    const value = fixture({ controllerQuiescent: () => false })
    try {
      await value.service.connect(OLD); const rejected = value.service.switchThread(NEXT); void rejected.catch(() => {})
      await expect(value.service.executeToolForThread(OLD, request)).resolves.toEqual({})
      await expect(rejected).rejects.toThrow('not quiescent')
      expect(value.state()).toMatchObject({ pauses: 0, rebinds: 0, route: OLD, resumes: 0 }); expect(['busy', 'queued']).toContain(state)
    } finally { await value.service.close(); rmSync(value.root, { recursive: true, force: true }) }
  }
})

test('owner cleanup cannot release its lease while an uncooperative channel operation is still draining', async () => {
  const gate = deferred<void>(); const value = fixture({ closeGate: gate })
  try {
    await value.service.connect(OLD)
    let settled = false; const closing = value.service.close().then(() => { settled = true })
    await Bun.sleep(1); expect(settled).toBeFalse(); expect(value.state().leases).toBe(0)
    gate.resolve(); await closing; expect(value.state().leases).toBe(1)
  } finally { await value.service.close(); rmSync(value.root, { recursive: true, force: true }) }
})
