import type { JsonObject } from '../shared/guards'

/** Deliberately small JSON-RPC boundary to the stock Codex App Server. */
export interface AppServerTransport {
  request(method: string, params?: JsonObject): Promise<unknown>
  notify(method: string, params?: JsonObject): void
  onNotification(listener: (method: string, params: JsonObject) => void): () => void
  onClose(listener: (error: Error) => void): () => void
  onServerRequest(listener: ServerRequestListener): () => void
}

export type ServerRequestListener = (id: string | number, method: string, params: JsonObject) => Promise<unknown>

/**
 * Returned by a server-request listener that does not answer: the request was already
 * resolved elsewhere, or belongs to another listener. No JSON-RPC response is written.
 */
export const SERVER_REQUEST_CANCELLED = Symbol('server-request-cancelled')

export class AppServerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'AppServerRpcError'
  }
}

/** The message may have reached the conversation, but there is no proof; never replay it automatically. */
export class AdmissionUncertainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdmissionUncertainError'
  }
}

/** One Telegram message on its way into a conversation thread. */
export type Origin = {
  id: string
  /** The thread this message is bound to. */
  threadId: string
  /** Full rendered channel block shown to the model. */
  text: string
  /** Short preview for hosts that accept the full text as same-request untrusted context. */
  displayText: string
  /** Trusted note from this plugin on how to handle the message; never contains remote text. */
  guidance: string
  /** Client-side correlation token passed through the stock queue API. */
  clientUserMessageId: string
  localImagePaths: string[]
}
