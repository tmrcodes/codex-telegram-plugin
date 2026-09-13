#!/usr/bin/env bun
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'

/**
 * One remote-TUI connection may change its visible root only after its owner
 * has accepted the exact host-created replacement. This is a transport seam,
 * not a controller: it does not poll, select a route, replay history, or
 * create host requests.
 */
export type TelegramOwnerTransition = {
  start(threadId: string): Promise<void>
  prepare(fromThreadId: string): Promise<void>
  commit(fromThreadId: string, toThreadId: string): Promise<void>
  abort(fromThreadId: string): Promise<void>
  close(): Promise<void>
}

export type TuiThreadTransitionProxy = {
  close(): Promise<void>
  boundThreadId(): string | undefined
  /** True until a root transition either commits or publishes exact recovery. */
  transitionPending(): boolean
  /** Resolves only when a failed root operation needs the TUI resumed exactly. */
  nextRecovery(): Promise<string>
}
export type TuiThreadTransitionProxyOptions = {
  listenSocket: string
  upstreamSocket: string
  owner: TelegramOwnerTransition
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_BUFFERED_SERVER_FRAMES = 1024
const MAX_BUFFERED_SERVER_BYTES = 16 * 1024 * 1024
const OWNER_FAILURE = -32011
const TRANSITION_BUSY = -32012
type Id = string | number
type Json = Record<string, unknown>
type Frame = { fin: boolean; opcode: number; payload: Buffer; raw: Buffer }
type RootRequest = { id: Id; kind: 'initial' | 'transition'; from?: string; expectedThreadId?: string; jsonrpc?: '2.0' }
type Pending = RootRequest & { phase: 'preparing' | 'awaiting-host' | 'committing'; targetThreadId?: string; operation?: Promise<void> }

export function startTuiThreadTransitionProxy(options: TuiThreadTransitionProxyOptions): Promise<TuiThreadTransitionProxy> {
  validateOptions(options)
  validateSocketParent(options.listenSocket)
  validateUpstream(options.upstreamSocket)
  if (existsSync(options.listenSocket)) return Promise.reject(new Error('TUI transition socket already exists'))
  let bound: string | undefined
  let closing: Promise<void> | undefined
  let transitionPending = false
  const recoveries: string[] = []
  let resolveRecovery: ((threadId: string) => void) | undefined
  const requestRecovery = (threadId: string) => {
    const resolve = resolveRecovery; resolveRecovery = undefined
    if (resolve !== undefined) resolve(threadId); else recoveries.push(threadId)
  }
  const clients = new Set<Socket>()
  const transitionSettles = new Set<Promise<unknown>>()
  const server = createServer(client => {
    if (clients.size) { client.destroy(); return }
    clients.add(client); client.once('close', () => clients.delete(client))
    bridge(client, options.upstreamSocket, () => bound, id => { bound = id }, requestRecovery, active => { transitionPending = active }, options.owner, pending => { transitionSettles.add(pending); void pending.then(() => transitionSettles.delete(pending), () => transitionSettles.delete(pending)) })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listenSocket, () => {
      try {
        const identity = socketIdentity(options.listenSocket)
        server.off('error', reject)
        resolve({ boundThreadId: () => bound, transitionPending: () => transitionPending, nextRecovery: () => {
          const threadId = recoveries.shift()
          if (threadId !== undefined) return Promise.resolve(threadId)
          return new Promise<string>(done => { resolveRecovery = done })
        }, close: () => closing ??= (async () => {
          try { await closeServer(server, options.listenSocket, clients, identity); await Promise.allSettled([...transitionSettles]) }
          finally { await options.owner.close() }
        })() })
      } catch (error) { server.close(() => reject(error)) }
    })
  })
}

