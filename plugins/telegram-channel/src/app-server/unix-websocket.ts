import { randomBytes } from 'node:crypto'
import { isRecord, type JsonObject, toError } from '../shared/guards'
import { clientFrame, collectText, type Frame, FrameDecoder, OPCODE } from '../shared/ws-frames'
import {
  AppServerRpcError,
  type AppServerTransport,
  SERVER_REQUEST_CANCELLED,
  type ServerRequestListener,
} from './transport'

export type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** Registers the waiter before writing: a local Unix peer can answer during the write call. */
export function writeWithPendingRequest(
  pending: Map<number, PendingRequest>,
  id: number,
  write: () => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      write()
    } catch (error) {
      pending.delete(id)
      reject(toError(error))
    }
  })
}

/** Minimal JSON-RPC WebSocket client over one local Unix socket; it never opens TCP. */
export class UnixWebSocketTransport implements AppServerTransport {
  readonly #notificationListeners = new Set<(method: string, params: JsonObject) => void>()
  readonly #requestListeners = new Set<ServerRequestListener>()
  readonly #closeListeners = new Set<(error: Error) => void>()
  readonly #pending = new Map<number, PendingRequest>()
  readonly #frames = new FrameDecoder(false)
  readonly #fragments: Frame[] = []
  #socket: Bun.Socket | undefined
  #handshake = Buffer.alloc(0)
  #nextId = 1
  #upgraded = false
  #closed = false

  static async connect(unixPath: string, path = '/'): Promise<UnixWebSocketTransport> {
    const transport = new UnixWebSocketTransport()
    await new Promise<void>((resolve, reject) => {
      let opened = false
      void Bun.connect({
        unix: unixPath,
        socket: {
          open(socket) {
            transport.#socket = socket
            const key = randomBytes(16).toString('base64')
            socket.write(
              `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
            )
          },
          data(socket, data) {
            try {
              transport.#receive(Buffer.from(data))
              if (transport.#upgraded && !opened) {
                opened = true
                resolve()
              }
            } catch (error) {
              const failure = toError(error, 'invalid Unix WebSocket response')
              if (!opened) reject(failure)
              transport.#detached(failure)
              socket.end()
            }
          },
          error(_socket, error) {
            if (!opened) reject(error)
          },
          close() {
            const error = new Error('Unix WebSocket closed')
            if (!opened) reject(error)
            transport.#detached(error)
          },
        },
      }).catch(error => reject(toError(error)))
    })
    return transport
  }

  request(method: string, params?: JsonObject): Promise<unknown> {
    if (this.#socket === undefined) return Promise.reject(new Error('Unix WebSocket is not connected'))
    const id = this.#nextId++
    return writeWithPendingRequest(this.#pending, id, () =>
      this.#send({ id, method, ...(params === undefined ? {} : { params }) }),
    )
  }

  notify(method: string, params?: JsonObject): void {
    this.#send({ method, ...(params === undefined ? {} : { params }) })
  }

  onNotification(listener: (method: string, params: JsonObject) => void): () => void {
    this.#notificationListeners.add(listener)
    return () => this.#notificationListeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.#requestListeners.add(listener)
    return () => this.#requestListeners.delete(listener)
  }

  close(): void {
    const socket = this.#socket
    this.#socket = undefined
    socket?.end()
    this.#detached(new Error('Unix WebSocket closed'))
  }

  #receive(chunk: Buffer): void {
    let bytes = chunk
    if (!this.#upgraded) {
      this.#handshake = Buffer.concat([this.#handshake, chunk])
      const end = this.#handshake.indexOf('\r\n\r\n')
      if (end < 0) return
      if (!this.#handshake.subarray(0, end).toString('ascii').startsWith('HTTP/1.1 101 '))
        throw new Error('Unix socket did not upgrade to WebSocket')
      bytes = this.#handshake.subarray(end + 4)
      this.#handshake = Buffer.alloc(0)
      this.#upgraded = true
    }
    for (const frame of this.#frames.push(bytes)) {
      if (frame.opcode === OPCODE.close) {
        this.close()
        return
      }
      if (frame.opcode === OPCODE.ping) {
        this.#write(0x8a, frame.payload)
        continue
      }
      const message = collectText(frame, this.#fragments)
      if (message !== undefined) this.#dispatch(JSON.parse(message.payload.toString('utf8')) as unknown)
    }
  }

  #dispatch(message: unknown): void {
    if (!isRecord(message)) return
    const { id, method, params } = message
    if ((typeof id === 'number' || typeof id === 'string') && typeof method === 'string') {
      if (isRecord(params)) void this.#answerServerRequest(id, method, params)
      else this.#send({ id, error: { code: -32602, message: 'server request params must be an object' } })
      return
    }
    if (typeof id === 'number') {
      const pending = this.#pending.get(id)
      if (pending === undefined) return
      this.#pending.delete(id)
      if (message.error === undefined) {
        pending.resolve(message.result)
        return
      }
      const error = isRecord(message.error) ? message.error : {}
      pending.reject(
        new AppServerRpcError(
          typeof error.code === 'number' ? error.code : -32000,
          typeof error.message === 'string' ? error.message : 'App Server RPC error',
          error.data,
        ),
      )
      return
    }
    if (typeof method === 'string' && isRecord(params))
      for (const listener of this.#notificationListeners) listener(method, params)
  }

  /**
   * The most recently installed listener answers first. A listener that returns
   * SERVER_REQUEST_CANCELLED passes, so a passive observer cannot hide the approval relay.
   */
  async #answerServerRequest(id: string | number, method: string, params: JsonObject): Promise<void> {
    const listeners = [...this.#requestListeners]
    if (listeners.length === 0) {
      this.#send({ id, error: { code: -32601, message: 'server request is not handled' } })
      return
    }
    for (const listener of listeners.reverse()) {
      try {
        const result = await listener(id, method, params)
        if (result === SERVER_REQUEST_CANCELLED) continue
        this.#send({ id, result })
      } catch {
        this.#send({ id, error: { code: -32000, message: 'server request was declined' } })
      }
      return
    }
  }

  #send(value: JsonObject): void {
    this.#write(0x81, Buffer.from(JSON.stringify(value)))
  }

  #write(opcodeByte: number, payload: Buffer): void {
    const socket = this.#socket
    if (socket === undefined) throw new Error('Unix WebSocket is not connected')
    socket.write(clientFrame(opcodeByte, payload))
  }

  #detached(error: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#socket = undefined
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    for (const listener of this.#closeListeners) listener(error)
  }
}
