import { renameSync, writeFileSync } from 'node:fs'

export const TELEGRAM_POLL_STALE_MS = 45_000
export type TelegramHealth = { lastSuccessfulPoll?: number; consecutiveErrors: number; totalErrors: number; consecutive409: number; lastError?: string; lastStatus?: number; policyFingerprint?: string; policyValid: boolean; running: boolean }
export class TelegramHealthFile {
  #value: TelegramHealth = { consecutiveErrors: 0, totalErrors: 0, consecutive409: 0, policyValid: false, running: true }
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}
  start(fingerprint: string): void { this.#value = { ...this.#value, policyFingerprint: fingerprint, policyValid: true, running: true }; this.#write() }
  success(fingerprint: string): void { this.#value = { ...this.#value, lastSuccessfulPoll: this.now(), consecutiveErrors: 0, consecutive409: 0, lastError: undefined, lastStatus: undefined, policyFingerprint: fingerprint, policyValid: true, running: true }; this.#write() }
  failure(error: unknown, fingerprint?: string): void { const message = error instanceof Error ? error.message : String(error); const status = /\b(400|401|403|409)\b/u.exec(message)?.[1]; const is409 = status === '409'; this.#value = { ...this.#value, totalErrors: this.#value.totalErrors + 1, consecutiveErrors: this.#value.consecutiveErrors + 1, consecutive409: is409 ? this.#value.consecutive409 + 1 : 0, lastError: message.slice(0, 256), ...(status === undefined ? {} : { lastStatus: Number(status) }), ...(fingerprint === undefined ? {} : { policyFingerprint: fingerprint, policyValid: true }), running: !is409 || this.#value.consecutive409 + 1 < 8 }; this.#write() }
  stale(): boolean { if (this.#value.lastSuccessfulPoll === undefined || this.#value.running === false || this.now() - this.#value.lastSuccessfulPoll <= TELEGRAM_POLL_STALE_MS) return false; this.#value = { ...this.#value, lastError: 'Telegram polling is stale', running: false }; this.#write(); return true }
  stop(): void { if (this.#value.running) { this.#value = { ...this.#value, running: false }; this.#write() } }
  invalidPolicy(error: unknown): void { this.#value = { ...this.#value, policyValid: false, lastError: String(error).slice(0, 256), running: true }; this.#write() }
  #write(): void { const temporary = `${this.path}.tmp`; writeFileSync(temporary, `${JSON.stringify(this.#value)}\n`, { mode: 0o600 }); renameSync(temporary, this.path) }
}