function bridge(client: Socket, upstreamPath: string, bound: () => string | undefined, setBound: (id: string) => void, requestRecovery: (threadId: string) => void, setTransitionPending: (active: boolean) => void, owner: TelegramOwnerTransition, trackTransition: (pending: Promise<unknown>) => void): void {
  const upstream = createConnection(upstreamPath)
  let clientHead = Buffer.alloc(0); let serverHead = Buffer.alloc(0)
  let clientUpgraded = false; let serverUpgraded = false
  const clientFrames = new FrameDecoder(true); const serverFrames = new FrameDecoder(false)
  const clientFragments: Frame[] = []; const serverFragments: Frame[] = []
  let pending: Pending | undefined; let closed = false; let ending = false; const bufferedServer: Frame[][] = []; let bufferedServerFrames = 0; let bufferedServerBytes = 0
  const closeBoth = () => { if (closed) return; closed = true; client.destroy(); upstream.destroy() }
  const closeAfterFlush = () => {
    if (closed) return; closed = true; upstream.destroy(); client.end()
    const timer = setTimeout(() => client.destroy(), 100); timer.unref()
  }
  const terminate = () => {
    if (ending) return; ending = true
    const active = pending; pending = undefined; bufferedServer.length = 0; bufferedServerFrames = 0; bufferedServerBytes = 0
    const prior = active?.operation ?? Promise.resolve()
    const terminal = (async (): Promise<string | undefined> => {
      if (active?.phase === 'committing' && active.from !== undefined) {
        try { await prior; if (active.targetThreadId === undefined) throw new Error('missing committed root'); setBound(active.targetThreadId); return active.targetThreadId }
        catch { await owner.abort(active.from).catch(() => {}); return active.from }
      }
      if (active?.kind === 'transition' && active.from !== undefined) { await prior.catch(() => {}); await owner.abort(active.from).catch(() => {}); return active.from }
      await prior.catch(() => {}); return undefined
    })()
    trackTransition(terminal)
    void terminal.then(threadId => { if (threadId !== undefined) requestRecovery(threadId); setTransitionPending(false) }).finally(closeAfterFlush)
  }
  client.once('error', terminate); upstream.once('error', terminate)
  client.once('end', () => upstream.end()); upstream.once('end', () => client.end())
  client.once('close', terminate); upstream.once('close', terminate)

  client.on('data', data => {
    const bytes = Buffer.from(data)
    if (!clientUpgraded) {
      clientHead = Buffer.concat([clientHead, bytes]); const end = clientHead.indexOf('\r\n\r\n')
      if (end < 0) { if (clientHead.byteLength > 64 * 1024) closeBoth(); return }
      const head = clientHead.subarray(0, end + 4); const rest = clientHead.subarray(end + 4); clientHead = Buffer.alloc(0)
      clientUpgraded = /^GET\s/mu.test(head.toString('ascii')); upstream.write(head); if (rest.byteLength) handleClient(rest); return
    }
    handleClient(bytes)
  })
  upstream.on('data', data => {
    const bytes = Buffer.from(data)
    if (!serverUpgraded) {
      serverHead = Buffer.concat([serverHead, bytes]); const end = serverHead.indexOf('\r\n\r\n')
      if (end < 0) { if (serverHead.byteLength > 64 * 1024) closeBoth(); return }
      const head = serverHead.subarray(0, end + 4); const rest = serverHead.subarray(end + 4); serverHead = Buffer.alloc(0)
      serverUpgraded = /^HTTP\/1\.1 101\b/mu.test(head.toString('ascii')); client.write(head); if (rest.byteLength) handleServer(rest); return
    }
    handleServer(bytes)
  })

  function handleClient(bytes: Buffer): void {
    try {
      for (const frame of clientFrames.push(bytes)) {
        const message = collectText(frame, clientFragments)
        if (message === undefined) { upstream.write(frame.raw); continue }
        const request = parseRpc(message.payload)
        if (request === 'invalid') { terminate(); return }
        const root = rootRequest(request, bound())
        if (root === undefined) { forward(upstream, message.frames); continue }
        if (pending) { client.write(textFrame(JSON.stringify(errorResponse(root.id, TRANSITION_BUSY, 'A root transition is already in progress', root.jsonrpc)))); continue }
        pending = { ...root, phase: root.kind === 'initial' ? 'awaiting-host' : 'preparing' }
        if (root.kind === 'transition') setTransitionPending(true)
        if (root.kind === 'initial') { forward(upstream, message.frames); continue }
        const active = pending
        const operation = owner.prepare(root.from!); active.operation = operation; trackTransition(operation)
        void operation.then(() => {
          if (closed || pending !== active) return
          active.phase = 'awaiting-host'; forward(upstream, message.frames)
        }, () => { if (!closed && pending === active) { client.write(textFrame(JSON.stringify(errorResponse(root.id, OWNER_FAILURE, 'Telegram owner could not prepare this root transition', root.jsonrpc)))); terminate() } })
      }
    } catch { closeBoth() }
  }
  function handleServer(bytes: Buffer): void {
    try {
      for (const frame of serverFrames.push(bytes)) {
        const message = collectText(frame, serverFragments)
        if (message === undefined) { client.write(frame.raw); continue }
        const response = parseRpc(message.payload)
        if (response === 'invalid') { terminate(); return }
        const active = pending
        if (active?.phase === 'committing') {
          if (matches(response, active)) terminate()
          else {
            const bytes = message.frames.reduce((total, item) => total + item.raw.byteLength, 0)
            if (bufferedServerFrames + message.frames.length > MAX_BUFFERED_SERVER_FRAMES || bufferedServerBytes + bytes > MAX_BUFFERED_SERVER_BYTES) { terminate(); return }
            bufferedServer.push(message.frames); bufferedServerFrames += message.frames.length; bufferedServerBytes += bytes
          }
          continue
        }
        if (!matches(response, active)) { forward(client, message.frames); continue }
        if (active!.phase !== 'awaiting-host') { terminate(); return }
        if (Object.hasOwn(response!, 'error')) { forward(client, message.frames); terminate(); continue }
        const id = threadIdFrom(response!)
        if (!id || (active!.expectedThreadId !== undefined && id !== active!.expectedThreadId)) { client.write(textFrame(JSON.stringify(errorResponse(active!.id, OWNER_FAILURE, 'Host root response did not contain the requested thread ID', active!.jsonrpc)))); terminate(); continue }
        active!.phase = 'committing'; active!.targetThreadId = id
        const operation = Promise.resolve().then(() => active!.kind === 'initial' ? owner.start(id) : owner.commit(active!.from!, id)); active!.operation = operation; trackTransition(operation)
        void operation.then(() => {
          if (closed || pending !== active) return
          pending = undefined; setBound(id); setTransitionPending(false); forward(client, message.frames); for (const frames of bufferedServer.splice(0)) forward(client, frames); bufferedServerFrames = 0; bufferedServerBytes = 0
        }, () => {
          if (closed || pending !== active) return
          client.write(textFrame(JSON.stringify(errorResponse(active!.id, OWNER_FAILURE, active!.kind === 'initial' ? 'Telegram owner could not start for this root' : 'Telegram owner could not commit this root transition', active!.jsonrpc)))); terminate()
        })
      }
    } catch { closeBoth() }
  }
}

