export type JsonObject = Record<string, unknown>

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Telegram user, group and channel IDs as decimal strings; groups and channels are negative. */
const TELEGRAM_ID = /^-?[1-9]\d{0,19}$/u
const TELEGRAM_USER_ID = /^[1-9]\d{0,19}$/u
const BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/u
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/u

export function isTelegramId(value: unknown): value is string {
  return typeof value === 'string' && TELEGRAM_ID.test(value)
}

export function isTelegramUserId(value: unknown): value is string {
  return typeof value === 'string' && TELEGRAM_USER_ID.test(value)
}

export function isBotToken(value: unknown): value is string {
  return typeof value === 'string' && BOT_TOKEN.test(value)
}

export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value)
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Truncates by Unicode code points, never splitting a surrogate pair. */
export function truncate(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('')
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** Rejects with `<label> timed out` when the promise does not settle in time. */
export async function withDeadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function toError(value: unknown, fallback = 'operation failed'): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : fallback)
}
