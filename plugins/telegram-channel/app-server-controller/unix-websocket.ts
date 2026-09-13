import { randomBytes } from 'node:crypto'

import { AppServerRpcError, SERVER_REQUEST_CANCELLED, type AppServerTransport } from './protocol'

export type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** Register before writing: a local Unix peer can respond during the write call. */
export function writeWithPendingRequest(pending: Map<number, PendingRequest>, id: number, write: () => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try { write() } catch (error) { pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
  })
}

/** Minimal JSON-RPC WebSocket client over one local Unix socket; it never opens TCP. */
export class UnixWebSocketTransport implements AppServerTransport {
  readonly #listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  readonly #requestListeners = new Set<(id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown>>()
  readonly #closeListeners = new Set<(error: Error) => void>()
  readonly #pending = new Map<number, PendingRequest>()
  #socket: Bun.Socket | undefined
  #buffer = Buffer.alloc(0)
  #nextId = 1
  #upgraded = false
  #closed = false

  static async connect(unix: string, path = '/'): Promise<UnixWebSocketTransport> {
    const transport = new UnixWebSocketTransport()
    await new Promise<void>((resolve, reject) => {
      let opened = false
      void Bun.connect({
        unix,
        socket: {
          open(socket) {
            transport.#socket = socket
            const key = randomBytes(16).toString('base64')
            socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
          },
          data(_socket, data) {
            try {
              transport.#receive(Buffer.from(data))
              if (transport.#upgraded && !opened) { opened = true; resolve() }
            } catch (error) {
              const failure = error instanceof Error ? error : new Error('invalid Unix WebSocket response')
              if (!opened) reject(failure)
              transport.#detached(failure); _socket.end()
            }
          },
          error(_socket, error) { if (!opened) reject(error) },
          close() { const error = new Error('Unix WebSocket closed'); if (!opened) reject(error); transport.#detached(error) },
        },
      }).catch(error => reject(error instanceof Error ? error : new Error(String(error))))
    })
    return transport
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.#socket === undefined) return Promise.reject(new Error('Unix WebSocket is not connected'))
    const id = this.#nextId++
    return writeWithPendingRequest(this.#pending, id, () => this.#write({ id, method, ...(params === undefined ? {} : { params }) }))
  }
  notify(method: string, params?: Record<string, unknown>): void { this.#write({ method, ...(params === undefined ? {} : { params }) }) }
  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener)
  }
  onClose(listener: (error: Error) => void): () => void { this.#closeListeners.add(listener); return () => this.#closeListeners.delete(listener) }
  onServerRequest(listener: (id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown>): () => void { this.#requestListeners.add(listener); return () => this.#requestListeners.delete(listener) }
  close(): void { const socket = this.#socket; this.#socket = undefined; socket?.end(); this.#detached(new Error('Unix WebSocket closed')) }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    if (!this.#upgraded) {
      const end = this.#buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = this.#buffer.subarray(0, end).toString('ascii')
      if (!head.startsWith('HTTP/1.1 101 ')) throw new Error('Unix socket did not upgrade to WebSocket')
      this.#buffer = this.#buffer.subarray(end + 4); this.#upgraded = true
    }
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0]!; const second = this.#buffer[1]!; let offset = 2; let length = second & 0x7f
      if (length === 126) { if (this.#buffer.length < 4) return; length = this.#buffer.readUInt16BE(2); offset = 4 }
      if (length === 127) {
        if (this.#buffer.length < 10) return
        const wide = this.#buffer.readBigUInt64BE(2)
        if (wide > 16n * 1024n * 1024n) throw new Error('App Server WebSocket frame exceeds 16 MiB')
        length = Number(wide); offset = 10
      }
      const masked = (second & 0x80) !== 0; const maskOffset = offset; if (masked) offset += 4
      if (this.#buffer.length < offset + length) return
      const mask = masked ? this.#buffer.subarray(maskOffset, maskOffset + 4) : undefined
      let payload = this.#buffer.subarray(offset, offset + length); this.#buffer = this.#buffer.subarray(offset + length)
      if (mask !== undefined) payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!))
      const opcode = first & 0x0f; if (opcode === 0x8) { this.close(); return }; if (opcode === 0x9) { this.#frame(0x8a, payload); continue }; if (opcode !== 0x1) continue
      const message = JSON.parse(payload.toString('utf8')) as { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
      if ((typeof message.id === 'number' || typeof message.id === 'string') && typeof message.method === 'string' && message.params !== undefined) { void this.#respondServerRequest(message.id, message.method, message.params) }
      else if (typeof message.id === 'number') { const pending = this.#pending.get(message.id); if (pending !== undefined) { this.#pending.delete(message.id); message.error === undefined ? pending.resolve(message.result) : pending.reject(new AppServerRpcError(message.error.code ?? -32000, message.error.message ?? 'App Server RPC error', message.error.data)) } }
      else if (typeof message.method === 'string' && message.params !== undefined) for (const listener of this.#listeners) listener(message.method, message.params)
    }
  }
  #write(value: Record<string, unknown>): void { if (this.#socket === undefined) throw new Error('Unix WebSocket is not connected'); this.#frame(0x81, Buffer.from(JSON.stringify(value))) }
  async #respondServerRequest(id: string | number, method: string, params: Record<string, unknown>): Promise<void> { const listener = [...this.#requestListeners].at(-1); if (listener === undefined) { this.#write({ id, error: { code: -32601, message: 'server request is not handled' } }); return } try { const result = await listener(id, method, params); if (result !== SERVER_REQUEST_CANCELLED) this.#write({ id, result }) } catch { this.#write({ id, error: { code: -32000, message: 'server request was declined' } }) } }
  #rejectPending(error: Error): void { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear() }
  #detached(error: Error): void { if (this.#closed) return; this.#closed = true; this.#socket = undefined; this.#rejectPending(error); for (const listener of this.#closeListeners) listener(error) }
  #frame(opcode: number, payload: Buffer): void {
    if (payload.length > 65_535) throw new Error('App Server WebSocket outbound frame exceeds 65535 bytes')
    const mask = randomBytes(4); const header = payload.length < 126 ? Buffer.from([opcode, 0x80 | payload.length]) : Buffer.from([opcode, 0xfe, payload.length >> 8, payload.length & 0xff])
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!)); const socket = this.#socket; if (socket === undefined) throw new Error('Unix WebSocket is not connected'); socket.write(Buffer.concat([header, mask, masked]))
  }
}
