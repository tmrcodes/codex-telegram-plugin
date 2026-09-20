import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { isRecord, type JsonObject } from '../shared/guards'
import { isAbsolutePath, privateDirectory } from '../shared/private-fs'
import { clientFrame, collectText, type Frame, FrameDecoder, serverTextFrame } from '../shared/ws-frames'

/**
 * A pass-through WebSocket proxy between the stock TUI and the App Server. It watches for the
 * few requests that change the TUI's visible thread (`thread/start`, `thread/resume`,
 * `thread/fork`) so that the Telegram owner follows `/new` and `/resume`:
 *
 *   prepare (owner drains)  ->  forward to host  ->  commit to the thread the host returned
 *
 * Anything else is forwarded untouched. It never creates host requests, selects a thread or
 * replays history.
 */
export type ApprovalRequest = { id: Id; method: string; params: JsonObject }

export type OwnerTransition = {
  /**
   * Offers a host approval request to the Telegram relay. The host addresses such a request to one
   * client only, so the proxy hands every one it sees to the owner as well; the terminal keeps its own
   * prompt and whichever side answers first wins. Resolves undefined when the relay does not answer.
   */
  approval?(request: ApprovalRequest): Promise<JsonObject | undefined>
  /** The terminal answered this request first; any Telegram card for it is stale. */
  approvalResolved?(id: Id): void
  start(threadId: string): Promise<void>
  prepare(fromThreadId: string): Promise<void>
  commit(fromThreadId: string, toThreadId: string): Promise<void>
  abort(fromThreadId: string): Promise<void>
  close(): Promise<void>
}

export type TuiProxy = {
  close(): Promise<void>
  boundThreadId(): string | undefined
  /** True until a root transition either commits or publishes an exact recovery thread. */
  transitionPending(): boolean
  /** Resolves when a failed transition requires the TUI to be resumed on exactly this thread. */
  nextRecovery(): Promise<string>
}

export type TuiProxyOptions = { listenSocket: string; upstreamSocket: string; owner: OwnerTransition }

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const ROOT_METHODS = ['thread/start', 'thread/resume', 'thread/fork']
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
])
const MAX_HANDSHAKE_BYTES = 64 * 1024
const MAX_BUFFERED_FRAMES = 1024
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
const OWNER_FAILURE = -32011
const TRANSITION_BUSY = -32012

type Id = string | number
type RootRequest = { id: Id; kind: 'initial' | 'transition'; from?: string; expectedThreadId?: string; jsonrpc?: '2.0' }
type Pending = RootRequest & {
  phase: 'preparing' | 'awaiting-host' | 'committing'
  targetThreadId?: string
  operation?: Promise<void>
}

/** State shared by every TUI connection of one launch. */
type Shared = {
  upstreamSocket: string
  owner: OwnerTransition
  bound(): string | undefined
  setBound(threadId: string): void
  requestRecovery(threadId: string): void
  track(operation: Promise<unknown>): void
  /** The stock `/resume` picker opens a second connection; only one connection may own the root. */
  claimRoot(client: Socket): boolean
  releaseRoot(client: Socket): void
  setTransitionPending(client: Socket, pending: boolean): void
}

