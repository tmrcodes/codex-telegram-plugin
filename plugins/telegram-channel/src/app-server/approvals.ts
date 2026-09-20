import { randomBytes } from 'node:crypto'
import type { TelegramPolicy } from '../policy/policy'
import { isRecord, isTelegramUserId, type JsonObject, truncate } from '../shared/guards'
import type { InlineKeyboard, TelegramApi } from '../telegram/bot-api'
import { type AppServerTransport, SERVER_REQUEST_CANCELLED } from './transport'

type Choice = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'
type Resolution = JsonObject | typeof SERVER_REQUEST_CANCELLED
type Pending = {
  token: string
  key: string
  method: string
  params: JsonObject
  resolve: (value: Resolution) => void
  /** Extra callers that were offered the same request; all of them get the one answer. */
  joined: Array<(value: Resolution) => void>
  /** Outcome line for cards of this request, including ones still being delivered when it was answered. */
  closing: string
  timer: ReturnType<typeof setTimeout>
  /** Cards sent after this point are retired immediately instead of being registered. */
  settled: boolean
  finalized: boolean
  elicitationReleased: boolean
  /** `chatId:messageId` of every card that may answer this request. */
  messages: Set<string>
}

const MCP_APPROVAL = 'mcpServer/elicitation/request'
const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval'
const METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  PERMISSIONS_APPROVAL,
  MCP_APPROVAL,
])
const APPROVAL_TIMEOUT_MS = 10 * 60_000
const CLOSE_WAIT_MS = 250
const OUTCOME = {
  accept: 'Allowed.',
  acceptForSession: 'Always allowed.',
  acceptAlways: 'Always allowed.',
  decline: 'Cancelled.',
  cancel: 'Cancelled.',
} as const satisfies Record<Choice, string>
const ANSWERED_ELSEWHERE = 'Answered in Codex.'
const EXPIRED_TEXT = 'Approval expired without an answer.'
const SESSION_ENDED_TEXT = 'Cancelled: the Codex session ended.'

/**
 * Projects the host's approval requests for one thread into the private Telegram DM of each
 * approval operator. In-memory only: it is not a queue or a ledger, and it never approves anything itself.
 */
export class ApprovalRelay {
  readonly #pending = new Map<string, Pending>()
  readonly #sends = new Set<Promise<void>>()
  readonly #cleanup = new Set<Promise<void>>()
  /** Recently resolved cards, so a second tap answers "Already resolved" instead of nothing. */
  readonly #resolved = new Map<string, number>()
  /** Callers waiting on a request that is already being projected, keyed the same way as pending. */
  readonly #claims = new Map<string, Array<(value: Resolution) => void>>()
  #closed = false

  constructor(
    private readonly rpc: AppServerTransport,
    private readonly api: TelegramApi,
    private readonly policy: { read(): TelegramPolicy },
    private readonly threadId: string,
  ) {}

  /** A thread transition may proceed only when no approval is pending or being cleaned up. */
  isQuiescent(): boolean {
    return this.#pending.size === 0 && this.#sends.size === 0 && this.#cleanup.size === 0
  }

