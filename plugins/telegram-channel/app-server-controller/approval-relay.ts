import { randomBytes } from 'node:crypto'
import type { Bot } from 'grammy'
import type { TelegramPolicySource } from '../telegram-policy'
import { SERVER_REQUEST_CANCELLED, type AppServerTransport } from './protocol'

type Choice = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
type Pending = { token: string; key: string; method: string; params: Record<string, unknown>; resolve: (value: Record<string, unknown> | typeof SERVER_REQUEST_CANCELLED) => void; timer: ReturnType<typeof setTimeout>; settled: boolean; finalized: boolean; elicitationReleased: boolean; messages: Set<string> }
const METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'])
const CLOSE_WAIT_MS = 250
export type ApprovalRelayScope = { threadId: string }

/** In-memory Telegram projection of stock App Server approvals. It is deliberately not a queue or ledger. */
export class ApprovalRelay {
  readonly #pending = new Map<string, Pending>()
  readonly #sends = new Set<Promise<void>>()
  readonly #cleanup = new Set<Promise<void>>()
  readonly #resolved = new Map<string, number>()
  #closed = false
  constructor(private readonly rpc: AppServerTransport, private readonly bot: Bot, private readonly policy: TelegramPolicySource, private readonly scope?: ApprovalRelayScope) {}
  /** Read-only transition fence; it never resolves or denies a live approval. */
  isQuiescent(): boolean { return this.#pending.size === 0 && this.#sends.size === 0 && this.#cleanup.size === 0 }
  install(): () => Promise<void> {
    const unrequest = this.rpc.onServerRequest?.((id, method, params) => this.request(id, method, params)) ?? (() => {})
    const unnotification = this.rpc.onNotification((method, params) => { if (method === 'serverRequest/resolved' && typeof params.threadId === 'string' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) this.retire(`${params.threadId}\u0000${params.requestId}`) })
    let closed = false
    return async () => { if (closed) return; closed = true; this.#closed = true; unrequest(); unnotification(); for (const pending of this.#pending.values()) pending.settled = true; await bounded([...this.#sends]); for (const pending of [...this.#pending.values()]) this.finish(pending, denyChoice(pending.params)); await bounded([...this.#cleanup]) }
  }
  async request(id: string | number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | typeof SERVER_REQUEST_CANCELLED> {
    if (this.#closed) return SERVER_REQUEST_CANCELLED
    if (this.scope !== undefined) {
      if (params.threadId !== this.scope.threadId || !valid(method, params)) return SERVER_REQUEST_CANCELLED
      const operators = this.#scopedOperators(); if (operators === undefined) return SERVER_REQUEST_CANCELLED
      return await this.#request(id, method, params, operators)
    }
    if (!valid(method, params)) throw new Error('unsupported or malformed App Server approval request')
    const policy = this.policy.read()
    if (!policy.permissions.enabled || policy.permissions.operatorDmChatIds.size === 0) return decision(method, params, denyChoice(params))
    return await this.#request(id, method, params, policy.permissions.operatorDmChatIds)
  }
  async #request(id: string | number, method: string, params: Record<string, unknown>, operators: ReadonlySet<string>): Promise<Record<string, unknown> | typeof SERVER_REQUEST_CANCELLED> {
    const key = `${params.threadId}\u0000${id}`
    if ([...this.#pending.values()].some(pending => pending.key === key)) throw new Error('approval request already pending')
    await this.rpc.request('thread/increment_elicitation', { threadId: params.threadId })
    const currentOperators = this.scope === undefined ? operators : this.#scopedOperators()
    if (this.scope !== undefined && (this.#closed || currentOperators === undefined)) { this.#decrement(params.threadId as string); return SERVER_REQUEST_CANCELLED }
    return await new Promise<Record<string, unknown> | typeof SERVER_REQUEST_CANCELLED>(resolve => {
      const token = tokenFor(this.#pending)
      const pending: Pending = { token, key, method, params, resolve, settled: false, finalized: false, elicitationReleased: false, messages: new Set(), timer: setTimeout(() => this.finish(pending, denyChoice(params)), 10 * 60_000) }
      this.#pending.set(token, pending)
      const sending = this.#send(pending, currentOperators ?? operators); this.#sends.add(sending); void sending.finally(() => this.#sends.delete(sending))
    })
  }
  #scopedOperators(): ReadonlySet<string> | undefined { try { const policy = this.policy.read(); const operators = [...policy.permissions.operatorDmChatIds]; if (!policy.permissions.enabled || operators.length === 0 || operators.some(operator => !positiveTelegramId(operator))) return undefined; return new Set(operators) } catch { return undefined } }
  async #send(pending: Pending, operators: ReadonlySet<string>): Promise<void> {
    const buttons = [...(supportsOnce(pending.params) ? [{ text: 'Allow once', callback_data: `perm:once:${pending.token}` }] : []), ...(supportsSession(pending.method, pending.params) ? [{ text: 'Allow session', callback_data: `perm:session:${pending.token}` }] : []), { text: 'Deny', callback_data: `perm:deny:${pending.token}` }]
    try { for (const chatId of operators) { const currentOperators = this.scope === undefined ? operators : this.#scopedOperators(); if (this.scope !== undefined && this.#closed) { this.finish(pending, denyChoice(pending.params)); return } if (currentOperators === undefined || !currentOperators.has(chatId)) { this.#cancel(pending); return } const sent = await this.bot.api.sendMessage(chatId, describe(pending.method, pending.params), { reply_markup: { inline_keyboard: [buttons] } }); const key = `${chatId}:${sent.message_id}`; if (pending.settled) { try { await this.bot.api.editMessageText(chatId, sent.message_id, 'Codex approval resolved.', { reply_markup: { inline_keyboard: [] } }) } catch {} } else pending.messages.add(key) } } catch { this.finish(pending, denyChoice(pending.params)) }
  }
  callback(query: Record<string, unknown>): 'recorded' | 'already' | false {
    const data = query.data; const from = record(query.from); const message = record(query.message); const chat = message === undefined ? undefined : record(message.chat)
    if (this.#closed || typeof data !== 'string' || from === undefined || chat === undefined || chat.type !== 'private' || typeof from.id !== 'number' || typeof chat.id !== 'number' || typeof message?.message_id !== 'number' || from.id !== chat.id) return false
    const match = /^perm:(once|session|deny):([a-km-z]{5})$/u.exec(data); if (match === null) return false
    const identity = `${match[2]}:${chat.id}:${message.message_id}`; const pending = this.#pending.get(match[2]); if (pending === undefined) return this.#resolved.get(identity)! >= Date.now() ? 'already' : false
    let operators: ReadonlySet<string>; try { const policy = this.policy.read(); if (!policy.permissions.enabled) return false; operators = this.scope === undefined ? policy.permissions.operatorDmChatIds : this.#scopedOperators() ?? new Set() } catch { return false }
    if (!operators.has(String(chat.id)) || !pending.messages.has(`${chat.id}:${message.message_id}`)) return false
    const choice: Choice = match[1] === 'once' ? 'accept' : match[1] === 'session' ? 'acceptForSession' : denyChoice(pending.params); if ((choice === 'accept' && !supportsOnce(pending.params)) || (choice === 'acceptForSession' && !supportsSession(pending.method, pending.params))) return false
    this.finish(pending, choice); return 'recorded'
  }
  private finish(pending: Pending, choice: Choice): void { this.#finalize(pending, decision(pending.method, pending.params, choice)) }
  private retire(key: string): void { for (const pending of this.#pending.values()) if (pending.key === key) { this.#cancel(pending); return } }
  #cancel(pending: Pending): void { this.#finalize(pending, SERVER_REQUEST_CANCELLED) }
  #finalize(pending: Pending, result: Record<string, unknown> | typeof SERVER_REQUEST_CANCELLED): void { if (pending.finalized) return; pending.finalized = true; pending.settled = true; this.#pending.delete(pending.token); clearTimeout(pending.timer); for (const value of pending.messages) this.#resolved.set(`${pending.token}:${value}`, Date.now() + 10 * 60_000); pending.resolve(result); this.#decrement(pending.params.threadId as string, pending); const cleanup = this.#retireKeyboard(pending); this.#cleanup.add(cleanup); void cleanup.finally(() => this.#cleanup.delete(cleanup)) }
  #decrement(threadId: string, pending?: Pending): void { if (pending?.elicitationReleased) return; if (pending !== undefined) pending.elicitationReleased = true; const cleanup: Promise<void> = this.rpc.request('thread/decrement_elicitation', { threadId }).then(() => {}, () => {}); this.#cleanup.add(cleanup); void cleanup.finally(() => this.#cleanup.delete(cleanup)) }
  async #retireKeyboard(pending: Pending): Promise<void> { for (const value of pending.messages) { const [chatId, rawMessageId] = value.split(':'); try { await this.bot.api.editMessageText(chatId, Number(rawMessageId), 'Codex approval resolved.', { reply_markup: { inline_keyboard: [] } }) } catch { /* stale UI cannot regain authority */ } } }
}
function decision(method: string, params: Record<string, unknown>, choice: Choice): Record<string, unknown> { if (method === 'item/permissions/requestApproval') return choice === 'decline' || choice === 'cancel' ? { permissions: {}, scope: 'turn' } : { permissions: params.permissions, scope: choice === 'acceptForSession' ? 'session' : 'turn' }; return { decision: choice } }
function valid(method: string, params: Record<string, unknown>): boolean { const fields = method === 'item/permissions/requestApproval' ? ['threadId', 'turnId', 'itemId', 'startedAtMs', 'cwd', 'permissions'] : ['threadId', 'turnId', 'itemId', 'startedAtMs']; const environment = params.environmentId; const decision = (value: unknown): boolean => { const amendment = record(value); return value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel' || (amendment !== undefined && (Object.hasOwn(amendment, 'acceptWithExecpolicyAmendment') || Object.hasOwn(amendment, 'applyNetworkPolicyAmendment'))) }; if (!METHODS.has(method) || fields.some(field => params[field] === undefined) || typeof params.threadId !== 'string' || typeof params.turnId !== 'string' || typeof params.itemId !== 'string' || typeof params.startedAtMs !== 'number' || !Number.isSafeInteger(params.startedAtMs) || (environment !== undefined && environment !== null && typeof environment !== 'string') || (method === 'item/permissions/requestApproval' && (typeof params.cwd !== 'string' || record(params.permissions) === undefined || (params.reason !== undefined && params.reason !== null && typeof params.reason !== 'string')))) return false; if (params.availableDecisions !== undefined && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.every(decision) || !params.availableDecisions.some(value => value === 'decline' || value === 'cancel'))) return false; return true }
function supportsOnce(params: Record<string, unknown>): boolean { return params.availableDecisions === undefined || (params.availableDecisions as unknown[]).includes('accept') }
function supportsSession(method: string, params: Record<string, unknown>): boolean { return method === 'item/permissions/requestApproval' || params.availableDecisions === undefined || (params.availableDecisions as unknown[]).includes('acceptForSession') }
function denyChoice(params: Record<string, unknown>): Choice { return params.availableDecisions === undefined || (params.availableDecisions as unknown[]).includes('decline') ? 'decline' : 'cancel' }
function describe(method: string, params: Record<string, unknown>): string { const type = method.includes('commandExecution') ? 'command execution' : method.includes('fileChange') ? 'file change' : 'permissions'; const permissions = record(params.permissions); const fields: Array<[string, unknown]> = type === 'command execution' ? [['Command', params.command], ['CWD', params.cwd], ['Reason', params.reason]] : type === 'file change' ? [['Grant root', params.grantRoot], ['Reason', params.reason]] : [['Network', permissions?.network], ['Filesystem', permissions?.filesystem]]; const lines = fields.flatMap(([name, value]) => typeof value === 'string' ? [`${name}: ${plain(value)}`] : value === undefined ? [] : [`${name}: ${plain(JSON.stringify(value))}`]); return Array.from(`Codex approval: ${type}\nProfile/session: Telegram operator relay\n${lines.length === 0 ? 'No additional details.' : lines.join('\n')}`).slice(0, 1800).join('') }
function plain(value: string): string { return Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 512).join('') }
function tokenFor(pending: Map<string, Pending>): string { for (;;) { const token = randomBytes(4).toString('base64url').toLowerCase().replace(/[^a-km-z]/gu, 'a').slice(0, 5); if (!pending.has(token)) return token } }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function positiveTelegramId(value: string): boolean { return /^[1-9]\d{0,19}$/u.test(value) }
function bounded(promises: readonly Promise<unknown>[]): Promise<void> { if (promises.length === 0) return Promise.resolve(); return new Promise(resolve => { const timer = setTimeout(resolve, CLOSE_WAIT_MS); void Promise.allSettled(promises).then(() => { clearTimeout(timer); resolve() }) }) }
