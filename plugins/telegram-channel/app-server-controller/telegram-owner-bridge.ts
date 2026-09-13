import { chmodSync, lstatSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import type { TelegramToolRequest, TelegramToolResult } from './telegram-tools-protocol'

const MAX_FRAME_BYTES = 8 * 1024
const SOCKET_TIMEOUT_MS = 30_000

export type TelegramOwnerBridgeTarget = {
  connect(threadId: string): Promise<Record<string, unknown>>
  executeTool(threadId: string, request: TelegramToolRequest): Promise<TelegramToolResult>
}
type BridgeRequest = { version: 1; operation: 'connect' | 'tool'; threadId: string; request?: TelegramToolRequest }
type BridgeResponse = { ok: true; result: Record<string, unknown> } | { ok: false; error: string }

/** A local, owner-only proxy boundary; it stores no Telegram or host state. */
export class TelegramOwnerBridge {
  #server: Server | undefined
  #clients = new Set<Socket>()
  #handlers = new Set<Promise<unknown>>()
  constructor(private readonly path: string, private readonly target: TelegramOwnerBridgeTarget) { validateBridgePath(path) }
  async start(): Promise<void> {
    if (this.#server !== undefined) return
    const server = createServer(socket => {
      this.#clients.add(socket); socket.once('close', () => this.#clients.delete(socket))
      let bytes = 0; let frame = ''
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy())
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_FRAME_BYTES || frame.includes('\n')) { socket.destroy(); return }
        frame += chunk
        if (!frame.endsWith('\n')) return
        const handler = this.#handle(frame.slice(0, -1)); this.#handlers.add(handler)
        void handler.then(response => socket.end(`${JSON.stringify(response)}\n`), () => socket.end('{"ok":false,"error":"owner bridge request failed"}\n')).then(() => this.#handlers.delete(handler), () => this.#handlers.delete(handler))
      })
    })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.path, () => { server.off('error', reject); resolve() }) })
      chmodSync(this.path, 0o600)
      const stat = lstatSync(this.path)
      if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error('Telegram owner bridge socket is not private')
      this.#server = server
    } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error }
  }
  async close(): Promise<void> {
    const server = this.#server; this.#server = undefined
    for (const client of this.#clients) client.end()
    if (server !== undefined) await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    while (this.#handlers.size) await Promise.allSettled([...this.#handlers])
  }
  async #handle(raw: string): Promise<BridgeResponse> {
    try {
      const request = parseBridgeRequest(raw)
      const result = request.operation === 'connect' ? await this.target.connect(request.threadId) : await this.target.executeTool(request.threadId, request.request!)
      return { ok: true, result }
    } catch { return { ok: false, error: 'owner bridge request failed' } }
  }
}

export function telegramOwnerBridgePath(stateDir: string): string { if (!isAbsolute(stateDir) || normalize(stateDir) !== stateDir) throw new Error('Telegram owner bridge state directory is invalid'); return `${stateDir}/telegram-owner.sock` }
export function forwardTelegramOwnerBridge(path: string, request: BridgeRequest): Promise<Record<string, unknown>> {
  validateBridgePath(path)
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); const chunks: Buffer[] = []; let bytes = 0; let settled = false
    const finish = (error?: Error, result?: Record<string, unknown>) => { if (settled) return; settled = true; socket.destroy(); error === undefined ? resolve(result ?? {}) : reject(error) }
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => finish(new Error('Telegram owner bridge timed out')))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_FRAME_BYTES) finish(new Error('Telegram owner bridge response is too large')); else chunks.push(chunk) })
    socket.once('end', () => { try { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n')) throw new Error('Telegram owner bridge returned an invalid frame'); const response = parseBridgeResponse(raw.slice(0, -1)); if (!response.ok) throw new Error(response.error); finish(undefined, response.result) } catch { finish(new Error('Telegram owner bridge request failed')) } })
    socket.once('error', () => finish(new Error('Telegram owner bridge request failed')))
  })
}

function validateBridgePath(path: string): void { if (!isAbsolute(path) || normalize(path) !== path || basename(path) !== 'telegram-owner.sock' || basename(dirname(path)) === '') throw new Error('Telegram owner bridge path is invalid') }
function validThreadId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Array.from(value).length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) }
function parseBridgeRequest(raw: string): BridgeRequest {
  let value: unknown; try { value = JSON.parse(raw) } catch { throw new Error('invalid request') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid request')
  const request = value as Record<string, unknown>
  if (request.version !== 1 || !validThreadId(request.threadId) || (request.operation !== 'connect' && request.operation !== 'tool')) throw new Error('invalid request')
  if (request.operation === 'tool' && (typeof request.request !== 'object' || request.request === null || Array.isArray(request.request))) throw new Error('invalid request')
  return request as BridgeRequest
}
function parseBridgeResponse(raw: string): BridgeResponse {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid response')
  const response = value as Record<string, unknown>
  if (response.ok === true && record(response.result)) return { ok: true, result: response.result }
  if (response.ok === false && typeof response.error === 'string') return { ok: false, error: response.error }
  throw new Error('invalid response')
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