  /** Starts answering approval requests; the returned function stops and denies whatever is pending. */
  install(): () => Promise<void> {
    const unrequest = this.rpc.onServerRequest((id, method, params) => this.request(id, method, params))
    const unnotification = this.rpc.onNotification((method, params) => {
      const { threadId, requestId } = params
      if (
        method === 'serverRequest/resolved' &&
        typeof threadId === 'string' &&
        (typeof requestId === 'string' || typeof requestId === 'number')
      ) {
        this.#retire(`${threadId}\x00${requestId}`)
      }
    })
    let closed = false
    return async () => {
      if (closed) return
      closed = true
      this.#closed = true
      unrequest()
      unnotification()
      for (const pending of this.#pending.values()) pending.settled = true
      await settleBriefly([...this.#sends])
      for (const pending of [...this.#pending.values()])
        this.#finish(pending, denyChoice(pending.params), SESSION_ENDED_TEXT)
      await settleBriefly([...this.#cleanup])
    }
  }

  /** Requests for other threads, unsupported shapes or a disabled relay are left to the native UI. */
  async request(id: string | number, method: string, raw: JsonObject): Promise<Resolution> {
    const params = method === MCP_APPROVAL ? flattenMcpApproval(raw) : raw
    if (this.#closed || params.threadId !== this.threadId || !isSupported(method, params))
      return SERVER_REQUEST_CANCELLED
    if (this.#operators() === undefined) return SERVER_REQUEST_CANCELLED

    const key = `${this.threadId}\x00${id}`
    // The host addresses an approval to one client, and the TUI proxy offers us every one it sees,
    // so the same request can arrive twice. One card, one answer, delivered to both callers.
    const waiting = this.#claims.get(key)
    if (waiting !== undefined) return await new Promise<Resolution>(resolve => waiting.push(resolve))
    const joined: Array<(value: Resolution) => void> = []
    this.#claims.set(key, joined)
    const release = (value: Resolution): void => {
      if (this.#claims.get(key) === joined) this.#claims.delete(key)
      for (const resolve of joined.splice(0)) resolve(value)
    }
    try {
      await this.rpc.request('thread/increment_elicitation', { threadId: this.threadId })
    } catch (error) {
      release(SERVER_REQUEST_CANCELLED)
      throw error
    }
    const operators = this.#operators()
    if (this.#closed || operators === undefined) {
      this.#releaseElicitation()
      release(SERVER_REQUEST_CANCELLED)
      return SERVER_REQUEST_CANCELLED
    }
    return await new Promise<Resolution>(resolve => {
      const token = newToken(this.#pending)
      const pending: Pending = {
        token,
        key,
        method,
        params,
        resolve,
        joined,
        closing: ANSWERED_ELSEWHERE,
        settled: false,
        finalized: false,
        elicitationReleased: false,
        messages: new Set(),
        timer: setTimeout(() => this.#finish(pending, denyChoice(params), EXPIRED_TEXT), APPROVAL_TIMEOUT_MS),
      }
      this.#pending.set(token, pending)
      const sending = this.#send(pending, operators)
      this.#sends.add(sending)
      void sending.finally(() => this.#sends.delete(sending))
    })
  }

  /** Another client answered this request first: retire any card that went out for it. */
  resolved(requestId: string | number): void {
    this.#retire(`${this.threadId}\x00${requestId}`)
  }

  /** Handles a tap on an approval card; only the operator who received that exact card counts. */
  callback(query: JsonObject): 'recorded' | 'already' | false {
    const from = isRecord(query.from) ? query.from : undefined
    const message = isRecord(query.message) ? query.message : undefined
    const chat = message !== undefined && isRecord(message.chat) ? message.chat : undefined
    if (
      this.#closed ||
      typeof query.data !== 'string' ||
      from === undefined ||
      message === undefined ||
      chat === undefined ||
      chat.type !== 'private' ||
      typeof from.id !== 'number' ||
      typeof chat.id !== 'number' ||
      typeof message.message_id !== 'number' ||
      from.id !== chat.id
    )
      return false
    const match = /^perm:(once|always|deny):([a-km-z]{5})$/u.exec(query.data)
    if (match === null) return false
    const [, action, token] = match
    const card = `${chat.id}:${message.message_id}`
    const pending = this.#pending.get(token!)
    if (pending === undefined) return (this.#resolved.get(`${token}:${card}`) ?? 0) >= Date.now() ? 'already' : false
    if (!(this.#operators()?.has(String(chat.id)) ?? false) || !pending.messages.has(card)) return false
    const choice: Choice =
      action === 'once'
        ? 'accept'
        : action === 'always'
          ? alwaysChoice(pending.method, pending.params)
          : denyChoice(pending.params)
    if (
      (choice === 'accept' && !offersOnce(pending.params)) ||
      (choice !== 'accept' &&
        choice !== 'decline' &&
        choice !== 'cancel' &&
        !offersAlways(pending.method, pending.params))
    )
      return false
    this.#finish(pending, choice)
    return 'recorded'
  }

  /** The live operator set, or undefined while the relay is disabled, empty or misconfigured. */
  #operators(): ReadonlySet<string> | undefined {
    try {
      const { permissions } = this.policy.read()
      const operators = [...permissions.operatorDmChatIds]
      if (!permissions.enabled || operators.length === 0 || operators.some(operator => !isTelegramUserId(operator)))
        return undefined
      return new Set(operators)
    } catch {
      return undefined
    }
  }

  async #send(pending: Pending, operators: ReadonlySet<string>): Promise<void> {
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        [
          ...(offersOnce(pending.params) ? [{ text: 'Allow', callback_data: `perm:once:${pending.token}` }] : []),
          ...(offersAlways(pending.method, pending.params)
            ? [{ text: 'Always allow', callback_data: `perm:always:${pending.token}` }]
            : []),
          { text: 'Cancel', callback_data: `perm:deny:${pending.token}` },
        ],
      ],
    }
    try {
      for (const chatId of operators) {
        if (this.#closed) {
          this.#finish(pending, denyChoice(pending.params), SESSION_ENDED_TEXT)
          return
        }
        // An operator removed while cards are going out must not receive one.
        if (!(this.#operators()?.has(chatId) ?? false)) {
          this.#finalize(pending, SERVER_REQUEST_CANCELLED)
          return
        }
        const sent = await this.api.sendMessage(chatId, describe(pending.method, pending.params), {
          reply_markup: keyboard,
        })
        if (pending.settled) await this.#retireCard(chatId, sent.message_id, pending.closing)
        else pending.messages.add(`${chatId}:${sent.message_id}`)
      }
    } catch {
      this.#finish(pending, denyChoice(pending.params))
    }
  }

  #finish(pending: Pending, choice: Choice, closing: string = OUTCOME[choice]): void {
    this.#finalize(pending, decision(pending.method, pending.params, choice), closing)
  }

  /** The request was answered elsewhere (native UI, timeout on the host side). */
  #retire(key: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.key === key) {
        this.#finalize(pending, SERVER_REQUEST_CANCELLED)
        return
      }
    }
  }

  #finalize(pending: Pending, result: Resolution, closing: string = ANSWERED_ELSEWHERE): void {
    if (pending.finalized) return
    pending.closing = closing
    pending.finalized = true
    pending.settled = true
    this.#pending.delete(pending.token)
    if (this.#claims.get(pending.key) === pending.joined) this.#claims.delete(pending.key)
    clearTimeout(pending.timer)
    const now = Date.now()
    for (const [card, expiresAt] of this.#resolved) if (expiresAt < now) this.#resolved.delete(card)
    for (const card of pending.messages) this.#resolved.set(`${pending.token}:${card}`, now + APPROVAL_TIMEOUT_MS)
    pending.resolve(result)
    for (const waiting of pending.joined.splice(0)) waiting(result)
    if (!pending.elicitationReleased) {
      pending.elicitationReleased = true
      this.#releaseElicitation()
    }
    this.#trackCleanup(
      (async () => {
        for (const card of pending.messages) {
          const [chatId, messageId] = card.split(':')
          await this.#retireCard(chatId!, Number(messageId), closing)
        }
      })(),
    )
  }

  #releaseElicitation(): void {
    this.#trackCleanup(
      this.rpc.request('thread/decrement_elicitation', { threadId: this.threadId }).then(
        () => {},
        () => {},
      ),
    )
  }

  async #retireCard(chatId: string, messageId: number, closing: string = ANSWERED_ELSEWHERE): Promise<void> {
    try {
      await this.api.editMessageText(chatId, messageId, closing, { reply_markup: { inline_keyboard: [] } })
    } catch {
      /* a stale card cannot regain authority */
    }
  }

  #trackCleanup(cleanup: Promise<void>): void {
    this.#cleanup.add(cleanup)
    void cleanup.finally(() => this.#cleanup.delete(cleanup))
  }
}

function decision(method: string, params: JsonObject, choice: Choice): JsonObject {
  if (method === MCP_APPROVAL) {
    if (choice === 'acceptAlways') return { action: 'accept', content: null, _meta: { persist: 'always' } }
    return choice === 'accept'
      ? { action: 'accept', content: {}, _meta: null }
      : { action: 'decline', content: null, _meta: null }
  }
  if (method === PERMISSIONS_APPROVAL) {
    return choice === 'decline' || choice === 'cancel'
      ? { permissions: {}, scope: 'turn' }
      : { permissions: params.permissions, scope: choice === 'accept' ? 'turn' : 'session' }
  }
  return { decision: choice === 'acceptAlways' ? 'acceptForSession' : choice }
}

/** Some hosts nest the MCP elicitation under `request`; lift it to the top level. */
function flattenMcpApproval(params: JsonObject): JsonObject {
  const nested = isRecord(params.request) ? params.request : undefined
  if (
    nested === undefined ||
    params.mode !== undefined ||
    (typeof nested.mode !== 'string' && !isRecord(nested.requestedSchema))
  )
    return params
  const { request: _request, ...rest } = params
  return { ...rest, ...nested }
}

const MCP_TOOL_FIELDS = new Set([
  'attachment_handle',
  'reply_handle',
  'target_handle',
  'message_handle',
  'text',
  'files',
  'phase',
  'parse_mode',
  'emoji',
])
const MCP_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  '$schema',
  'additionalProperties',
  'title',
  'description',
])
const MCP_FIELD_KEYS = new Set([
  'type',
  'enum',
  'items',
  'maxItems',
  'minItems',
  'minLength',
  'maxLength',
  'description',
  'title',
])

function isOptionalSafeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value))
}

function isToolFieldSchema(value: unknown): boolean {
  if (!isRecord(value) || !Object.keys(value).every(key => MCP_FIELD_KEYS.has(key))) return false
  if (value.type === 'array') {
    const items = value.items
    return (
      isRecord(items) &&
      items.type === 'string' &&
      Object.keys(items).every(key => MCP_FIELD_KEYS.has(key)) &&
      value.enum === undefined &&
      value.minLength === undefined &&
      value.maxLength === undefined &&
      isOptionalSafeInteger(value.maxItems) &&
      isOptionalSafeInteger(value.minItems)
    )
  }
  if (value.type !== undefined && value.type !== 'string') return false
  if (value.items !== undefined || value.maxItems !== undefined || value.minItems !== undefined) return false
  if (!isOptionalSafeInteger(value.minLength) || !isOptionalSafeInteger(value.maxLength)) return false
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some(item => typeof item !== 'string'))
  )
    return false
  return value.type === 'string' || value.enum !== undefined
}