export function startTuiProxy(options: TuiProxyOptions): Promise<TuiProxy> {
  if (!isAbsolutePath(options.listenSocket) || !isAbsolutePath(options.upstreamSocket))
    throw new Error('TUI proxy sockets must be absolute normalized paths')
  if (options.listenSocket === options.upstreamSocket) throw new Error('TUI proxy sockets must differ')
  privateDirectory(dirname(options.listenSocket), 'TUI proxy socket directory')
  validateUpstream(options.upstreamSocket)
  if (existsSync(options.listenSocket)) return Promise.reject(new Error('TUI proxy socket already exists'))

  let bound: string | undefined
  let closing: Promise<void> | undefined
  let transitionPending = false
  let rootClient: Socket | undefined
  const recoveries: string[] = []
  let resolveRecovery: ((threadId: string) => void) | undefined
  const clients = new Set<Socket>()
  const operations = new Set<Promise<unknown>>()

  const shared: Shared = {
    upstreamSocket: options.upstreamSocket,
    owner: options.owner,
    bound: () => bound,
    setBound: threadId => {
      bound = threadId
    },
    requestRecovery: threadId => {
      const resolve = resolveRecovery
      resolveRecovery = undefined
      if (resolve !== undefined) resolve(threadId)
      else recoveries.push(threadId)
    },
    track: operation => {
      operations.add(operation)
      const forget = () => {
        operations.delete(operation)
      }
      void operation.then(forget, forget)
    },
    claimRoot: client => {
      if (rootClient !== undefined && rootClient !== client) return false
      rootClient = client
      return true
    },
    releaseRoot: client => {
      if (rootClient === client) rootClient = undefined
    },
    setTransitionPending: (client, pending) => {
      if (rootClient === client) transitionPending = pending
    },
  }

  const server = createServer(client => {
    if (closing !== undefined) {
      client.destroy()
      return
    }
    clients.add(client)
    client.once('close', () => clients.delete(client))
    bridgeConnection(client, shared)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listenSocket, () => {
      try {
        const identity = ownListeningSocket(options.listenSocket)
        server.off('error', reject)
        resolve({
          boundThreadId: () => bound,
          transitionPending: () => transitionPending,
          nextRecovery: () => {
            const threadId = recoveries.shift()
            return threadId !== undefined
              ? Promise.resolve(threadId)
              : new Promise<string>(done => {
                  resolveRecovery = done
                })
          },
          close: () =>
            (closing ??= (async () => {
              try {
                await closeServer(server, options.listenSocket, clients, identity)
                await Promise.allSettled([...operations])
              } finally {
                await options.owner.close()
              }
            })()),
        })
      } catch (error) {
        server.close(() => reject(error))
      }
    })
  })
}

