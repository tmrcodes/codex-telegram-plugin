import { createHmac, timingSafeEqual } from 'node:crypto'

export type CompactDirection = 'inbound' | 'outbound'

export function compactSignature(key: string, domain: string, body: string): string { return createHmac('sha256', key).update(`${domain}\u0000${body}`).digest('base64url') }
export function compactSignatureMatches(key: string, domain: string, body: string, provided: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(provided)) return false
  const expected = compactSignature(key, domain, body)
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}
export function compactDirection(value: string): CompactDirection | undefined { return value === 'i' ? 'inbound' : value === 'o' ? 'outbound' : undefined }
export function compactDirectionCode(value: CompactDirection): 'i' | 'o' { return value === 'inbound' ? 'i' : 'o' }
export function compactChat(value: string): string {
  if (!/^-?[1-9]\d{0,19}$/u.test(value)) throw new Error('compact chat ID is invalid')
  return `${value.startsWith('-') ? 'n' : 'p'}${BigInt(value.startsWith('-') ? value.slice(1) : value).toString(36)}`
}
export function expandCompactChat(value: string): string | undefined {
  if (!/^[np][0-9a-z]+$/u.test(value)) return undefined
  const numeric = expandBase36(value.slice(1), 99_999_999_999_999_999_999n)
  return numeric === undefined || numeric === 0n ? undefined : `${value[0] === 'n' ? '-' : ''}${numeric}`
}
export function compactPositive(value: number): string { if (!Number.isSafeInteger(value) || value < 1) throw new Error('compact number is invalid'); return value.toString(36) }
export function expandCompactPositive(value: string): number | undefined { const numeric = /^[0-9a-z]+$/u.test(value) ? expandBase36(value, BigInt(Number.MAX_SAFE_INTEGER)) : undefined; return numeric === undefined || numeric === 0n ? undefined : Number(numeric) }
function expandBase36(value: string, maximum: bigint): bigint | undefined { let result = 0n; for (const character of value) { const code = character.charCodeAt(0); const digit = code >= 48 && code <= 57 ? BigInt(code - 48) : code >= 97 && code <= 122 ? BigInt(code - 87) : undefined; if (digit === undefined || digit >= 36n) return undefined; result = result * 36n + digit; if (result > maximum) return undefined } return result }