/**
 * The host copies a tool's input schema into its confirmation form. An empty form or a form
 * made only of this plugin's tool fields is a tool confirmation; anything else (a password,
 * a note, a generic prompt) stays in the native UI.
 */
function isMcpToolApproval(params: JsonObject): boolean {
  const meta = isRecord(params._meta) ? params._meta : undefined
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : undefined
  const properties = schema !== undefined && isRecord(schema.properties) ? schema.properties : undefined
  if (schema === undefined || properties === undefined) return false
  const { turnId } = params
  const { required } = schema
  const propertyKeys = Object.keys(properties)
  return (
    typeof params.threadId === 'string' &&
    params.threadId.length > 0 &&
    (turnId === undefined || turnId === null || (typeof turnId === 'string' && turnId.length > 0)) &&
    typeof params.serverName === 'string' &&
    params.serverName.length > 0 &&
    params.mode === 'form' &&
    typeof params.message === 'string' &&
    meta?.codex_approval_kind === 'mcp_tool_call' &&
    schema.type === 'object' &&
    propertyKeys.every(key => MCP_TOOL_FIELDS.has(key) && isToolFieldSchema(properties[key])) &&
    (required === undefined ||
      required === null ||
      (Array.isArray(required) && required.every(item => typeof item === 'string' && propertyKeys.includes(item)))) &&
    Object.keys(schema).every(key => MCP_SCHEMA_KEYS.has(key))
  )
}

