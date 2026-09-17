import { chmodSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { basename, isAbsolute, normalize } from 'node:path'
import { hasControlCharacters, isRecord, isTelegramUserId, type JsonObject } from '../shared/guards'
import { privateSocket } from '../shared/private-fs'
import { safeToolError } from '../telegram/tools'

/**
 * Private Unix-socket RPC between the session owner (the launcher, which holds the bot token and
 * the poller) and everything that must go through it: the per-thread MCP servers and a newer
 * launch of the same profile asking for the channel. One newline-terminated JSON request and one
 * response per connection; the bridge stores no Telegram or host state.
 */
export type ToolCall = { operation: 'tool'; threadId: string; tool: string; arguments: JsonObject }
export type HandoffRequest = { operation: 'handoff'; nonce: string; profile: string; botId: string }
export type BridgeRequest = ToolCall | HandoffRequest

export type BridgeTarget = {
  executeTool(call: ToolCall): Promise<JsonObject>
  handoff(request: HandoffRequest): Promise<JsonObject>
}

export const OWNER_SOCKET_NAME = 'telegram-owner.sock'
/** A reply may carry 16 384 characters of text; leave room for multi-byte text and file paths. */
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const SOCKET_TIMEOUT_MS = 30_000
const FAILED = 'Telegram owner bridge request failed'

class ToolCallError extends Error {}

export class OwnerBridge {
  #server: Server | undefined
  readonly #clients = new Set<Socket>()
  readonly #handlers = new Set<Promise<unknown>>()

  constructor(
    private readonly path: string,
    private readonly target: BridgeTarget,
  ) {
    validateBridgePath(path)
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) return
    const server = createServer(socket => this.#serve(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.path, () => {
          server.off('error', reject)
          resolve()
        })
      })
      chmodSync(this.path, 0o600)
      privateSocket(this.path, 'Telegram owner bridge socket')
      this.#server = server
    } catch (error) {
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    for (const client of this.#clients) client.end()
    if (server !== undefined)
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error === undefined ? resolve() : reject(error))),
      )
    while (this.#handlers.size > 0) await Promise.allSettled([...this.#handlers])
  }

  #serve(socket: Socket): void {
    this.#clients.add(socket)
    socket.once('close', () => this.#clients.delete(socket))
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy())
    socket.setEncoding('utf8')
    let bytes = 0
    let frame = ''
    socket.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      // Exactly one request per connection: reject oversized input and anything after the newline.
      if (bytes > MAX_REQUEST_BYTES || frame.includes('\n')) {
        socket.destroy()
        return
      }
      frame += chunk
      if (!frame.endsWith('\n')) return
      const handler = this.#handle(frame.slice(0, -1)).then(
        result => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
        (error: unknown) =>
          socket.end(
            `${JSON.stringify({ ok: false, error: error instanceof ToolCallError ? error.message : FAILED })}\n`,
          ),
      )
      this.#handlers.add(handler)
      void handler.finally(() => this.#handlers.delete(handler))
    })
  }

  async #handle(raw: string): Promise<JsonObject> {
    const request = parseBridgeRequest(JSON.parse(raw) as unknown)
    if (request.operation === 'handoff') return await this.target.handoff(request)
    try {
      return await this.target.executeTool(request)
    } catch (error) {
      // The model needs to know why its tool call failed; everything else stays generic.
      throw new ToolCallError(safeToolError(error))
    }
  }
}

/** Sends one request to a running owner and resolves with its result. */
export function callOwnerBridge(path: string, request: BridgeRequest): Promise<JsonObject> {
  validateBridgePath(path)
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (error?: Error, result?: JsonObject) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error === undefined) resolve(result ?? {})
      else reject(error)
    }
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => finish(new Error('Telegram owner bridge timed out')))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_RESPONSE_BYTES) finish(new Error('Telegram owner bridge response is too large'))
      else chunks.push(chunk)
    })
    socket.once('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n')) throw new Error('invalid frame')
        const response = JSON.parse(raw) as unknown
        if (isRecord(response) && response.ok === false && typeof response.error === 'string')
          finish(new Error(safeToolError(new Error(response.error))))
        else if (isRecord(response) && response.ok === true && isRecord(response.result))
          finish(undefined, response.result)
        else throw new Error('invalid response')
      } catch {
        finish(new Error(FAILED))
      }
    })
    socket.once('error', () => finish(new Error(FAILED)))
  })
}

function validateBridgePath(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || basename(path) !== OWNER_SOCKET_NAME)
    throw new Error('Telegram owner bridge path is invalid')
}

function parseBridgeRequest(value: unknown): BridgeRequest {
  if (!isRecord(value)) throw new Error('invalid request')
  if (value.operation === 'handoff') {
    const { nonce, profile, botId } = value
    if (
      typeof nonce !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(nonce) ||
      typeof profile !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(profile) ||
      !isTelegramUserId(botId)
    )
      throw new Error('invalid handoff')
    return { operation: 'handoff', nonce, profile, botId }
  }
  const { threadId, tool } = value
  if (
    value.operation !== 'tool' ||
    typeof threadId !== 'string' ||
    threadId === '' ||
    Array.from(threadId).length > 256 ||
    hasControlCharacters(threadId) ||
    typeof tool !== 'string' ||
    !isRecord(value.arguments)
  )
    throw new Error('invalid request')
  return { operation: 'tool', threadId, tool, arguments: value.arguments }
}
