import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

export const AUTO_MEDIA_MAX_BYTES = 5 * 1024 * 1024
export const EXPLICIT_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024
export const DOWNLOAD_DEADLINE_MS = 15_000

export class AttachmentTooLargeError extends Error {}

/** `getFile` paths are provider-controlled; accept only a plain relative path. */
export function isSafeTelegramFilePath(filePath: string): boolean {
  return /^[A-Za-z0-9_./-]{1,512}$/u.test(filePath) && !filePath.startsWith('/') && !filePath.split('/').includes('..')
}

let downloadSequence = 0

/**
 * Streams one Telegram file into the private inbox with a hard byte limit.
 * The file appears under its final name only once it is complete (exclusive temp + rename).
 */
export async function downloadToInbox(options: {
  url: string
  inbox: string
  stem: string
  providerPath: string
  maxBytes: number
  signal: AbortSignal
  fetch?: typeof fetch
}): Promise<string> {
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(options.url, { signal: options.signal })
  } catch {
    // The URL embeds the bot token; never let a transport error carry it.
    throw new Error('attachment download was rejected')
  }
  if (!response.ok || response.body === null) throw new Error('attachment download was rejected')

  mkdirSync(options.inbox, { recursive: true, mode: 0o700 })
  const safeStem = options.stem.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 96)
  const target = resolve(
    options.inbox,
    `${safeStem}-${Date.now()}-${++downloadSequence}${safeExtension(options.providerPath)}`,
  )
  if (!target.startsWith(`${resolve(options.inbox)}${sep}`)) throw new Error('attachment path escapes inbox')

  const temporary = `${target}.tmp`
  const reader = response.body.getReader()
  let descriptor: number | undefined
  let total = 0
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > options.maxBytes) throw new AttachmentTooLargeError('attachment download exceeds its byte limit')
      writeSync(descriptor, chunk.value)
    }
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, target)
    return target
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    if (descriptor !== undefined)
      try {
        closeSync(descriptor)
      } catch {
        /* cleanup is best-effort */
      }
    try {
      unlinkSync(temporary)
    } catch {
      /* absent or already renamed */
    }
  }
}

function safeExtension(filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  return /^\.[a-z0-9]{1,16}$/u.test(extension) ? extension : '.bin'
}
