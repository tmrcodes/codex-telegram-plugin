import { isRecord, type JsonObject } from '../shared/guards'

/**
 * A minimal Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0 with
 * `initialize`, `ping`, `tools/list` and `tools/call`. It declares only the tools capability.
 */
export type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: JsonObject
  isError?: boolean
}

export type McpServerOptions = {
  name: string
  version: string
  instructions: string
  tools: readonly JsonObject[]
  /** `meta` is the request's `_meta`; hosts put per-call context such as the thread there. */
  callTool(name: string, args: unknown, meta: unknown): Promise<ToolCallResult>
}

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const MAX_LINE_BYTES = 4 * 1024 * 1024
const ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 }

export class McpStdioServer {
  #buffer = Buffer.alloc(0)
  readonly #inFlight = new Set<Promise<void>>()

  constructor(
    private readonly options: McpServerOptions,
    private readonly write: (line: string) => void,
  ) {}

  /** Feeds raw stdin bytes; complete lines are dispatched as JSON-RPC messages. */
  receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline === -1) {
        if (this.#buffer.byteLength > MAX_LINE_BYTES) this.#buffer = Buffer.alloc(0)
        return
      }
      const line = this.#buffer.toString('utf8', 0, newline).replace(/\r$/u, '')
      this.#buffer = this.#buffer.subarray(newline + 1)
      if (line.trim() !== '') this.#dispatch(line)
    }
  }

  /** Resolves once every request received so far has been answered. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight])
  }

  #dispatch(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#send({ jsonrpc: '2.0', id: null, error: { code: ERROR.parse, message: 'Parse error' } })
      return
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // Responses to requests we never send, and anything malformed, are ignored.
      if (isRecord(message) && hasId(message) && message.method !== undefined)
        this.#fail(message.id, ERROR.invalidRequest, 'Invalid Request')
      return
    }
    if (!hasId(message)) return // notifications such as notifications/initialized need no answer
    const { id, method, params } = message
    const handling = this.#handle(method as string, params).then(
      result => this.#send({ jsonrpc: '2.0', id, result }),
      error =>
        this.#fail(
          id,
          error instanceof RpcError ? error.code : ERROR.internal,
          error instanceof RpcError ? error.message : 'Internal error',
        ),
    )
    this.#inFlight.add(handling)
    void handling.finally(() => this.#inFlight.delete(handling))
  }

  async #handle(method: string, params: unknown): Promise<JsonObject> {
    switch (method) {
      case 'initialize': {
        const requested = isRecord(params) ? params.protocolVersion : undefined
        const protocolVersion =
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0]!
        const { name, version, instructions } = this.options
        return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version }, instructions }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: [...this.options.tools] }
      case 'tools/call': {
        if (!isRecord(params) || typeof params.name !== 'string')
          throw new RpcError(ERROR.invalidParams, 'tools/call requires a tool name')
        return await this.options.callTool(params.name, params.arguments ?? {}, params._meta)
      }
      default:
        throw new RpcError(ERROR.methodNotFound, 'Method not found')
    }
  }

  #fail(id: unknown, code: number, message: string): void {
    this.#send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  #send(message: JsonObject): void {
    this.write(`${JSON.stringify(message)}\n`)
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

function hasId(message: JsonObject): boolean {
  return typeof message.id === 'string' || typeof message.id === 'number'
}
