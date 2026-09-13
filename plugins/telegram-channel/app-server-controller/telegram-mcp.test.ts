import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { buildTelegramMcp, type TelegramMcpOptions } from './telegram-mcp'
import { signMessageHandle } from './telegram-handles'
import type { TelegramToolRequest, TelegramToolResult } from './telegram-tools-protocol'

const request = { version: 1 as const, type: 'reply' as const, arguments: { reply_handle: `a.${'b'.repeat(43)}`, text: 'ok', phase: 'final' as const } }

async function mcp(command: (frame: TelegramToolRequest) => Promise<TelegramToolResult>, options?: TelegramMcpOptions) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const server = buildTelegramMcp(command, options); const client = new Client({ name: 'synthetic-client', version: '1.0.0' })
  await server.connect(serverTransport); await client.connect(clientTransport)
  return { client, close: () => client.close() }
}
function resultText(result: unknown): string { const value = typeof result === 'object' && result !== null ? result as { content?: unknown } : {}; const content = Array.isArray(value.content) ? value.content[0] : undefined; if (typeof content !== 'object' || content === null || (content as { type?: unknown }).type !== 'text' || typeof (content as { text?: unknown }).text !== 'string') throw new Error('MCP result is missing text'); return (content as { text: string }).text }
function structuredResult(result: unknown): Record<string, unknown> { const value = typeof result === 'object' && result !== null ? result as { structuredContent?: unknown } : {}; if (typeof value.structuredContent !== 'object' || value.structuredContent === null || Array.isArray(value.structuredContent)) throw new Error('MCP result is missing structured content'); return value.structuredContent as Record<string, unknown> }

test('MCP construction exposes exactly four signed Telegram tools and dispatches unchanged', async () => {
  const handle = signMessageHandle('synthetic-key', { profile: 'synthetic', direction: 'outbound', chatId: '7', messageId: 19, expiresAt: Math.floor(Date.now() / 1000) + 60 }); const seen: unknown[] = []; const session = await mcp(async frame => { seen.push(frame); return { message_ids: [19], message_handles: [handle] } })
  try {
    expect((await session.client.listTools()).tools.map(tool => tool.name)).toEqual(['reply', 'react', 'edit_message', 'download_attachment'])
    const result = await session.client.callTool({ name: 'reply', arguments: request.arguments })
    expect(resultText(result)).toBe('Telegram reply sent (1 message).'); expect(resultText(result)).not.toContain(handle); expect(structuredResult(result)).toEqual({ message_ids: [19], message_handles: [handle], success: true, operation: 'reply' }); expect(seen).toEqual([request])
  } finally { await session.close() }
})

test('opt-in connect accepts only host-inserted metadata and exposes it as the callback thread', async () => {
  const connected: string[] = []; const session = await mcp(async () => ({}), { onConnect: async threadId => { connected.push(threadId); return {} } })
  try {
    expect((await session.client.listTools()).tools.map(tool => tool.name)).toEqual(['reply', 'react', 'edit_message', 'download_attachment', 'connect'])
    const result = await session.client.callTool({ name: 'connect', arguments: {}, _meta: { threadId: 'host-thread/synthetic-42' } } as never)
    expect(resultText(result)).toBe('Telegram connected.'); expect(resultText(result)).not.toContain('host-thread'); expect(structuredResult(result)).toEqual({ threadId: 'host-thread/synthetic-42', connected: true, success: true, operation: 'connect' }); expect(connected).toEqual(['host-thread/synthetic-42'])
  } finally { await session.close() }
})

test('successful receipts keep all reply, react, edit, and download data in structured content', async () => {
  const key = 'synthetic-key'; const now = Math.floor(Date.now() / 1000); const handle = signMessageHandle(key, { profile: 'synthetic', direction: 'outbound', chatId: '7', messageId: 19, expiresAt: now + 60 }); const path = '/private/synthetic/inbox/document.pdf'
  const session = await mcp(async frame => frame.type === 'reply' ? { message_ids: [19], message_handles: [handle] } : frame.type === 'react' ? { message_ids: [20] } : frame.type === 'edit_message' ? { message_ids: [21], message_handles: [handle] } : { path })
  try {
    const cases = [
      { name: 'reply', arguments: request.arguments, text: 'Telegram reply sent (1 message).', structured: { message_ids: [19], message_handles: [handle], success: true, operation: 'reply' }, hidden: handle },
      { name: 'react', arguments: { target_handle: handle, emoji: '👍' }, text: 'Telegram reaction sent.', structured: { message_ids: [20], success: true, operation: 'react' }, hidden: '20' },
      { name: 'edit_message', arguments: { message_handle: handle, text: 'synthetic edit' }, text: 'Telegram message edited.', structured: { message_ids: [21], message_handles: [handle], success: true, operation: 'edit_message' }, hidden: handle },
      { name: 'download_attachment', arguments: { attachment_handle: handle }, text: 'Telegram attachment downloaded.', structured: { path, success: true, operation: 'download_attachment' }, hidden: path },
    ]
    for (const value of cases) { const result = await session.client.callTool({ name: value.name, arguments: value.arguments } as never); expect(resultText(result)).toBe(value.text); expect(resultText(result)).not.toContain(value.hidden); expect(structuredResult(result)).toEqual(value.structured) }
  } finally { await session.close() }
})

test('connect rejects missing, malformed, and argument-spoofed thread authority without invoking the callback', async () => {
  const connected: string[] = []; const session = await mcp(async () => ({}), { onConnect: async threadId => { connected.push(threadId); return {} } })
  try {
    const requests = [
      { name: 'connect', arguments: {} },
      { name: 'connect', arguments: {}, _meta: { threadId: '' } },
      { name: 'connect', arguments: {}, _meta: { threadId: 'bad\nthread' } },
      { name: 'connect', arguments: { threadId: 'spoofed-thread' }, _meta: { threadId: 'host-thread' } },
    ]
    for (const request of requests) { const result = await session.client.callTool(request as never); expect(result.isError).toBeTrue(); expect(resultText(result)).not.toContain('spoofed-thread') }
    expect(connected).toEqual([])
  } finally { await session.close() }
})

test('connect callback failures are safely reported without echoing host data', async () => {
  const session = await mcp(async () => ({}), { onConnect: async () => { throw new Error('private host failure: host-thread/synthetic-42') } })
  try {
    const result = await session.client.callTool({ name: 'connect', arguments: {}, _meta: { threadId: 'host-thread/synthetic-42' } } as never)
    expect(result.isError).toBeTrue(); expect(resultText(result)).toBe('telegram tool failed: connect failed'); expect(resultText(result)).not.toContain('host-thread')
  } finally { await session.close() }
})
