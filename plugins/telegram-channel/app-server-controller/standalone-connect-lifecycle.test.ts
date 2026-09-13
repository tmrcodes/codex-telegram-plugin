import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StandaloneTelegram, type StandaloneTelegramDependencies } from './standalone-telegram'

const thread = '11111111-2222-4333-8444-555555555555'
function privateFile(path: string, value: string): void { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'standalone-connect-lifecycle-')); const stateDir = join(root, 'state'); mkdirSync(stateDir, { mode: 0o700 }); chmodSync(stateDir, 0o700)
  const policyFile = join(root, 'telegram.json'); const tokenFile = join(root, 'token'); const configFile = join(root, 'connection.json'); privateFile(policyFile, JSON.stringify({ schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: ['2'], groups: {}, mentionPatterns: [], ackReaction: '', typing: false, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'length', deliveryMode: 'auto', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [] })); privateFile(tokenFile, 'synthetic-token'); privateFile(configFile, JSON.stringify({ schemaVersion: 1, appServerSocket: join(root, 'host.sock'), policyFile, botTokenFile: tokenFile, stateDir }))
  return { root, stateDir, env: { CODEX_TELEGRAM_CONFIG: configFile } }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function transport(onClose: () => void = () => {}) { return { close: onClose, async request() { return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } } }
function readyDependencies(value: ReturnType<typeof fixture>, counts: { connects: number; binds: number; bots: number; closes: number; disconnects: number }): StandaloneTelegramDependencies {
  return { connectTransport: async () => { counts.connects++; return transport(() => { counts.closes++ }) as never }, bindThread: (async () => { counts.binds++; return { controller: { disconnect() { counts.disconnects++ }, async admit() { return { duplicate: false as const, disposition: 'queued' as const } } } as never, cwd: join(value.root, 'workspace') } }) as never, createBot: (() => { counts.bots++; return { api: { async getMe() { return { id: 1, username: 'synthetic_bot' } }, getUpdates(_args: unknown, signal?: AbortSignal) { return new Promise<never>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('stopped'))) }) } } } as never }), acquireOwnerLease: () => ({ release() {} }) }
}

