import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { signAttachmentHandle, signMessageHandle, verifyAttachmentHandle, verifyMessageHandle } from './telegram-handles'
import { parseTelegramToolRequest, toolSpecs } from './telegram-tools-protocol'

test('signed message and attachment handles reject tamper, expiry, and profile confusion', () => {
  const now = 100; const message = signMessageHandle('k', { profile: 'sample-profile', direction: 'outbound', chatId: '7', messageId: 9, expiresAt: 200 }); const attachment = signAttachmentHandle('k', { profile: 'sample-profile', direction: 'inbound', chatId: '7', messageId: 9, fileId: 'abc', kind: 'document', expiresAt: 200 })
  expect(message.length).toBeLessThanOrEqual(110); expect(attachment.length).toBeLessThanOrEqual(110)
  expect(verifyMessageHandle('k', message, 'sample-profile', true, now)).toMatchObject({ messageId: 9 }); expect(verifyAttachmentHandle('k', attachment, 'sample-profile', now)).toMatchObject({ fileId: 'abc' }); expect(() => verifyMessageHandle('other-key', message, 'sample-profile', true, now)).toThrow(); expect(() => verifyMessageHandle('k', message, 'other-profile', true, now)).toThrow(); expect(() => verifyMessageHandle('k', signMessageHandle('k', { profile: 'sample-profile', direction: 'inbound', chatId: '7', messageId: 9, expiresAt: 200 }), 'sample-profile', true, now)).toThrow(); expect(() => verifyAttachmentHandle('k', `${attachment}x`, 'sample-profile', now)).toThrow(); expect(() => verifyMessageHandle('k', message, 'sample-profile', true, 201)).toThrow()
})
test('legacy v1 message and attachment routes continue through the transition', () => {
  const legacy = (value: Record<string, unknown>) => { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${createHmac('sha256', 'k').update(payload).digest('base64url')}` }
  const message = legacy({ v: 1, k: 'm', profile: 'sample-profile', direction: 'outbound', chatId: '7', messageId: 9, expiresAt: 200, kind: 'text' })
  const attachment = legacy({ v: 1, k: 'a', profile: 'sample-profile', direction: 'inbound', chatId: '7', messageId: 9, fileId: 'abc', kind: 'document', expiresAt: 200 })
  expect(verifyMessageHandle('k', message, 'sample-profile', true, 100)).toMatchObject({ messageId: 9 }); expect(verifyAttachmentHandle('k', attachment, 'sample-profile', 100)).toMatchObject({ fileId: 'abc' })
})
test('tool protocol permits only strict signed-handle arguments', () => {
  const handle = signMessageHandle('k', { profile: 'sample-profile', direction: 'outbound', chatId: '7', messageId: 9, expiresAt: 200 }); expect(parseTelegramToolRequest(JSON.stringify({ version: 1, type: 'edit_message', arguments: { message_handle: handle, text: 'ok' } })).type).toBe('edit_message'); expect(() => parseTelegramToolRequest(JSON.stringify({ version: 1, type: 'react', arguments: { target_handle: handle, emoji: '✅', chat_id: 7 } }))).toThrow()
})
test('tool descriptions distinguish inbound react targets from outbound edit receipts', () => {
  const specs = toolSpecs(); const react = specs.find(spec => spec.name === 'react'); const edit = specs.find(spec => spec.name === 'edit_message')
  expect(react?.description).toContain('target_handle'); expect(react?.description).toContain('inbound targets')
  expect(edit?.description).toContain('returned by reply'); expect(edit?.description).toContain('never use an inbound target_handle')
})
