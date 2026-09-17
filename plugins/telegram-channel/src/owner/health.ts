import { renameSync, writeFileSync } from 'node:fs'

export type TelegramHealth = {
  running: boolean
  policyValid: boolean
  policyFingerprint?: string
  lastSuccessfulPoll?: number
  consecutiveErrors: number
  totalErrors: number
  consecutive409: number
  lastError?: string
  lastStatus?: number
}

const REPORTED_STATUSES = [400, 401, 403, 409]
/** Matches the adapter: this many polling conflicts in a row end the poller. */
const MAX_CONSECUTIVE_CONFLICTS = 8

/** Small private status file, rewritten atomically, that shows whether polling is alive. */
export class HealthFile {
  #value: TelegramHealth = {
    consecutiveErrors: 0,
    totalErrors: 0,
    consecutive409: 0,
    policyValid: false,
    running: true,
  }

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  start(fingerprint: string): void {
    this.#write({ policyFingerprint: fingerprint, policyValid: true, running: true })
  }

  success(fingerprint: string): void {
    this.#write({
      lastSuccessfulPoll: this.now(),
      consecutiveErrors: 0,
      consecutive409: 0,
      lastError: undefined,
      lastStatus: undefined,
      policyFingerprint: fingerprint,
      policyValid: true,
      running: true,
    })
  }

  /** `message` must already be safe to store: no token, URL or control characters. */
  failure(message: string, status?: number, fingerprint?: string): void {
    const conflict = status === 409
    const consecutive409 = conflict ? this.#value.consecutive409 + 1 : 0
    this.#write({
      totalErrors: this.#value.totalErrors + 1,
      consecutiveErrors: this.#value.consecutiveErrors + 1,
      consecutive409,
      lastError: message.slice(0, 256),
      ...(status !== undefined && REPORTED_STATUSES.includes(status) ? { lastStatus: status } : {}),
      ...(fingerprint === undefined ? {} : { policyFingerprint: fingerprint, policyValid: true }),
      running: consecutive409 < MAX_CONSECUTIVE_CONFLICTS,
    })
  }

  /** An unreadable policy counts as a failed poll; polling continues and recovers with the file. */
  invalidPolicy(message: string): void {
    this.#write({
      totalErrors: this.#value.totalErrors + 1,
      consecutiveErrors: this.#value.consecutiveErrors + 1,
      consecutive409: 0,
      lastError: message.slice(0, 256),
      policyValid: false,
      running: true,
    })
  }

  stop(): void {
    if (this.#value.running) this.#write({ running: false })
  }

  #write(change: Partial<TelegramHealth>): void {
    this.#value = { ...this.#value, ...change }
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.#value)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