test('pending same-thread connects share one attempt while a foreign thread performs no I/O', async () => {
  const value = fixture(); const gate = deferred<ReturnType<typeof transport>>(); const counts = { connects: 0, binds: 0, bots: 0, closes: 0, disconnects: 0 }; const dependencies = readyDependencies(value, counts); dependencies.connectTransport = async () => { counts.connects++; return await gate.promise as never }
  const service = new StandaloneTelegram(value.env, dependencies)
  try {
    const first = service.connect(thread); const second = service.connect(thread); expect(second).toBe(first); await expect(service.connect('foreign-thread')).rejects.toThrow('different host thread'); expect(counts.connects).toBe(1)
    gate.resolve(transport(() => { counts.closes++ })); await expect(first).resolves.toEqual({ threadId: thread, connected: true }); expect(counts.binds).toBe(1); expect(counts.bots).toBe(1)
  } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('a failed initialization is released and a fresh explicit connect may retry', async () => {
  const value = fixture(); const counts = { connects: 0, binds: 0, bots: 0, closes: 0, disconnects: 0 }; const dependencies = readyDependencies(value, counts); dependencies.connectTransport = async () => { counts.connects++; if (counts.connects === 1) throw new Error('synthetic transport failure'); return transport(() => { counts.closes++ }) as never }
  const service = new StandaloneTelegram(value.env, dependencies)
  try { await expect(service.connect(thread)).rejects.toThrow('synthetic transport failure'); await expect(service.connect(thread)).resolves.toEqual({ threadId: thread, connected: true }); expect(counts.connects).toBe(2); expect(counts.binds).toBe(1) } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('close before connect permanently rejects without starting I/O', async () => {
  const value = fixture(); const counts = { connects: 0, binds: 0, bots: 0, closes: 0, disconnects: 0 }; const service = new StandaloneTelegram(value.env, readyDependencies(value, counts))
  try { await service.close(); await expect(service.connect(thread)).rejects.toThrow('MCP is closed'); expect(counts.connects).toBe(0); expect(counts.binds).toBe(0); expect(counts.bots).toBe(0) } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('close during deferred transport cleans once and never binds, creates a bot, or polls', async () => {
  const value = fixture(); const gate = deferred<ReturnType<typeof transport>>(); const counts = { connects: 0, binds: 0, bots: 0, closes: 0, disconnects: 0 }; const dependencies = readyDependencies(value, counts); dependencies.connectTransport = async () => { counts.connects++; return await gate.promise as never }
  const service = new StandaloneTelegram(value.env, dependencies)
  try {
    const connecting = service.connect(thread); const closing = service.close(); expect(service.close()).toBe(closing)
    let settled = false; void closing.then(() => { settled = true }, () => { settled = true }); await Bun.sleep(1); expect(settled).toBeFalse()
    gate.resolve(transport(() => { counts.closes++ })); await expect(connecting).rejects.toThrow('MCP is closed'); await closing; expect(counts).toEqual({ connects: 1, binds: 0, bots: 0, closes: 1, disconnects: 0 })
  } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('close during deferred bind cleans the started host resources exactly once', async () => {
  const value = fixture(); const gate = deferred<{ controller: { disconnect: () => void; admit: () => Promise<unknown> }; cwd: string }>(); const counts = { connects: 0, binds: 0, bots: 0, closes: 0, disconnects: 0 }; const dependencies = readyDependencies(value, counts); dependencies.bindThread = (async () => { counts.binds++; return await gate.promise as never }) as never
  const service = new StandaloneTelegram(value.env, dependencies)
  try { const connecting = service.connect(thread); for (let attempt = 0; attempt < 20 && counts.binds === 0; attempt++) await Bun.sleep(1); const closing = service.close(); gate.resolve({ controller: { disconnect() { counts.disconnects++ }, async admit() { return {} } }, cwd: join(value.root, 'workspace') }); await expect(connecting).rejects.toThrow('MCP is closed'); await closing; expect(counts).toEqual({ connects: 1, binds: 1, bots: 0, closes: 1, disconnects: 1 }) } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('a reentrant close during transport is idempotent and prevents late bot polling', async () => {
  const value = fixture(); const counts = { connects: 0, binds: 0, bots: 0, closes: 0, disconnects: 0 }; let service!: StandaloneTelegram; const dependencies = readyDependencies(value, counts); dependencies.connectTransport = async () => { counts.connects++; void service.close(); return transport(() => { counts.closes++ }) as never }
  service = new StandaloneTelegram(value.env, dependencies)
  try { await expect(service.connect(thread)).rejects.toThrow('MCP is closed'); await service.close(); expect(counts).toEqual({ connects: 1, binds: 0, bots: 0, closes: 1, disconnects: 0 }) } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('reentrant connects during poll startup share the pending attempt and a getMe close cannot report connected', async () => {
  const value = fixture(); const counts = { connects: 0, binds: 0, bots: 0, closes: 0, disconnects: 0 }; let service!: StandaloneTelegram; let same!: Promise<Record<string, unknown>>; let foreign!: Promise<Record<string, unknown>>; let closing!: Promise<void>
  const dependencies = readyDependencies(value, counts)
  dependencies.createBot = (() => {
    counts.bots++
    return { api: { async getMe() { same = service.connect(thread); foreign = service.connect('foreign-thread'); void foreign.catch(() => {}); closing = service.close(); return { id: 1, username: 'synthetic_bot' } }, async getUpdates() { throw new Error('getUpdates must not start after close') } } } as never
  })
  service = new StandaloneTelegram(value.env, dependencies)
  try {
    const first = service.connect(thread)
    await Bun.sleep(1)
    expect(same).toBe(first); await expect(foreign).rejects.toThrow('different host thread'); await expect(first).rejects.toThrow('MCP is closed'); await expect(closing).resolves.toBeUndefined()
    expect(counts).toEqual({ connects: 1, binds: 1, bots: 1, closes: 1, disconnects: 1 })
  } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('cleanup continues through every owned resource and releases the owner lock after failures', async () => {
  const value = fixture(); const counts = { connects: 0, binds: 0, bots: 0, closes: 0, disconnects: 0, relayCloses: 0, unobserves: 0 }; let requestObservers = 0; const dependencies = readyDependencies(value, counts)
  dependencies.connectTransport = async () => {
    counts.connects++
    return {
      close() { counts.closes++; throw new Error('transport close failure') },
      async request() { return {} },
      onNotification() { return () => { counts.relayCloses++; throw new Error('relay close failure') } },
      onServerRequest() { requestObservers++; return requestObservers === 1 ? () => { counts.unobserves++; throw new Error('unobserve failure') } : () => {} },
    } as never
  }
  dependencies.bindThread = (async () => {
    counts.binds++
    return { controller: { disconnect() { counts.disconnects++; throw new Error('controller disconnect failure') }, async admit() { return { duplicate: false as const, disposition: 'queued' as const } } } as never, cwd: join(value.root, 'workspace') }
  }) as never
  const service = new StandaloneTelegram(value.env, dependencies)
  try {
    await expect(service.connect(thread)).resolves.toEqual({ threadId: thread, connected: true })
    const closing = service.close(); expect(service.close()).toBe(closing); await expect(closing).rejects.toThrow('relay close failure')
    expect(counts).toEqual({ connects: 1, binds: 1, bots: 1, closes: 1, disconnects: 1, relayCloses: 1, unobserves: 1 })
    expect(existsSync(join(value.stateDir, 'standalone-telegram.lock'))).toBeFalse()
  } finally { await service.close().catch(() => {}); rmSync(value.root, { recursive: true, force: true }) }
})
