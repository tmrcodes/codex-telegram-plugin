import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTuiThreadTransitionProxy, type TelegramOwnerTransition } from './tui-thread-transition-proxy'

const ROOT = '11111111-1111-1111-1111-111111111111'
const NEXT = '22222222-2222-2222-2222-222222222222'
const cleanup: string[] = []
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }) })

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause?: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }
function masked(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value)); const key = Buffer.from([1, 2, 3, 4]); const encoded = Buffer.from(payload)
  for (let index = 0; index < encoded.byteLength; index++) encoded[index] ^= key[index % 4]!
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.byteLength]), key, encoded])
}
function server(value: unknown): Buffer { const payload = Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]) }
function decodeClient(frame: Buffer): any { const length = frame[1]! & 0x7f; const key = frame.subarray(2, 6); const payload = Buffer.from(frame.subarray(6, 6 + length)); for (let index = 0; index < payload.byteLength; index++) payload[index] ^= key[index % 4]!; return JSON.parse(payload.toString()) }
function decodeServer(frame: Buffer): any { const marker = frame[1]! & 0x7f; const offset = marker < 126 ? 2 : 4; const length = marker < 126 ? marker : frame.readUInt16BE(2); return JSON.parse(frame.subarray(offset, offset + length).toString()) }
function decodeServers(frames: Buffer): any[] { const result: any[] = []; let offset = 0; while (offset < frames.byteLength) { const marker = frames[offset + 1]! & 0x7f; const head = marker < 126 ? 2 : 4; const length = marker < 126 ? marker : frames.readUInt16BE(offset + 2); result.push(JSON.parse(frames.subarray(offset + head, offset + head + length).toString())); offset += head + length } return result }
async function listen(server: Server, path: string): Promise<void> { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { chmodSync(path, 0o600); server.off('error', reject); resolve() }) }) }
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
async function waitFor(predicate: () => boolean): Promise<void> { for (let tries = 0; tries < 100; tries++) { if (predicate()) return; await Bun.sleep(1) }; throw new Error('fixture did not settle') }

async function fixture(owner: TelegramOwnerTransition) {
  const directory = mkdtempSync(join(tmpdir(), 'tui-transition-')); cleanup.push(directory); chmodSync(directory, 0o700)
  const upstreamPath = join(directory, 'host.sock'); const proxyPath = join(directory, 'transition.sock')
  const received: any[] = []; let upstreamClient: Socket | undefined; let head = Buffer.alloc(0)
  const upstream = createServer(socket => {
    upstreamClient = socket
    socket.on('data', chunk => {
      head = Buffer.concat([head, Buffer.from(chunk)]); const end = head.indexOf('\r\n\r\n')
      if (end >= 0) { socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); head = head.subarray(end + 4) }
      if (head.byteLength) { received.push(decodeClient(head)); head = Buffer.alloc(0) }
    })
  })
  await listen(upstream, upstreamPath)
  const proxy = await startTuiThreadTransitionProxy({ listenSocket: proxyPath, upstreamSocket: upstreamPath, owner })
  const client = createConnection(proxyPath); client.write('GET / HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: test\r\n\r\n')
  await new Promise<void>((resolve, reject) => { client.once('data', () => resolve()); client.once('error', reject) })
  const next = () => new Promise<any>((resolve, reject) => { client.once('data', frame => resolve(decodeServer(Buffer.from(frame)))); client.once('error', reject) })
  return { client, received, upstream: () => upstreamClient!, upstreamServer: upstream, proxy, proxyPath, next, close: async () => { client.destroy(); await proxy.close(); await close(upstream) } }
}

function owner(overrides: Partial<TelegramOwnerTransition> = {}) {
  const starts: string[] = []; const prepares: string[] = []; const aborts: string[] = []; const transitions: Array<[string, string]> = []
  return {
    starts, prepares, aborts, transitions,
    value: { start: async (id: string) => { starts.push(id) }, prepare: async (from: string) => { prepares.push(from) }, commit: async (from: string, to: string) => { transitions.push([from, to]) }, abort: async (from: string) => { aborts.push(from) }, close: async () => {}, ...overrides } satisfies TelegramOwnerTransition,
  }
}
async function bind(session: Awaited<ReturnType<typeof fixture>>) {
  session.client.write(masked({ jsonrpc: '2.0', id: 1, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 1)
  const response = session.next(); session.upstream().write(server({ jsonrpc: '2.0', id: 1, result: { thread: { id: ROOT } } })); await expect(response).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { thread: { id: ROOT } } })
}