function bridgeConnection(client: Socket, shared: Shared): void {
  const upstream = createConnection(shared.upstreamSocket)
  const clientFrames = new FrameDecoder(true)
  const serverFrames = new FrameDecoder(false)
  const clientFragments: Frame[] = []
  const serverFragments: Frame[] = []
  // Until each side completes the HTTP upgrade, bytes are relayed head by head rather than as frames.
  let clientHead = Buffer.alloc(0)
  let serverHead = Buffer.alloc(0)
  let clientUpgraded = false
  let serverUpgraded = false
  let pending: Pending | undefined
  let closed = false
  let ending = false
  // Host messages that arrive while the owner commits are held so the TUI sees the root response first.
  let held: Frame[][] = []
  let heldReuses: Id[] = []
  let heldFrames = 0
  let heldBytes = 0

  const closeBoth = () => {
    if (closed) return
    closed = true
    client.destroy()
    upstream.destroy()
  }
  const closeAfterFlush = () => {
    if (closed) return
    closed = true
    upstream.destroy()
    client.end()
    setTimeout(() => client.destroy(), 100).unref()
  }
  /** Host approval requests this connection handed to the relay and nobody has answered yet. */
  const offeredApprovals = new Set<Id>()
  /** Requests the relay already answered: a terminal answer for one of these is late and must not travel. */
  const answeredApprovals = new Set<Id>()
  const offerApproval = (id: Id, method: string, params: JsonObject, jsonrpc: boolean): void => {
    const offer = shared.owner.approval?.({ id, method, params })
    if (offer === undefined) return
    offeredApprovals.add(id)
    // Deliberately not tracked with the root transitions: an unanswered card settles only when the relay
    // closes, and `close()` awaits tracked work *before* closing the owner, so tracking this would hold
    // shutdown open for the whole approval timeout.
    void offer.then(
      result => {
        // The terminal may have answered while the card was out; only the first answer is sent.
        if (closed || result === undefined || !offeredApprovals.delete(id)) return
        answeredApprovals.add(id)
        upstream.write(
          clientFrame(0x81, Buffer.from(JSON.stringify({ ...(jsonrpc ? { jsonrpc: '2.0' } : {}), id, result }))),
        )
        client.write(
          serverTextFrame(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'serverRequest/resolved',
              params: { threadId: params.threadId, requestId: id },
            }),
          ),
        )
      },
      () => offeredApprovals.delete(id),
    )
  }

  const reject = (request: { id: Id; jsonrpc?: '2.0' }, code: number, message: string) => {
    client.write(
      serverTextFrame(
        JSON.stringify({
          ...(request.jsonrpc ? { jsonrpc: request.jsonrpc } : {}),
          id: request.id,
          error: { code, message },
        }),
      ),
    )
  }

  /** Ends this connection and leaves the owner on a definite thread: the committed one or the old one. */
  const terminate = () => {
    if (ending) return
    ending = true
    const active = pending
    pending = undefined
    held = []
    heldFrames = 0
    heldBytes = 0
    const prior = active?.operation ?? Promise.resolve()
    const settled = (async (): Promise<string | undefined> => {
      if (active?.phase === 'committing' && active.from !== undefined) {
        try {
          await prior
          if (active.targetThreadId === undefined) throw new Error('missing committed root')
          shared.setBound(active.targetThreadId)
          return active.targetThreadId
        } catch {
          await shared.owner.abort(active.from).catch(() => {})
          return active.from
        }
      }
      await prior.catch(() => {})
      if (active?.kind === 'transition' && active.from !== undefined) {
        await shared.owner.abort(active.from).catch(() => {})
        return active.from
      }
      return undefined
    })()
    shared.track(settled)
    void settled
      .then(threadId => {
        if (threadId !== undefined) shared.requestRecovery(threadId)
        shared.setTransitionPending(client, false)
      })
      .finally(() => {
        shared.releaseRoot(client)
        closeAfterFlush()
      })
  }

  client.once('error', terminate)
  upstream.once('error', terminate)
  client.once('end', () => upstream.end())
  upstream.once('end', () => client.end())
  client.once('close', terminate)
  upstream.once('close', terminate)

  client.on('data', (data: Buffer) => {
    if (clientUpgraded) return handleClient(data)
    clientHead = Buffer.concat([clientHead, data])
    const split = splitHead(clientHead)
    if (split === undefined) {
      if (clientHead.byteLength > MAX_HANDSHAKE_BYTES) closeBoth()
      return
    }
    clientHead = Buffer.alloc(0)
    clientUpgraded = /^GET\s/mu.test(split.head.toString('ascii'))
    upstream.write(split.head)
    if (split.rest.byteLength > 0) handleClient(split.rest)
  })
  upstream.on('data', (data: Buffer) => {
    if (serverUpgraded) return handleServer(data)
    serverHead = Buffer.concat([serverHead, data])
    const split = splitHead(serverHead)
    if (split === undefined) {
      if (serverHead.byteLength > MAX_HANDSHAKE_BYTES) closeBoth()
      return
    }
    serverHead = Buffer.alloc(0)
    serverUpgraded = /^HTTP\/1\.1 101\b/mu.test(split.head.toString('ascii'))
    client.write(split.head)
    if (split.rest.byteLength > 0) handleServer(split.rest)
  })

  function handleClient(bytes: Buffer): void {
    try {
      for (const frame of clientFrames.push(bytes)) {
        const message = collectText(frame, clientFragments)
        if (message === undefined) {
          upstream.write(frame.raw)
          continue
        }
        const request = parseRpc(message.payload)
        if (request === 'invalid') return terminate()
        if (request !== undefined && isId(request.id) && request.method === undefined) {
          // The host already has an answer for this one: a second response could carry the opposite
          // decision, so the late terminal answer is dropped instead of forwarded.
          if (answeredApprovals.delete(request.id)) continue
          if (offeredApprovals.delete(request.id)) shared.owner.approvalResolved?.(request.id)
        }
        if (request !== undefined && changesVisibleRoot(request) && !shared.claimRoot(client)) {
          if (!isId(request.id)) return terminate()
          reject(
            { id: request.id, ...(request.jsonrpc === '2.0' ? { jsonrpc: '2.0' } : {}) },
            TRANSITION_BUSY,
            'Another TUI connection owns the visible root',
          )
          continue
        }
        const root = rootRequest(request, shared.bound())
        if (root === undefined) {
          forward(upstream, message.frames)
          continue
        }
        if (pending !== undefined) {
          reject(root, TRANSITION_BUSY, 'A root transition is already in progress')
          continue
        }
        const active: Pending = { ...root, phase: root.kind === 'initial' ? 'awaiting-host' : 'preparing' }
        pending = active
        if (root.kind === 'initial') {
          forward(upstream, message.frames)
          continue
        }
        shared.setTransitionPending(client, true)
        const operation = shared.owner.prepare(root.from!)
        active.operation = operation
        shared.track(operation)
        void operation.then(
          () => {
            if (closed || pending !== active) return
            active.phase = 'awaiting-host'
            forward(upstream, message.frames)
          },
          () => {
            if (closed || pending !== active) return
            reject(root, OWNER_FAILURE, 'Telegram owner could not prepare this root transition')
            terminate()
          },
        )
      }
    } catch {
      closeBoth()
    }
  }

  function handleServer(bytes: Buffer): void {
    try {
      for (const frame of serverFrames.push(bytes)) {
        const message = collectText(frame, serverFragments)
        if (message === undefined) {
          client.write(frame.raw)
          continue
        }
        const response = parseRpc(message.payload)
        if (response === 'invalid') return terminate()
        // A host request may reuse a JSON-RPC ID we have already answered. The tombstone belongs to the
        // request that is gone, so it must not swallow the terminal's answer to this new one — but it
        // has to keep working until the terminal has actually seen the replacement, because until then
        // any answer on that ID is still the stale one.
        const reusing =
          response !== undefined &&
          isId(response.id) &&
          typeof response.method === 'string' &&
          answeredApprovals.has(response.id)
            ? response.id
            : undefined
        if (
          response !== undefined &&
          isId(response.id) &&
          typeof response.method === 'string' &&
          APPROVAL_METHODS.has(response.method)
        )
          offerApproval(
            response.id,
            response.method,
            isRecord(response.params) ? response.params : {},
            response.jsonrpc === '2.0',
          )
        const active = pending
        if (active?.phase === 'committing') {
          if (answers(response, active)) {
            terminate()
            continue
          }
          const bytesHeld = message.frames.reduce((total, item) => total + item.raw.byteLength, 0)
          if (heldFrames + message.frames.length > MAX_BUFFERED_FRAMES || heldBytes + bytesHeld > MAX_BUFFERED_BYTES)
            return terminate()
          held.push(message.frames)
          if (reusing !== undefined) heldReuses.push(reusing)
          heldFrames += message.frames.length
          heldBytes += bytesHeld
          continue
        }
        if (active === undefined || !answers(response, active)) {
          forward(client, message.frames)
          if (reusing !== undefined) answeredApprovals.delete(reusing)
          continue
        }
        if (active.phase !== 'awaiting-host') return terminate()
        if (Object.hasOwn(response, 'error')) {
          forward(client, message.frames)
          terminate()
          continue
        }
        const threadId = threadIdFrom(response)
        if (threadId === undefined || (active.expectedThreadId !== undefined && threadId !== active.expectedThreadId)) {
          reject(active, OWNER_FAILURE, 'Host root response did not contain the requested thread ID')
          terminate()
          continue
        }
        active.phase = 'committing'
        active.targetThreadId = threadId
        const operation = Promise.resolve().then(() =>
          active.kind === 'initial' ? shared.owner.start(threadId) : shared.owner.commit(active.from!, threadId),
        )
        active.operation = operation
        shared.track(operation)
        void operation.then(
          () => {
            if (closed || pending !== active) return
            pending = undefined
            shared.setBound(threadId)
            shared.setTransitionPending(client, false)
            forward(client, message.frames)
            for (const frames of held) forward(client, frames)
            for (const id of heldReuses.splice(0)) answeredApprovals.delete(id)
            held = []
            heldFrames = 0
            heldBytes = 0
          },
          () => {
            if (closed || pending !== active) return
            reject(
              active,
              OWNER_FAILURE,
              active.kind === 'initial'
                ? 'Telegram owner could not start for this root'
                : 'Telegram owner could not commit this root transition',
            )
            terminate()
          },
        )
      }
    } catch {
      closeBoth()
    }
  }
}