function rootRequest(value: Json | undefined, bound: string | undefined): RootRequest | undefined {
  if (value === undefined || typeof value.method !== 'string') return undefined
  if (!['thread/start', 'thread/resume', 'thread/fork'].includes(value.method)) return undefined
  if ((value.jsonrpc !== undefined && value.jsonrpc !== '2.0') || !validId(value.id)) throw new Error('invalid root JSON-RPC request')
  const dialect = value.jsonrpc === '2.0' ? { jsonrpc: '2.0' as const } : {}
  const params = object(value.params) ? value.params : undefined
  if (bound === undefined) {
    if (value.method === 'thread/fork') throw new Error('root fork requires an existing root binding')
    const expected = value.method === 'thread/resume' ? params?.threadId : undefined
    if (expected !== undefined && (typeof expected !== 'string' || !UUID.test(expected))) throw new Error('invalid root resume request')
    return { id: value.id, kind: 'initial', ...dialect, ...(typeof expected === 'string' ? { expectedThreadId: expected } : {}) }
  }
  if (value.method === 'thread/start') return { id: value.id, kind: 'transition', from: bound, ...dialect }
  if (value.method === 'thread/resume') {
    const target = params?.threadId
    if (typeof target !== 'string' || !UUID.test(target)) throw new Error('invalid root resume request')
    return target === bound ? undefined : { id: value.id, kind: 'transition', from: bound, expectedThreadId: target, ...dialect }
  }
  if (value.method === 'thread/fork') {
    if (params?.threadId !== bound || params?.excludeTurns === true) throw new Error('root fork does not match the bound root')
    return { id: value.id, kind: 'transition', from: bound, ...dialect }
  }
  return undefined
}
function matches(value: Json | undefined, pending: Pending | undefined): value is Json {
  return value !== undefined && pending !== undefined && value.id === pending.id && typeof value.method !== 'string' && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))
}
function threadIdFrom(response: Json): string | undefined {
  const result = response.result
  if (!object(result)) return undefined
  const thread = result.thread
  if (!object(thread)) return undefined
  const id = thread.id
  return typeof id === 'string' && UUID.test(id) ? id : undefined
}
function errorResponse(id: Id, code: number, message: string, jsonrpc?: '2.0'): Json { return { ...(jsonrpc ? { jsonrpc } : {}), id, error: { code, message } } }
function parseRpc(payload: Buffer): Json | undefined | 'invalid' {
  const text = payload.toString('utf8'); let value: unknown
  try { value = JSON.parse(text) } catch { return /^\s*[{[]/u.test(text) ? 'invalid' : undefined }
  return Array.isArray(value) ? 'invalid' : object(value) ? value : undefined
}
function object(value: unknown): value is Json { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function validId(value: unknown): value is Id { return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) }
function forward(socket: Socket, frames: readonly Frame[]): void { for (const frame of frames) socket.write(frame.raw) }

function collectText(frame: Frame, fragments: Frame[]): { payload: Buffer; frames: Frame[] } | undefined {
  if (frame.opcode === 0x8 || frame.opcode === 0x9 || frame.opcode === 0xa || frame.opcode === 0x2) return undefined
  if (frame.opcode === 0x1) { if (fragments.length) throw new Error('new text frame during continuation'); if (frame.fin) return { payload: frame.payload, frames: [frame] }; fragments.push(frame); return undefined }
  if (frame.opcode !== 0x0 || !fragments.length) throw new Error('unsupported WebSocket frame')
  fragments.push(frame); const size = fragments.reduce((total, item) => total + item.payload.byteLength, 0)
  if (size > MAX_FRAME_BYTES) throw new Error('fragmented text exceeds limit')
  if (!frame.fin) return undefined
  const result = { payload: Buffer.concat(fragments.map(item => item.payload)), frames: [...fragments] }; fragments.length = 0; return result
}

class FrameDecoder {
  #pending = Buffer.alloc(0)
  #masked: boolean
  constructor(masked: boolean) { this.#masked = masked }
  push(chunk: Buffer): Frame[] {
    this.#pending = Buffer.concat([this.#pending, chunk]); const output: Frame[] = []
    while (true) { const decoded = decodeFrame(this.#pending, this.#masked); if (!decoded) return output; output.push(decoded.frame); this.#pending = this.#pending.subarray(decoded.size) }
  }
}
function decodeFrame(bytes: Buffer, requireMask: boolean): { frame: Frame; size: number } | undefined {
  if (bytes.byteLength < 2) return undefined
  const first = bytes[0]!; const second = bytes[1]!; const masked = (second & 0x80) !== 0; const indicator = second & 0x7f
  if (masked !== requireMask || (first & 0x70) !== 0) throw new Error('invalid WebSocket frame')
  const extra = indicator < 126 ? 0 : indicator === 126 ? 2 : 8; const header = 2 + extra + (masked ? 4 : 0)
  if (bytes.byteLength < header) return undefined
  const length = indicator < 126 ? indicator : indicator === 126 ? bytes.readUInt16BE(2) : Number(bytes.readBigUInt64BE(2))
  if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) throw new Error('WebSocket frame exceeds limit')
  if (bytes.byteLength < header + length) return undefined
  const opcode = first & 0x0f; const fin = (first & 0x80) !== 0
  if (opcode >= 0x8 && (!fin || length > 125)) throw new Error('invalid WebSocket control frame')
  const raw = Buffer.from(bytes.subarray(0, header + length)); const payload = Buffer.from(bytes.subarray(header, header + length))
  if (masked) { const key = bytes.subarray(header - 4, header); for (let index = 0; index < payload.byteLength; index++) payload[index] ^= key[index % 4]! }
  return { frame: { fin, opcode, payload, raw }, size: header + length }
}
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text); if (payload.byteLength < 126) return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload])
  const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.byteLength, 2); return Buffer.concat([header, payload])
}