describe('remote TUI thread transition proxy', () => {
  test('accepts the versionless JSON-RPC dialect emitted by stock Codex TUI', async () => {
    const tracked = owner(); const session = await fixture(tracked.value)
    try {
      session.client.write(masked({ id: 1, method: 'thread/resume', params: { threadId: ROOT } })); await waitFor(() => session.received.length === 1)
      expect(session.received[0]).toEqual({ id: 1, method: 'thread/resume', params: { threadId: ROOT } })
      const response = session.next(); session.upstream().write(server({ id: 1, result: { thread: { id: ROOT } } }))
      await expect(response).resolves.toEqual({ id: 1, result: { thread: { id: ROOT } } })
      expect(tracked.starts).toEqual([ROOT]); expect(session.proxy.boundThreadId()).toBe(ROOT)
    } finally { await session.close() }
  })

  test('binds the first exact successful root response and preserves unrelated frames', async () => {
    const tracked = owner(); const session = await fixture(tracked.value)
    try {
      const notification = session.next(); session.upstream().write(server({ jsonrpc: '2.0', method: 'item/updated', params: { keep: true } }))
      await expect(notification).resolves.toEqual({ jsonrpc: '2.0', method: 'item/updated', params: { keep: true } })
      await bind(session); expect(tracked.starts).toEqual([ROOT]); expect(session.proxy.boundThreadId()).toBe(ROOT)
      session.client.write(masked({ jsonrpc: '2.0', id: 9, method: 'thread/read', params: { threadId: ROOT } })); await waitFor(() => session.received.length === 2)
      expect(session.received[1]).toMatchObject({ method: 'thread/read' })
    } finally { await session.close() }
  })

  test('holds a successful /new response until the owner accepts the exact root transition', async () => {
    const gate = deferred<void>(); const tracked = owner({ commit: async (from, to) => { tracked.transitions.push([from, to]); await gate.promise } }); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 2); expect(tracked.prepares).toEqual([ROOT])
      session.upstream().write(server({ jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } })); await waitFor(() => tracked.transitions.length === 1)
      expect(session.proxy.boundThreadId()).toBe(ROOT); gate.resolve(); await expect(session.next()).resolves.toEqual({ jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } })
      expect(tracked.transitions).toEqual([[ROOT, NEXT]]); expect(session.proxy.boundThreadId()).toBe(NEXT)
    } finally { await session.close() }
  })

  test('prepares the owner fence before forwarding a root-changing host request', async () => {
    const gate = deferred<void>(); const tracked = owner({ prepare: async from => { tracked.prepares.push(from); await gate.promise } }); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await Bun.sleep(1)
      expect(tracked.prepares).toEqual([ROOT]); expect(session.received).toHaveLength(1); gate.resolve(); await waitFor(() => session.received.length === 2)
    } finally { await session.close() }
  })

  test('releases a coalesced post-response notification only after the committed root response', async () => {
    const gate = deferred<void>(); const tracked = owner({ commit: async (from, to) => { tracked.transitions.push([from, to]); await gate.promise } }); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 2)
      const received = new Promise<Buffer>((resolve, reject) => { session.client.once('data', data => resolve(Buffer.from(data))); session.client.once('error', reject) })
      const root = { jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } }; const note = { jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: NEXT } } }
      session.upstream().write(Buffer.concat([server(root), server(note)])); await waitFor(() => tracked.transitions.length === 1); gate.resolve()
      await expect(received).resolves.toEqual(Buffer.concat([server(root), server(note)])); expect(session.proxy.boundThreadId()).toBe(NEXT)
    } finally { await session.close() }
  })

  test('bounds coalesced server buffering during commit and recovers the committed new root on overflow', async () => {
    const gate = deferred<void>(); let ownerRoot = ROOT; const tracked = owner({ commit: async (from, to) => { tracked.transitions.push([from, to]); await gate.promise; ownerRoot = to } }); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 2)
      const root = { jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } }; const note = { jsonrpc: '2.0', method: 'item/updated', params: { keep: true } }
      session.upstream().write(Buffer.concat([server(root), ...Array.from({ length: 1025 }, () => server(note))])); await Bun.sleep(20); expect(tracked.transitions).toHaveLength(1)
      const recovering = session.proxy.nextRecovery(); gate.resolve(); await expect(recovering).resolves.toBe(NEXT); expect(session.proxy.boundThreadId()).toBe(NEXT); expect(ownerRoot).toBe(NEXT)
    } finally { await session.close().catch(() => {}) }
  })

  test('terminates instead of committing twice for a duplicate matched root response', async () => {
    const gate = deferred<void>(); const tracked = owner({ commit: async () => gate.promise }); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 2)
      session.upstream().write(server({ jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } })); session.upstream().write(server({ jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } }))
      gate.resolve(); await new Promise<void>(resolve => session.client.once('close', resolve)); expect(tracked.transitions).toEqual([]); expect(tracked.aborts).toEqual([])
    } finally { await session.close().catch(() => {}) }
  })

  test('forwards a host rejection unchanged and keeps the old owner binding', async () => {
    const tracked = owner(); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 2)
      const response = session.next(); const disconnected = new Promise<void>(resolve => session.client.once('close', resolve)); const hostError = { jsonrpc: '2.0', id: 2, error: { code: -1, message: 'host rejected' } }; session.upstream().write(server(hostError))
      await expect(response).resolves.toEqual(hostError); await expect(session.proxy.nextRecovery()).resolves.toBe(ROOT); await disconnected
      const restored = createConnection(session.proxyPath); restored.write('GET / HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: restored\r\n\r\n')
      await new Promise<void>((resolve, reject) => { restored.once('data', () => resolve()); restored.once('error', reject) }); restored.write(masked({ jsonrpc: '2.0', id: 3, method: 'thread/read', params: { threadId: ROOT } }))
      await waitFor(() => session.received.length === 3); expect(session.received[2]).toMatchObject({ method: 'thread/read', params: { threadId: ROOT } }); restored.destroy()
      expect(tracked.transitions).toEqual([]); expect(tracked.aborts).toEqual([ROOT]); expect(session.proxy.boundThreadId()).toBe(ROOT)
    } finally { await session.close() }
  })

  test('returns an owner failure for the matching root response and never changes the binding', async () => {
    const tracked = owner({ commit: async () => { throw new Error('owner unavailable') } }); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 2)
      const response = session.next(); session.upstream().write(server({ jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } }))
      await expect(response).resolves.toMatchObject({ id: 2, error: { code: -32011 } }); await expect(session.proxy.nextRecovery()).resolves.toBe(ROOT); expect(session.proxy.boundThreadId()).toBe(ROOT)
    } finally { await session.close() }
  })

  test('rejects a concurrent root transition without sending another host request', async () => {
    const gate = deferred<void>(); const tracked = owner({ commit: async () => gate.promise }); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 2)
      session.upstream().write(server({ jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } })); session.client.write(masked({ jsonrpc: '2.0', id: 3, method: 'thread/start', params: {} }))
      await expect(session.next()).resolves.toMatchObject({ id: 3, error: { code: -32012 } }); expect(session.received).toHaveLength(2)
      gate.resolve(); await expect(session.next()).resolves.toMatchObject({ id: 2, result: { thread: { id: NEXT } } })
    } finally { await session.close() }
  })

  test('clean terminal lifecycle closes the owned socket and prevents a late owner result from changing state', async () => {
    const gate = deferred<void>(); let closed = 0; const tracked = owner({ commit: async () => gate.promise, close: async () => { closed++ } }); const session = await fixture(tracked.value)
    try {
      await bind(session); session.client.write(masked({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })); await waitFor(() => session.received.length === 2)
      session.upstream().write(server({ jsonrpc: '2.0', id: 2, result: { thread: { id: NEXT } } })); await session.proxy.close(); gate.resolve(); await Bun.sleep(1)
      expect(existsSync(session.proxyPath)).toBeFalse(); expect(session.proxy.boundThreadId()).toBe(ROOT); expect(closed).toBe(1)
    } finally { session.client.destroy(); await close(session.upstreamServer) }
  })
})