function splitHead(bytes: Buffer): { head: Buffer; rest: Buffer } | undefined {
  const end = bytes.indexOf('\r\n\r\n')
  return end < 0 ? undefined : { head: bytes.subarray(0, end + 4), rest: bytes.subarray(end + 4) }
}

/** Hidden work such as automatic titles uses ephemeral threads; those never move the visible root. */
function changesVisibleRoot(request: JsonObject): boolean {
  if (!ROOT_METHODS.includes(String(request.method))) return false
  return request.method === 'thread/resume' || !(isRecord(request.params) && request.params.ephemeral === true)
}

function rootRequest(value: JsonObject | undefined, bound: string | undefined): RootRequest | undefined {
  if (value === undefined || typeof value.method !== 'string' || !ROOT_METHODS.includes(value.method)) return undefined
  if ((value.jsonrpc !== undefined && value.jsonrpc !== '2.0') || !isId(value.id))
    throw new Error('invalid root JSON-RPC request')
  const dialect = value.jsonrpc === '2.0' ? { jsonrpc: '2.0' as const } : {}
  const params = isRecord(value.params) ? value.params : undefined
  if (!changesVisibleRoot(value)) return undefined
  const { id, method } = value
  if (bound === undefined) {
    if (method === 'thread/fork') throw new Error('root fork requires an existing root binding')
    const expected = method === 'thread/resume' ? params?.threadId : undefined
    if (expected !== undefined && (typeof expected !== 'string' || !THREAD_ID.test(expected)))
      throw new Error('invalid root resume request')
    return { id, kind: 'initial', ...dialect, ...(typeof expected === 'string' ? { expectedThreadId: expected } : {}) }
  }
  if (method === 'thread/start') return { id, kind: 'transition', from: bound, ...dialect }
  if (method === 'thread/resume') {
    const target = params?.threadId
    if (typeof target !== 'string' || !THREAD_ID.test(target)) throw new Error('invalid root resume request')
    return target === bound ? undefined : { id, kind: 'transition', from: bound, expectedThreadId: target, ...dialect }
  }
  if (params?.threadId !== bound || params?.excludeTurns === true)
    throw new Error('root fork does not match the bound root')
  return { id, kind: 'transition', from: bound, ...dialect }
}

