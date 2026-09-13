import { expect, test } from 'bun:test'
import { ApprovalRelay } from './approval-relay'
import { SERVER_REQUEST_CANCELLED } from './protocol'

const policy = { permissions: { enabled: true, operatorDmChatIds: new Set(['7']) }, read() { return this } }
test('relays a string stock request once, validates its operator message, and returns the stock permission deny shape', async () => {
  const calls: string[] = []; let buttons: Array<{ callback_data: string }> = []
  const rpc = { async request(method: string) { calls.push(method); return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage(_chat: string, _text: string, options: { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }) { buttons = options.reply_markup.inline_keyboard[0]!; return { message_id: 11 } }, async editMessageText() {} } }
  const relay = new ApprovalRelay(rpc as never, bot as never, policy as never)
  const pending = relay.request('request-7', 'item/permissions/requestApproval', { threadId: 'thread-1', turnId: 'turn', itemId: 'item', environmentId: 'env', startedAtMs: 1, cwd: '/tmp', permissions: { network: 'limited' } })
  await Bun.sleep(0)
  expect(buttons).toHaveLength(3)
  expect(relay.callback({ data: buttons[2]!.callback_data, from: { id: 7 }, message: { message_id: 11, chat: { id: 7, type: 'private' } } })).toBe('recorded')
  await expect(pending).resolves.toEqual({ permissions: {}, scope: 'turn' })
  expect(calls[0]).toBe('thread/increment_elicitation')
})
test('rejects unsupported requests instead of fabricating a decline', async () => {
  const relay = new ApprovalRelay({ request: async () => ({}), onNotification: () => () => {}, onServerRequest: () => () => {} } as never, { api: {} } as never, policy as never)
  await expect(relay.request(3, 'item/not-real/requestApproval', { threadId: 't' })).rejects.toThrow('unsupported')
})
test('accepts stock command and permission shapes without optional environmentId', async () => {
  const disabled = { permissions: { enabled: false, operatorDmChatIds: new Set<string>() }, read() { return this } }; const relay = new ApprovalRelay({ request: async () => ({}), onNotification: () => () => {}, onServerRequest: () => () => {} } as never, { api: {} } as never, disabled as never)
  await expect(relay.request(1, 'item/commandExecution/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1, availableDecisions: ['accept', { acceptWithExecpolicyAmendment: {} }, 'decline'] })).resolves.toEqual({ decision: 'decline' })
  await expect(relay.request('p', 'item/permissions/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1, cwd: '/tmp', permissions: {} })).resolves.toEqual({ permissions: {}, scope: 'turn' })
  await expect(relay.request('bad', 'item/permissions/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1, cwd: '/tmp', permissions: {}, environmentId: 7 })).rejects.toThrow('malformed')
})
test('returns exact Allow once and Allow session shapes, with the first valid callback winning', async () => {
  let buttons: Array<{ callback_data: string }> = []; let messageId = 10
  const rpc = { async request() { return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage(_chat: string, _text: string, options: { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }) { buttons = options.reply_markup.inline_keyboard[0]!; return { message_id: messageId++ } }, async editMessageText() {} } }
  const relay = new ApprovalRelay(rpc as never, bot as never, policy as never)
  const callback = (data: string, id: number) => relay.callback({ data, from: { id: 7 }, message: { message_id: id, chat: { id: 7, type: 'private' } } })
  const command = relay.request('allow-once', 'item/commandExecution/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1, availableDecisions: ['accept', 'acceptForSession', 'decline'] })
  await Bun.sleep(0)
  const once = buttons.find(button => button.callback_data.startsWith('perm:once:'))!.callback_data; const session = buttons.find(button => button.callback_data.startsWith('perm:session:'))!.callback_data
  expect(callback(once, 10)).toBe('recorded'); expect(callback(session, 10)).toBe('already')
  await expect(command).resolves.toEqual({ decision: 'accept' })
  const permissions = relay.request('allow-session', 'item/permissions/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1, cwd: '/tmp', permissions: { network: 'limited' } })
  await Bun.sleep(0)
  const permissionSession = buttons.find(button => button.callback_data.startsWith('perm:session:'))!.callback_data
  expect(callback(permissionSession, 11)).toBe('recorded')
  await expect(permissions).resolves.toEqual({ permissions: { network: 'limited' }, scope: 'session' })
})
test('async shutdown waits for an in-flight operator send and retires its late keyboard', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); const calls: string[] = []; const retired: number[] = []
  const rpc = { async request(method: string) { calls.push(method); return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage() { await gate; return { message_id: 22 } }, async editMessageText(_chat: string, id: number) { retired.push(id) } } }
  const relay = new ApprovalRelay(rpc as never, bot as never, policy as never); const close = relay.install(); const pending = relay.request(4, 'item/fileChange/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); const closing = close(); release(); await closing; await expect(pending).resolves.toEqual({ decision: 'decline' }); expect(retired).toEqual([22]); expect(calls.filter(value => value === 'thread/decrement_elicitation')).toHaveLength(1)
})
test('resolved while an operator send later rejects decrements exactly once', async () => {
  let reject!: (error: Error) => void; const gate = new Promise<never>((_resolve, fail) => { reject = fail }); let notification!: (method: string, params: Record<string, unknown>) => void; const calls: string[] = []
  const rpc = { async request(method: string) { calls.push(method); return {} }, onNotification(callback: (method: string, params: Record<string, unknown>) => void) { notification = callback; return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage() { return await gate }, async editMessageText() {} } }
  const relay = new ApprovalRelay(rpc as never, bot as never, policy as never); const close = relay.install(); const pending = relay.request('same-id', 'item/fileChange/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); notification('serverRequest/resolved', { threadId: 't', requestId: 'same-id' }); reject(new Error('send failed')); await pending; await close(); expect(calls.filter(value => value === 'thread/decrement_elicitation')).toHaveLength(1)
})
test('times out after ten minutes and cleans up the stale operator callback once', async () => {
  let expire!: () => void; const nativeSetTimeout = globalThis.setTimeout; const calls: string[] = []; let button = ''
  globalThis.setTimeout = ((callback: (...args: never[]) => void, milliseconds?: number, ...args: never[]) => {
    if (milliseconds === 10 * 60_000) { expire = () => callback(...args); return nativeSetTimeout(() => {}, milliseconds) }
    return nativeSetTimeout(callback, milliseconds, ...args)
  }) as unknown as typeof setTimeout
  try {
    const rpc = { async request(method: string) { calls.push(method); return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }
    const bot = { api: { async sendMessage(_chat: string, _text: string, options: { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }) { button = options.reply_markup.inline_keyboard[0]![0]!.callback_data; return { message_id: 11 } }, async editMessageText() {} } }
    const relay = new ApprovalRelay(rpc as never, bot as never, policy as never); const pending = relay.request('timeout-id', 'item/fileChange/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); expire()
    await expect(pending).resolves.toEqual({ decision: 'decline' })
    expect(relay.callback({ data: button, from: { id: 7 }, message: { message_id: 11, chat: { id: 7, type: 'private' } } })).toBe('already')
    await relay.install()(); expect(calls.filter(value => value === 'thread/decrement_elicitation')).toHaveLength(1)
  } finally { globalThis.setTimeout = nativeSetTimeout }
})
test('server resolution wins over a later stale callback and retires its keyboard once', async () => {
  const calls: string[] = []; const retired: number[] = []; let button = ''; let notification!: (method: string, params: Record<string, unknown>) => void
  const rpc = { async request(method: string) { calls.push(method); return {} }, onNotification(callback: (method: string, params: Record<string, unknown>) => void) { notification = callback; return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage(_chat: string, _text: string, options: { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }) { button = options.reply_markup.inline_keyboard[0]![0]!.callback_data; return { message_id: 12 } }, async editMessageText(_chat: string, id: number) { retired.push(id) } } }
  const relay = new ApprovalRelay(rpc as never, bot as never, policy as never); const close = relay.install(); const pending = relay.request('resolved-id', 'item/fileChange/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0)
  notification('serverRequest/resolved', { threadId: 't', requestId: 'resolved-id' })
  expect(typeof await pending).toBe('symbol')
  expect(relay.callback({ data: button, from: { id: 7 }, message: { message_id: 12, chat: { id: 7, type: 'private' } } })).toBe('already')
  await close(); expect(retired).toEqual([12]); expect(calls.filter(value => value === 'thread/decrement_elicitation')).toHaveLength(1)
})

test('scoped relay ignores cross-thread, malformed, unsupported, disabled, invalid, and negative-operator requests without a wire decision', async () => {
  const calls: string[] = []; const sent: string[] = []; const state = { enabled: true, operators: new Set(['7']), invalid: false }
  const source = { read() { if (state.invalid) throw new Error('malformed'); return { permissions: { enabled: state.enabled, operatorDmChatIds: state.operators } } } }
  const rpc = { async request(method: string) { calls.push(method); return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }
  const relay = new ApprovalRelay(rpc as never, { api: { async sendMessage(chatId: string) { sent.push(chatId); return { message_id: 1 } } } } as never, source as never, { threadId: 'bound-thread' })
  const command = { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }
  try {
    for (const [method, params] of [
      ['item/commandExecution/requestApproval', { ...command, threadId: 'other-thread' }],
      ['item/commandExecution/requestApproval', { turnId: 'turn', itemId: 'item', startedAtMs: 1 }],
      ['item/not-real/requestApproval', command],
      ['item/commandExecution/requestApproval', { ...command, startedAtMs: 'bad' }],
    ] as const) await expect(relay.request('ignored', method, params)).resolves.toBe(SERVER_REQUEST_CANCELLED)
    state.enabled = false; await expect(relay.request('disabled', 'item/commandExecution/requestApproval', command)).resolves.toBe(SERVER_REQUEST_CANCELLED)
    state.enabled = true; state.invalid = true; await expect(relay.request('invalid', 'item/commandExecution/requestApproval', command)).resolves.toBe(SERVER_REQUEST_CANCELLED)
    state.invalid = false; state.operators = new Set(['-7']); await expect(relay.request('negative', 'item/commandExecution/requestApproval', command)).resolves.toBe(SERVER_REQUEST_CANCELLED)
    expect(sent).toEqual([]); expect(calls).toEqual([])
  } finally { await relay.install()() }
})

test('scoped relay returns stock command, file, and permissions shapes only to its positive private operator', async () => {
  let buttons: Array<{ callback_data: string }> = []; let messageId = 10; const calls: string[] = []; const state = { enabled: true, operators: new Set(['7']) }
  const source = { read() { return { permissions: { enabled: state.enabled, operatorDmChatIds: state.operators } } } }
  const rpc = { async request(method: string) { calls.push(method); return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage(_chat: string, _text: string, options: { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }) { buttons = options.reply_markup.inline_keyboard[0]!; return { message_id: messageId++ } }, async editMessageText() {} } }
  const relay = new ApprovalRelay(rpc as never, bot as never, source as never, { threadId: 'bound-thread' })
  const callback = (data: string, id: number) => relay.callback({ data, from: { id: 7 }, message: { message_id: id, chat: { id: 7, type: 'private' } } })
  try {
    const command = relay.request('command', 'item/commandExecution/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1, availableDecisions: ['accept', 'acceptForSession', 'decline'] }); await Bun.sleep(0); expect(callback(buttons[0]!.callback_data, 10)).toBe('recorded'); await expect(command).resolves.toEqual({ decision: 'accept' })
    const file = relay.request('file', 'item/fileChange/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); expect(callback(buttons.find(button => button.callback_data.startsWith('perm:deny:'))!.callback_data, 11)).toBe('recorded'); await expect(file).resolves.toEqual({ decision: 'decline' })
    const permissions = relay.request('permissions', 'item/permissions/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1, cwd: '/tmp', permissions: { network: 'limited' } }); await Bun.sleep(0); expect(callback(buttons.find(button => button.callback_data.startsWith('perm:session:'))!.callback_data, 12)).toBe('recorded'); await expect(permissions).resolves.toEqual({ permissions: { network: 'limited' }, scope: 'session' })
    expect(calls.filter(call => call === 'thread/increment_elicitation')).toHaveLength(3)
  } finally { await relay.install()() }
})

test('scoped callback rechecks enabled operators and exact server resolution thread before granting', async () => {
  let buttons: Array<{ callback_data: string }> = []; let notification!: (method: string, params: Record<string, unknown>) => void; const state = { enabled: true, operators: new Set(['7']) }
  const source = { read() { return { permissions: { enabled: state.enabled, operatorDmChatIds: state.operators } } } }
  const rpc = { async request() { return {} }, onNotification(listener: typeof notification) { notification = listener; return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage(_chat: string, _text: string, options: { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }) { buttons = options.reply_markup.inline_keyboard[0]!; return { message_id: 11 } }, async editMessageText() {} } }
  const relay = new ApprovalRelay(rpc as never, bot as never, source as never, { threadId: 'bound-thread' }); const close = relay.install()
  try {
    const pending = relay.request('same-id', 'item/fileChange/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); const deny = buttons.find(button => button.callback_data.startsWith('perm:deny:'))!.callback_data
    notification('serverRequest/resolved', { threadId: 'other-thread', requestId: 'same-id' }); expect(relay.callback({ data: deny, from: { id: 7 }, message: { message_id: 11, chat: { id: 7, type: 'private' } } })).toBe('recorded'); await expect(pending).resolves.toEqual({ decision: 'decline' })
    const revoked = relay.request('revoked', 'item/fileChange/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); const stale = buttons.find(button => button.callback_data.startsWith('perm:once:'))?.callback_data ?? buttons[0]!.callback_data
    state.enabled = false; expect(relay.callback({ data: stale, from: { id: 7 }, message: { message_id: 11, chat: { id: 7, type: 'private' } } })).toBeFalse(); state.enabled = true; state.operators = new Set()
    expect(relay.callback({ data: stale, from: { id: 7 }, message: { message_id: 11, chat: { id: 7, type: 'private' } } })).toBeFalse(); notification('serverRequest/resolved', { threadId: 'bound-thread', requestId: 'revoked' }); await expect(revoked).resolves.toBe(SERVER_REQUEST_CANCELLED)
    state.operators = new Set(['7']); const tui = relay.request('tui-wins', 'item/fileChange/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); const button = buttons[0]!.callback_data; notification('serverRequest/resolved', { threadId: 'bound-thread', requestId: 'tui-wins' }); await expect(tui).resolves.toBe(SERVER_REQUEST_CANCELLED); expect(relay.callback({ data: button, from: { id: 7 }, message: { message_id: 11, chat: { id: 7, type: 'private' } } })).toBe('already')
  } finally { await close() }
})

test('scoped relay releases elicitation before a hung keyboard retirement and rejects callbacks after close', async () => {
  let buttons: Array<{ callback_data: string }> = []; const calls: string[] = []; const source = { read() { return { permissions: { enabled: true, operatorDmChatIds: new Set(['7']) } } } }
  const rpc = { async request(method: string) { calls.push(method); return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage(_chat: string, _text: string, options: { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }) { buttons = options.reply_markup.inline_keyboard[0]!; return { message_id: 1 } }, async editMessageText() { return await new Promise<never>(() => {}) } } }
  const relay = new ApprovalRelay(rpc as never, bot as never, source as never, { threadId: 'bound-thread' }); const close = relay.install()
  try {
    const pending = relay.request('hung-ui', 'item/fileChange/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); const accept = buttons.find(button => button.callback_data.startsWith('perm:once:'))!.callback_data
    expect(relay.callback({ data: accept, from: { id: 7 }, message: { message_id: 1, chat: { id: 7, type: 'private' } } })).toBe('recorded'); await expect(pending).resolves.toEqual({ decision: 'accept' })
    await expect(Promise.race([close(), Bun.sleep(1_000).then(() => { throw new Error('relay close waited for a hung keyboard') })])).resolves.toBeUndefined()
    expect(relay.callback({ data: accept, from: { id: 7 }, message: { message_id: 1, chat: { id: 7, type: 'private' } } })).toBeFalse(); expect(calls.filter(call => call === 'thread/increment_elicitation')).toHaveLength(1); expect(calls.filter(call => call === 'thread/decrement_elicitation')).toHaveLength(1)
  } finally { await close() }
})

test('scoped delayed increment sends no card after close or hot operator revocation and balances each increment', async () => {
  const releases: Array<() => void> = []; const calls: string[] = []; let cards = 0; const state = { enabled: true, operators: new Set(['7']) }
  const source = { read() { return { permissions: { enabled: state.enabled, operatorDmChatIds: state.operators } } } }
  const rpc = { async request(method: string) { calls.push(method); if (method === 'thread/increment_elicitation') await new Promise<void>(resolve => releases.push(resolve)); return {} }, onNotification() { return () => {} }, onServerRequest() { return () => {} } }
  const bot = { api: { async sendMessage() { cards++; return { message_id: cards } }, async editMessageText() {} } }
  const relay = new ApprovalRelay(rpc as never, bot as never, source as never, { threadId: 'bound-thread' }); const close = relay.install()
  try {
    const disabled = relay.request('disabled', 'item/fileChange/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); state.enabled = false; releases.shift()!(); await expect(disabled).resolves.toBe(SERVER_REQUEST_CANCELLED)
    state.enabled = true; state.operators = new Set(['7']); const removed = relay.request('removed', 'item/fileChange/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); state.operators = new Set(); releases.shift()!(); await expect(removed).resolves.toBe(SERVER_REQUEST_CANCELLED)
    state.operators = new Set(['7']); const closing = relay.request('closing', 'item/fileChange/requestApproval', { threadId: 'bound-thread', turnId: 'turn', itemId: 'item', startedAtMs: 1 }); await Bun.sleep(0); await close(); releases.shift()!(); await expect(closing).resolves.toBe(SERVER_REQUEST_CANCELLED)
    expect(cards).toBe(0); expect(calls.filter(call => call === 'thread/increment_elicitation')).toHaveLength(3); expect(calls.filter(call => call === 'thread/decrement_elicitation')).toHaveLength(3)
  } finally { await close() }
})