function isDecision(value: unknown): boolean {
  if (value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel') return true
  return (
    isRecord(value) &&
    (Object.hasOwn(value, 'acceptWithExecpolicyAmendment') || Object.hasOwn(value, 'applyNetworkPolicyAmendment'))
  )
}

function isSupported(method: string, params: JsonObject): boolean {
  if (method === MCP_APPROVAL) return isMcpToolApproval(params)
  if (!METHODS.has(method)) return false
  const { environmentId, availableDecisions } = params
  if (
    typeof params.threadId !== 'string' ||
    typeof params.turnId !== 'string' ||
    typeof params.itemId !== 'string' ||
    typeof params.startedAtMs !== 'number' ||
    !Number.isSafeInteger(params.startedAtMs) ||
    (environmentId !== undefined && environmentId !== null && typeof environmentId !== 'string')
  )
    return false
  if (method === PERMISSIONS_APPROVAL) {
    const { reason } = params
    if (
      typeof params.cwd !== 'string' ||
      !isRecord(params.permissions) ||
      (reason !== undefined && reason !== null && typeof reason !== 'string')
    )
      return false
  }
  // A request that cannot be refused must not be offered for a one-tap answer.
  return (
    availableDecisions === undefined ||
    (Array.isArray(availableDecisions) &&
      availableDecisions.every(isDecision) &&
      availableDecisions.some(value => value === 'decline' || value === 'cancel'))
  )
}

function offers(params: JsonObject, choice: Choice): boolean {
  return params.availableDecisions === undefined || (params.availableDecisions as unknown[]).includes(choice)
}

function offersOnce(params: JsonObject): boolean {
  return offers(params, 'accept')
}

/** A tool confirmation is always for this one call; only native requests can cover the session. */
function offersSession(method: string, params: JsonObject): boolean {
  return method !== MCP_APPROVAL && (method === PERMISSIONS_APPROVAL || offers(params, 'acceptForSession'))
}

/** `Always allow` exists when the host offers a persistent grant: `always` for a tool, the session otherwise. */
function offersAlways(method: string, params: JsonObject): boolean {
  if (method !== MCP_APPROVAL) return offersSession(method, params)
  const meta = isRecord(params._meta) ? params._meta : undefined
  return Array.isArray(meta?.persist) && meta.persist.includes('always')
}

/** The strongest persistent grant this request accepts. */
function alwaysChoice(method: string, params: JsonObject): Choice {
  return method === MCP_APPROVAL ? 'acceptAlways' : 'acceptForSession'
}

function denyChoice(params: JsonObject): Choice {
  return offers(params, 'decline') ? 'decline' : 'cancel'
}

function describe(method: string, params: JsonObject): string {
  if (method === MCP_APPROVAL) {
    const meta = isRecord(params._meta) ? params._meta : undefined
    const toolArguments = meta !== undefined && isRecord(meta.tool_params) ? meta.tool_params : {}
    const lines = Object.entries(toolArguments)
      .slice(0, 12)
      .map(([key, value]) => {
        if (/token|secret|password|authorization|handle/iu.test(key)) return `${plain(key)}: [redacted]`
        const text = plain(typeof value === 'string' ? value : JSON.stringify(value))
        return `${plain(key)}: ${text.replace(/2[rmat]\.[A-Za-z0-9_.-]+/gu, '[signed handle]')}`
      })
    return truncate(
      `Codex tool approval\nServer: ${plain(params.serverName as string)}\n${plain(params.message as string)}\n${lines.join('\n')}\n\n` +
        'Allow applies to this request only; Always allow remembers it for later calls.\nPreview may be shortened; inspect the full request in Codex if needed.',
      3500,
    )
  }
  const permissions = isRecord(params.permissions) ? params.permissions : undefined
  const [type, fields]: [string, Array<[string, unknown]>] = method.includes('commandExecution')
    ? [
        'command execution',
        [
          ['Command', params.command],
          ['CWD', params.cwd],
          ['Reason', params.reason],
        ],
      ]
    : method.includes('fileChange')
      ? [
          'file change',
          [
            ['Grant root', params.grantRoot],
            ['Reason', params.reason],
          ],
        ]
      : [
          'permissions',
          [
            ['Network', permissions?.network],
            ['Filesystem', permissions?.filesystem],
          ],
        ]
  const lines = fields.flatMap(([name, value]) => {
    if (value === undefined) return []
    return [`${name}: ${plain(typeof value === 'string' ? value : JSON.stringify(value))}`]
  })
  return truncate(`Codex approval: ${type}\n${lines.length === 0 ? 'No additional details.' : lines.join('\n')}`, 1800)
}

/** Single-line, bounded rendering of untrusted request text. */
function plain(value: string): string {
  return truncate(
    value
      .replace(/[\x00-\x1f\x7f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
    512,
  )
}

/** Five letters without `l`, which is easily confused with `1` or `I` in callback data. */
function newToken(pending: ReadonlyMap<string, Pending>): string {
  for (;;) {
    const token = randomBytes(4)
      .toString('base64url')
      .toLowerCase()
      .replace(/[^a-km-z]/gu, 'a')
      .slice(0, 5)
    if (!pending.has(token)) return token
  }
}

/** Shutdown waits only briefly for Telegram; a stuck request must not hold the session open. */
function settleBriefly(promises: readonly Promise<unknown>[]): Promise<void> {
  if (promises.length === 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, CLOSE_WAIT_MS)
    void Promise.allSettled(promises).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
