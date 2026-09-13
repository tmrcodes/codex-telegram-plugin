import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_REQUEST_CANCELLED, type AppServerTransport } from './protocol'
import { safeStandaloneToolError, StandaloneTelegram, type StandaloneTelegramDependencies } from './standalone-telegram'

const thread = '11111111-2222-4333-8444-555555555555'
const policy = (permissions = false) => ({ schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: ['700001'], groups: { '-100999': { allowFrom: ['700001'], requireMention: false } }, mentionPatterns: [], ackReaction: '', typing: false, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'length', deliveryMode: 'auto', permissions: { enabled: permissions, operatorDmChatIds: permissions ? ['700001'] : [] }, pending: [] })
function privateFile(path: string, value: string): void { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600) }
function fixture(permissions = false) {
  const root = mkdtempSync(join(tmpdir(), 'standalone-telegram-')); const stateDir = join(root, 'state'); mkdirSync(stateDir, { mode: 0o700 }); chmodSync(stateDir, 0o700)
  const policyFile = join(root, 'telegram.json'); const tokenFile = join(root, 'token'); const configFile = join(root, 'connection.json'); privateFile(policyFile, JSON.stringify(policy(permissions))); privateFile(tokenFile, 'synthetic-secret-token')
  privateFile(configFile, JSON.stringify({ schemaVersion: 1, appServerSocket: join(root, 'host.sock'), policyFile, botTokenFile: tokenFile, stateDir }))
  return { root, stateDir, env: { CODEX_TELEGRAM_CONFIG: configFile } }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value }); return { promise, resolve } }
