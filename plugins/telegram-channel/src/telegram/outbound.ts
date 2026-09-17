import { lstatSync, realpathSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import type { ChunkMode } from '../policy/policy'

export const MAX_MESSAGE_CHARACTERS = 4096
export const MAX_REPLY_PARTS = 16
const MAX_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024

/**
 * Splits text into Telegram-sized parts by code points. `newline` mode prefers a paragraph,
 * line or word boundary inside the window; `length` cuts exactly at the limit.
 */
export function chunkText(text: string, limit = MAX_MESSAGE_CHARACTERS, mode: ChunkMode = 'length'): string[] {
  const points = Array.from(text)
  const chunks: string[] = []
  while (points.length > 0) {
    let end = Math.min(limit, points.length)
    if (mode === 'newline' && end < points.length) {
      const window = points.slice(0, end).join('')
      const paragraph = window.lastIndexOf('\n\n')
      const line = window.lastIndexOf('\n')
      const space = window.lastIndexOf(' ')
      const boundary = paragraph > 0 ? paragraph + 2 : line > 0 ? line + 1 : space > 0 ? space + 1 : 0
      if (boundary > 0) end = Array.from(window.slice(0, boundary)).length
    }
    chunks.push(points.splice(0, Math.max(1, end)).join(''))
  }
  return chunks
}

/** Images Telegram can show inline go out as photos; everything else as documents. */
export function isPhotoPath(path: string): boolean {
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(path).toLowerCase())
}

/**
 * Resolves an outbound file to its real path. Only regular, non-symlinked files inside the
 * configured roots (workspace and inbox) and within Telegram's size limit may leave the machine.
 */
export function resolveOutboundFile(value: string, fileRoots: readonly string[]): string {
  const path = resolve(value)
  const candidate = lstatSync(path)
  const real = realpathSync(path)
  const stat = lstatSync(real)
  const insideRoot = fileRoots.some(root => real === root || real.startsWith(`${root}${sep}`))
  if (
    candidate.isSymbolicLink() ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_OUTBOUND_FILE_BYTES ||
    !insideRoot
  ) {
    throw new Error('outbound file is outside the bounded workspace/inbox contract')
  }
  return real
}
