import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { TelegramOwnerBridge, forwardTelegramOwnerBridge, telegramOwnerBridgePath } from './telegram-owner-bridge'

function fixture() { const root = mkdtempSync(join(tmpdir(), 'telegram-owner-bridge-')); chmodSync(root, 0o700); const state = join(root, 'state'); mkdirSync(state, { mode: 0o700 }); chmodSync(state, 0o700); return { root, path: telegramOwnerBridgePath(state) } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
test('owner bridge is owner-only, one-frame, and hides target details', async () => {
  const value = fixture(); let current = 'thread-a'
  const bridge = new TelegramOwnerBridge(value.path, { async connect(threadId) { if (threadId !== current) throw new Error('private current binding'); return { threadId } }, async executeTool(threadId) { if (threadId !== current) throw new Error('private current binding'); return {} } })
  try {
    await bridge.start(); expect(lstatSync(value.path).mode & 0o777).toBe(0o600)
    await expect(forwardTelegramOwnerBridge(value.path, { version: 1, operation: 'connect', threadId: 'thread-a' })).resolves.toEqual({ threadId: 'thread-a' })
    await expect(forwardTelegramOwnerBridge(value.path, { version: 1, operation: 'connect', threadId: 'thread-b' })).rejects.toThrow('owner bridge request failed')
    current = 'thread-b'; await expect(forwardTelegramOwnerBridge(value.path, { version: 1, operation: 'tool', threadId: 'thread-a', request: { version: 1, type: 'react', arguments: { target_handle: 'synthetic', emoji: '✅' } } })).rejects.toThrow('owner bridge request failed')
  } finally { await bridge.close(); rmSync(value.root, { recursive: true, force: true }) }
})

test('bridge close waits for a live owner tool handler before a caller can release its lease', async () => {
  const value = fixture(); const tool = deferred<Record<string, unknown>>(); let started = false
  const bridge = new TelegramOwnerBridge(value.path, { async connect() { return {} }, async executeTool() { started = true; return await tool.promise } })
  try {
    await bridge.start()
    void forwardTelegramOwnerBridge(value.path, { version: 1, operation: 'tool', threadId: 'thread-a', request: { version: 1, type: 'react', arguments: { target_handle: 'synthetic', emoji: '✅' } } }).catch(() => {})
    for (let i = 0; !started && i < 20; i++) await Bun.sleep(1)
    expect(started).toBeTrue()
    let settled = false; const closing = bridge.close().then(() => { settled = true })
    await Bun.sleep(2); expect(settled).toBeFalse()
    tool.resolve({}); await closing; expect(settled).toBeTrue()
  } finally { await bridge.close(); rmSync(value.root, { recursive: true, force: true }) }
})