async function eventually(check: () => boolean): Promise<void> { for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await Bun.sleep(10) } throw new Error('timed out waiting for standalone health') }
function health(path: string): Record<string, unknown> { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
function host(value: ReturnType<typeof fixture>, bot: unknown, disconnect: () => void = () => {}): StandaloneTelegramDependencies { return { connectTransport: async () => ({ close() {}, async request() { return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }) as never, bindThread: (async () => ({ controller: { disconnect, async admit() { return { duplicate: false as const, disposition: 'queued' as const } } } as never, cwd: join(value.root, 'workspace') })) as never, createBot: () => bot as never, acquireOwnerLease: () => ({ release() {} }) } }

test('standalone connect is exact-thread idempotent, ignores App Server approvals, and releases only its lock', async () => {
  const value = fixture(); let connects = 0; let bots = 0; let preBind: unknown; let listenersWhenClosed = 0; const requests = new Set<(id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown>>()
  const serverRequest = async (id: string | number, method: string, params: Record<string, unknown>) => await [...requests].at(-1)!(id, method, params)
  const transport = { close() { listenersWhenClosed = requests.size }, async request() { throw new Error('observer must not decide') }, onNotification() { return () => {} }, onServerRequest(listener: (id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown>) { requests.add(listener); return () => { requests.delete(listener) } } }
  const controller = { disconnect() {}, async admit() { return { duplicate: false as const, disposition: 'queued' as const } } }
  const service = new StandaloneTelegram(value.env, { connectTransport: async () => { connects++; return transport as never }, bindThread: (async (_transport: AppServerTransport, _version: string, id: string) => { if (id !== thread) throw new Error('wrong test thread'); preBind = await serverRequest(1, 'approval/request', {}); return { controller: controller as never, cwd: join(value.root, 'workspace') } }) as never, createBot: (() => { bots++; return { api: { async getMe() { return { id: 900001, username: 'synthetic_bot' } } } } as never }), acquireOwnerLease: () => ({ release() {} }) })
  try {
    expect(connects).toBe(0); expect(bots).toBe(0)
    await expect(service.connect(thread)).resolves.toEqual({ threadId: thread, connected: true }); expect(preBind).toBe(SERVER_REQUEST_CANCELLED); expect(connects).toBe(1); expect(bots).toBe(1)
    await expect(service.connect(thread)).resolves.toEqual({ threadId: thread, connected: true }); expect(connects).toBe(1)
    await expect(service.connect('other-host-thread')).rejects.toThrow('different host thread'); expect(connects).toBe(1)
    await expect(serverRequest(1, 'approval/request', {})).resolves.toBe(SERVER_REQUEST_CANCELLED)
    expect(existsSync(join(value.stateDir, 'standalone-telegram.lock'))).toBeTrue(); await service.close(); expect(listenersWhenClosed).toBe(1); expect(existsSync(join(value.stateDir, 'standalone-telegram.lock'))).toBeFalse()
  } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('standalone rejects a live owner before transport or token use', async () => {
  const value = fixture(); let connects = 0; let bots = 0
  const service = new StandaloneTelegram(value.env, { connectTransport: async () => { connects++; throw new Error('must not connect') }, createBot: (() => { bots++; throw new Error('must not create bot') }) as never })
  try {
    const healthPath = join(value.stateDir, 'telegram-health.json'); privateFile(healthPath, `${JSON.stringify({ consecutiveErrors: 3, totalErrors: 7, consecutive409: 0, policyValid: true, running: true, policyFingerprint: 'incumbent' })}\n`); const before = readFileSync(healthPath, 'utf8')
    privateFile(join(value.stateDir, 'standalone-telegram.lock'), JSON.stringify({ pid: process.pid, nonce: 'other-owner' }))
    await expect(service.connect(thread)).rejects.toThrow('live standalone owner'); expect(connects).toBe(0); expect(bots).toBe(0); expect(existsSync(join(value.stateDir, 'standalone-telegram.lock'))).toBeTrue(); expect(readFileSync(healthPath, 'utf8')).toBe(before)
  } finally { await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('standalone sanitizes direct Telegram credential URLs while retaining a real status', () => {
  const token = `123456:${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'}`; const message = safeStandaloneToolError(new Error(`400 Bad Request https://api.telegram.org/bot${token}/sendMessage`))
  expect(message).toContain('400 Bad Request'); expect(message).not.toContain(token); expect(message).not.toContain('https://api.telegram.org')
})

test('standalone health records a transient poll failure, sanitized recovery, and normal close atomically', async () => {
  const value = fixture(); const healthy = deferred<unknown[]>(); const hold = deferred<unknown[]>(); const token = `123456:${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'}`; let polls = 0
  const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { polls++; if (polls === 1) throw new Error(`401 unauthorized https://api.telegram.org/bot${token}/getUpdates`); if (polls === 2) return await healthy.promise; return await hold.promise } } }
  const service = new StandaloneTelegram(value.env, host(value, bot)); const path = join(value.stateDir, 'telegram-health.json')
  try {
    await service.connect(thread); await eventually(() => existsSync(path) && health(path).totalErrors === 1)
    const failed = health(path); expect(failed).toMatchObject({ consecutiveErrors: 1, totalErrors: 1, policyValid: true, running: true, lastStatus: 401 }); expect(JSON.stringify(failed)).not.toContain(token); expect(JSON.stringify(failed)).not.toContain('https://api.telegram.org'); expect(statSync(path).mode & 0o777).toBe(0o600)
    healthy.resolve([]); await eventually(() => health(path).lastSuccessfulPoll !== undefined && health(path).consecutiveErrors === 0)
    expect(health(path)).toMatchObject({ consecutiveErrors: 0, consecutive409: 0, policyValid: true, running: true }); hold.resolve([]); await service.close(); expect(health(path).running).toBeFalse()
  } finally { hold.resolve([]); await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('standalone health marks malformed hot policy unhealthy and restores after an atomic policy recovery', async () => {
  const value = fixture(); const first = deferred<unknown[]>(); const second = deferred<unknown[]>(); const hold = deferred<unknown[]>(); let polls = 0
  const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { polls++; if (polls === 1) return await first.promise; if (polls === 2) return await second.promise; return await hold.promise } } }
  const service = new StandaloneTelegram(value.env, host(value, bot)); const path = join(value.stateDir, 'telegram-health.json'); const policyPath = join(value.root, 'telegram.json')
  try {
    await service.connect(thread); await eventually(() => polls === 1); privateFile(policyPath, '{'); first.resolve([]); await eventually(() => health(path).policyValid === false)
    expect(health(path)).toMatchObject({ policyValid: false, totalErrors: 1, running: true }); privateFile(policyPath, JSON.stringify(policy())); second.resolve([]); await eventually(() => health(path).policyValid === true && health(path).lastSuccessfulPoll !== undefined)
    expect(health(path)).toMatchObject({ consecutiveErrors: 0, policyValid: true, running: true })
  } finally { hold.resolve([]); await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('standalone records an invalid startup policy before binding and a later valid startup restores health', async () => {
  const value = fixture(); const policyPath = join(value.root, 'telegram.json'); const path = join(value.stateDir, 'telegram-health.json'); const hold = deferred<unknown[]>()
  privateFile(policyPath, '{'); const invalid = new StandaloneTelegram(value.env, host(value, { api: {} }))
  try {
    await expect(invalid.connect(thread)).rejects.toThrow('Telegram policy'); expect(health(path)).toMatchObject({ policyValid: false, running: false, totalErrors: 1 }); expect(statSync(path).mode & 0o777).toBe(0o600)
    privateFile(policyPath, JSON.stringify(policy())); const recovered = new StandaloneTelegram(value.env, host(value, { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { return await hold.promise } } }))
    try { await recovered.connect(thread); expect(health(path)).toMatchObject({ policyValid: true, running: true }); expect(health(path).policyFingerprint).toBeTypeOf('string') } finally { hold.resolve([]); await recovered.close() }
  } finally { hold.resolve([]); await invalid.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('standalone ignores a health write failure without disconnecting its host binding', async () => {
  const value = fixture(); const first = deferred<unknown[]>(); const hold = deferred<unknown[]>(); let polls = 0; let disconnects = 0
  const bot = { api: { async getMe() { return { id: 1, username: 'bot' } }, async getUpdates() { polls++; return await (polls === 1 ? first.promise : hold.promise) } } }
  const service = new StandaloneTelegram(value.env, host(value, bot, () => { disconnects++ }))
  try {
    await service.connect(thread); await eventually(() => polls === 1); chmodSync(value.stateDir, 0o500); first.resolve([]); await Bun.sleep(30)
    await expect(service.connect(thread)).resolves.toEqual({ threadId: thread, connected: true }); expect(disconnects).toBe(0)
  } finally { hold.resolve([]); chmodSync(value.stateDir, 0o700); await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('standalone close retires a bound pending relay before releasing only its lock', async () => {
  const value = fixture(true); let request!: (id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown>; let cards = 0; const poll = deferred<unknown[]>()
  const transport = { close() {}, async request() { return {} }, onNotification() { return () => {} }, onServerRequest(listener: typeof request) { request = listener; return () => {} } }
  const controller = { disconnect() {}, async admit() { return { duplicate: false as const, disposition: 'queued' as const } } }
  const bot = { api: { async getMe() { return { id: 900001, username: 'synthetic_bot' } }, async getUpdates() { return await poll.promise }, async sendMessage() { cards++; return { message_id: 1 } }, async editMessageText() {} } }
  const service = new StandaloneTelegram(value.env, { connectTransport: async () => transport as never, bindThread: (async () => ({ controller: controller as never, cwd: join(value.root, 'workspace') })) as never, createBot: () => bot as never, acquireOwnerLease: () => ({ release() {} }) })
  try {
    await service.connect(thread); const pending = request('pending', 'item/fileChange/requestApproval', { threadId: thread, turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); expect(cards).toBe(1)
    poll.resolve([]); await service.close(); await expect(pending).resolves.toEqual({ decision: 'decline' }); expect(existsSync(join(value.stateDir, 'standalone-telegram.lock'))).toBeFalse()
  } finally { poll.resolve([]); await service.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('a bound standalone child exits on stdio EOF and releases its owner lock', async () => {
  const value = fixture(true); const module = join(import.meta.dir, 'standalone-telegram.ts'); const source = `
    import { StandaloneTelegram, serveStandaloneTelegram } from ${JSON.stringify(module)}
    const service = new StandaloneTelegram(process.env, {
      connectTransport: async () => ({ close() {}, async request() { return {} }, onNotification() { return () => {} }, onServerRequest(listener) { void listener('pending', 'item/fileChange/requestApproval', { threadId: ${JSON.stringify(thread)}, turnId: 'turn', itemId: 'item', startedAtMs: 1 }); return () => {} } }),
      bindThread: async () => ({ controller: { disconnect() {}, async admit() { return { duplicate: false, disposition: 'queued' } } }, cwd: ${JSON.stringify(join(value.root, 'workspace'))} }),
      createBot: () => ({ api: { async getMe() { return { id: 900001, username: 'synthetic_bot' } }, async getUpdates(_request, signal) { return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic poll aborted')), { once: true })) }, async sendMessage() { return { message_id: 1 } }, async editMessageText() {} } }),
      acquireOwnerLease: () => ({ release() {} }),
    })
    await serveStandaloneTelegram(service)
  `
  const child = Bun.spawn([process.execPath, '--eval', source], { cwd: import.meta.dir, env: { ...process.env, CODEX_TELEGRAM_CONFIG: value.env.CODEX_TELEGRAM_CONFIG! }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }); const decoder = new TextDecoder(); const reader = child.stdout.getReader(); let output = ''
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1.0.0' } } })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connect', arguments: {}, _meta: { threadId: thread } } })}\n`)
    while (!output.includes('"id":2')) { const next = await reader.read(); if (next.done) throw new Error(`standalone child ended before connect: ${output}`); output += decoder.decode(next.value) }
    const connect = JSON.parse(output.split('\n').find(line => line.includes('"id":2'))!); expect(connect.result).toMatchObject({ content: [{ type: 'text', text: 'Telegram connected.' }], structuredContent: { threadId: thread, connected: true, success: true, operation: 'connect' } }); expect(existsSync(join(value.stateDir, 'standalone-telegram.lock'))).toBeTrue(); child.stdin.end()
    await expect(Promise.race([child.exited, Bun.sleep(2_000).then(() => { throw new Error('standalone child did not exit after stdin EOF') })])).resolves.toBe(0)
    expect(existsSync(join(value.stateDir, 'standalone-telegram.lock'))).toBeFalse()
  } finally { child.kill(); await reader.cancel().catch(() => {}); rmSync(value.root, { recursive: true, force: true }) }
})