type SocketIdentity = { dev: number; ino: number }
function validateOptions(options: TuiThreadTransitionProxyOptions): void {
  for (const path of [options.listenSocket, options.upstreamSocket]) if (!absolute(path)) throw new Error('TUI transition sockets must be absolute normalized paths')
  if (options.listenSocket === options.upstreamSocket) throw new Error('TUI transition sockets must differ')
}
function absolute(path: string): boolean { return isAbsolute(path) && normalize(path) === path && !path.includes('//') && !/[\u0000-\u001f\u007f]/u.test(path) }
function owner(info: { uid: number }): boolean { return process.getuid?.() !== undefined && info.uid === process.getuid?.() }
function socket(info: { mode: number }): boolean { return (info.mode & 0o170000) === 0o140000 }
function validateSocketParent(path: string): void {
  let info; try { info = lstatSync(dirname(path)) } catch { throw new Error('TUI transition socket parent is unavailable') }
  if (!info.isDirectory() || info.isSymbolicLink() || !owner(info) || (info.mode & 0o777) !== 0o700) throw new Error('TUI transition socket parent must be an owned real 0700 directory')
}
function validateUpstream(path: string): void {
  validateSocketParent(path); if (!existsSync(path)) return
  const info = lstatSync(path); if (!socket(info) || info.isSymbolicLink() || !owner(info) || (info.mode & 0o077) !== 0) throw new Error('TUI transition upstream socket must be owned and private')
}
function socketIdentity(path: string): SocketIdentity {
  chmodSync(path, 0o600); const info = lstatSync(path)
  if (!socket(info) || info.isSymbolicLink() || !owner(info) || (info.mode & 0o777) !== 0o600) throw new Error('TUI transition socket must be an owned 0600 socket')
  return { dev: info.dev, ino: info.ino }
}
function closeServer(server: Server, path: string, clients: ReadonlySet<Socket>, identity: SocketIdentity): Promise<void> {
  for (const client of clients) client.destroy()
  return new Promise((resolve, reject) => server.close(error => {
    if (error) { reject(error); return }
    try { if (existsSync(path)) { const info = lstatSync(path); if (socket(info) && owner(info) && info.dev === identity.dev && info.ino === identity.ino) unlinkSync(path) }; resolve() } catch (cause) { reject(cause) }
  }))
}
