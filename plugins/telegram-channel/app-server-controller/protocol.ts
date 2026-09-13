/** Deliberately small JSON-RPC boundary; the real transport and test fakes share it. */
export interface AppServerTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): void
  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void
  onClose(listener: (error: Error) => void): () => void
  onServerRequest?(listener: (id: string | number, method: string, params: Record<string, unknown>) => Promise<unknown>): () => void
}
/** Resolves an already-server-resolved request without emitting a duplicate JSON-RPC response. */
export const SERVER_REQUEST_CANCELLED = Symbol('server-request-cancelled')

export class AppServerRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'AppServerRpcError' }
}
/** Admission may have reached stock but lacks authoritative evidence; never replay it automatically. */
export class AppServerAdmissionUncertainError extends Error {
  constructor(message: string) { super(message); this.name = 'AppServerAdmissionUncertainError' }
}

export type Origin = {
  id: string
  route: string
  text: string
  source: 'telegram' | 'peer'
  /** Client-side correlation token passed through the stock queue API. */
  clientUserMessageId?: string
  /** Short untrusted display text for hosts that recognize same-request context. */
  displayText?: string
  localImagePaths?: string[]
  localImagePath?: string
}
