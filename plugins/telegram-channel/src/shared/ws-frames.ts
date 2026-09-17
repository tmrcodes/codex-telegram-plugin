import { randomBytes } from 'node:crypto'

/** Minimal RFC 6455 framing shared by the App Server client and the TUI proxy. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_OUTBOUND_BYTES = 65_535

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

export type Frame = { fin: boolean; opcode: number; payload: Buffer; raw: Buffer }
export type TextMessage = { payload: Buffer; frames: Frame[] }

/**
 * Decodes one frame from the head of `bytes`, or returns undefined when more data is needed.
 * A client must mask and a server must not; the expected side is supplied by the caller.
 */
export function decodeFrame(bytes: Buffer, expectMasked: boolean): { frame: Frame; size: number } | undefined {
  if (bytes.byteLength < 2) return undefined
  const first = bytes[0]!
  const second = bytes[1]!
  const masked = (second & 0x80) !== 0
  const indicator = second & 0x7f
  if (masked !== expectMasked || (first & 0x70) !== 0) throw new Error('invalid WebSocket frame')
  const extended = indicator < 126 ? 0 : indicator === 126 ? 2 : 8
  const header = 2 + extended + (masked ? 4 : 0)
  if (bytes.byteLength < header) return undefined
  const length =
    indicator < 126 ? indicator : indicator === 126 ? bytes.readUInt16BE(2) : Number(bytes.readBigUInt64BE(2))
  if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) throw new Error('WebSocket frame exceeds 16 MiB')
  if (bytes.byteLength < header + length) return undefined
  const opcode = first & 0x0f
  const fin = (first & 0x80) !== 0
  if (opcode >= 0x8 && (!fin || length > 125)) throw new Error('invalid WebSocket control frame')
  const raw = Buffer.from(bytes.subarray(0, header + length))
  const payload = Buffer.from(bytes.subarray(header, header + length))
  if (masked) {
    const key = bytes.subarray(header - 4, header)
    for (let index = 0; index < payload.byteLength; index++) payload[index]! ^= key[index % 4]!
  }
  return { frame: { fin, opcode, payload, raw }, size: header + length }
}

/** Accumulates a byte stream into complete frames. */
export class FrameDecoder {
  #pending = Buffer.alloc(0)

  constructor(private readonly expectMasked: boolean) {}

  push(chunk: Buffer): Frame[] {
    this.#pending = Buffer.concat([this.#pending, chunk])
    const frames: Frame[] = []
    for (;;) {
      const decoded = decodeFrame(this.#pending, this.expectMasked)
      if (decoded === undefined) return frames
      frames.push(decoded.frame)
      this.#pending = this.#pending.subarray(decoded.size)
    }
  }
}

/**
 * Reassembles a possibly fragmented text message. Control and binary frames return undefined
 * and are handled by the caller; `fragments` is the caller-owned continuation buffer.
 */
export function collectText(frame: Frame, fragments: Frame[]): TextMessage | undefined {
  if (
    frame.opcode === OPCODE.close ||
    frame.opcode === OPCODE.ping ||
    frame.opcode === OPCODE.pong ||
    frame.opcode === OPCODE.binary
  )
    return undefined
  if (frame.opcode === OPCODE.text) {
    if (fragments.length > 0) throw new Error('new text frame during continuation')
    if (frame.fin) return { payload: frame.payload, frames: [frame] }
    fragments.push(frame)
    return undefined
  }
  if (frame.opcode !== OPCODE.continuation || fragments.length === 0) throw new Error('unsupported WebSocket frame')
  fragments.push(frame)
  const size = fragments.reduce((total, item) => total + item.payload.byteLength, 0)
  if (size > MAX_FRAME_BYTES) throw new Error('fragmented WebSocket text exceeds 16 MiB')
  if (!frame.fin) return undefined
  const message = { payload: Buffer.concat(fragments.map(item => item.payload)), frames: [...fragments] }
  fragments.length = 0
  return message
}

/** An unmasked server-to-client text frame. */
export function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  if (payload.byteLength < 126) return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload])
  if (payload.byteLength > MAX_OUTBOUND_BYTES) throw new Error('WebSocket text frame exceeds 65535 bytes')
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.byteLength, 2)
  return Buffer.concat([header, payload])
}

/** A masked client-to-server frame; `opcodeByte` already carries the FIN bit. */
export function clientFrame(opcodeByte: number, payload: Buffer): Buffer {
  if (payload.length > MAX_OUTBOUND_BYTES) throw new Error('WebSocket outbound frame exceeds 65535 bytes')
  const mask = randomBytes(4)
  const header =
    payload.length < 126
      ? Buffer.from([opcodeByte, 0x80 | payload.length])
      : Buffer.from([opcodeByte, 0xfe, payload.length >> 8, payload.length & 0xff])
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!))
  return Buffer.concat([header, mask, masked])
}