function answers(value: JsonObject | undefined, pending: Pending): value is JsonObject {
  return (
    value !== undefined &&
    value.id === pending.id &&
    typeof value.method !== 'string' &&
    (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))
  )
}

function threadIdFrom(response: JsonObject): string | undefined {
  const thread = isRecord(response.result) ? response.result.thread : undefined
  const id = isRecord(thread) ? thread.id : undefined
  return typeof id === 'string' && THREAD_ID.test(id) ? id : undefined
}

/** `undefined` for non-JSON payloads that are simply forwarded; `'invalid'` for broken or batched JSON. */
function parseRpc(payload: Buffer): JsonObject | undefined | 'invalid' {
  const text = payload.toString('utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return /^\s*[{[]/u.test(text) ? 'invalid' : undefined
  }
  return Array.isArray(value) ? 'invalid' : isRecord(value) ? value : undefined
}

function isId(value: unknown): value is Id {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function forward(socket: Socket, frames: readonly Frame[]): void {
  for (const frame of frames) socket.write(frame.raw)
}

type SocketIdentity = { dev: number; ino: number }

function isOwnedSocket(path: string): { mode: number; dev: number; ino: number } | undefined {
  const info = lstatSync(path)
  return info.isSocket() && !info.isSymbolicLink() && info.uid === process.getuid?.() ? info : undefined
}

function validateUpstream(path: string): void {
  privateDirectory(dirname(path), 'TUI proxy upstream socket directory')
  if (!existsSync(path)) return
  const info = isOwnedSocket(path)
  if (info === undefined || (info.mode & 0o077) !== 0)
    throw new Error('TUI proxy upstream socket must be owned and private')
}

function ownListeningSocket(path: string): SocketIdentity {
  chmodSync(path, 0o600)
  const info = isOwnedSocket(path)
  if (info === undefined || (info.mode & 0o777) !== 0o600)
    throw new Error('TUI proxy socket must be an owned 0600 socket')
  return { dev: info.dev, ino: info.ino }
}

function closeServer(
  server: Server,
  path: string,
  clients: ReadonlySet<Socket>,
  identity: SocketIdentity,
): Promise<void> {
  for (const client of clients) client.destroy()
  return new Promise((resolve, reject) =>
    server.close(error => {
      if (error) return reject(error)
      try {
        // Remove the socket file only if it is still the one this server created.
        if (existsSync(path)) {
          const info = isOwnedSocket(path)
          if (info !== undefined && info.dev === identity.dev && info.ino === identity.ino) unlinkSync(path)
        }
        resolve()
      } catch (cause) {
        reject(cause)
      }
    }),
  )
}
