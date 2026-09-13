import { expect, test } from 'bun:test'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_REQUEST_CANCELLED } from './protocol'
import { type PendingRequest, UnixWebSocketTransport, writeWithPendingRequest } from './unix-websocket'

test('registers a client request before a synchronous local response arrives', async () => {
  const pending = new Map<number, PendingRequest>()
  const response = writeWithPendingRequest(pending, 7, () => {
    const request = pending.get(7)
    expect(request).toBeDefined()
    pending.delete(7); request?.resolve({ accepted: true })
  })
  await expect(response).resolves.toEqual({ accepted: true }); expect(pending.size).toBe(0)
})

test('removes a pending request when its write fails', async () => {
  const pending = new Map<number, PendingRequest>()
  await expect(writeWithPendingRequest(pending, 7, () => { throw new Error('socket write failed') })).rejects.toThrow('socket write failed')
  expect(pending.size).toBe(0)
})

test('rejects a missing Unix socket instead of leaving connect unsettled', async () => {
  const missing = join(tmpdir(), `codex-telegram-missing-${process.pid}-${Date.now()}.sock`)
  const outcome = await Promise.race([
    UnixWebSocketTransport.connect(missing).then(() => ({ kind: 'connected' as const }), error => ({ kind: 'error' as const, error })),
    new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 1_000)),
  ])
  expect(outcome.kind).toBe('error')
})

test('writes no wire result or error when a passive observer cancels a server request', async () => {
  const path = join(tmpdir(), `codex-telegram-observer-${process.pid}-${Date.now()}.sock`)
  let socket: Socket | undefined; let received = Buffer.alloc(0); let sendRequest: (() => void) | undefined
  let observed!: () => void; const invoked = new Promise<void>(resolve => { observed = resolve })
  const server = createServer(client => {
    socket = client
    client.once('data', () => {
      client.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      sendRequest = () => {
        const payload = Buffer.from(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} }))
        client.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
      }
      client.on('data', data => { received = Buffer.concat([received, Buffer.from(data)]) })
    })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
    const transport = await UnixWebSocketTransport.connect(path)
    transport.onServerRequest(async () => { observed(); return SERVER_REQUEST_CANCELLED })
    sendRequest!()
    await Promise.race([invoked, Bun.sleep(1_000).then(() => { throw new Error('passive observer was not invoked') })])
    expect(received).toHaveLength(0)
    transport.close()
  } finally {
    socket?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); if (existsSync(path)) unlinkSync(path)
  }
})


for (const oversized of [false, true]) test(`handles ${oversized ? 'oversized rejection' : 'large MCP inventory'} after WebSocket upgrade`, async () => {
  const path = join(tmpdir(), `codex-telegram-wide-${process.pid}-${oversized}-${Date.now()}.sock`)
  let client: Socket | undefined; let transport: UnixWebSocketTransport | undefined
  const server = createServer(socket => {
    client = socket
    socket.once('data', () => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.once('data', () => {
        const payload = Buffer.from(JSON.stringify({ id: 1, result: { toolDescription: 'x'.repeat(80_000) } }))
        const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127
        header.writeBigUInt64BE(BigInt(oversized ? 16 * 1024 * 1024 + 1 : payload.length), 2)
        socket.write(header.subarray(0, 5))
        socket.write(oversized ? header.subarray(5) : Buffer.concat([header.subarray(5), payload]))
      })
    })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
    transport = await UnixWebSocketTransport.connect(path)
    const response = transport.request('mcpServerStatus/list', {})
    const bounded = Promise.race([response, Bun.sleep(1_000).then(() => { throw new Error('wire response hung') })])
    if (oversized) await expect(bounded).rejects.toThrow('exceeds 16 MiB')
    else expect((await bounded as { toolDescription: string }).toolDescription).toHaveLength(80_000)
  } finally {
    transport?.close(); client?.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (existsSync(path)) unlinkSync(path)
  }
})
