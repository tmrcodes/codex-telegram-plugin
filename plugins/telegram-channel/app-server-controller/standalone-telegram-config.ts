import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'

export type StandaloneTelegramConfig = { schemaVersion: 1; appServerSocket: string; policyFile: string; botTokenFile: string; stateDir: string }

/** Private standalone connection configuration, intentionally independent of Telegram/App Server runtime imports. */
export function readStandaloneTelegramConfig(env: Record<string, string | undefined> = process.env): StandaloneTelegramConfig {
  const path = env.CODEX_TELEGRAM_CONFIG
  if (path === undefined || !absolute(path)) throw new Error('CODEX_TELEGRAM_CONFIG must name an absolute private connection config')
  const raw = readPrivateJson(path, 'Telegram connection config'); if (!record(raw) || raw.schemaVersion !== 1 || Object.keys(raw).some(key => !['schemaVersion', 'appServerSocket', 'policyFile', 'botTokenFile', 'stateDir'].includes(key))) throw new Error('Telegram connection config has an invalid shape')
  const config = { schemaVersion: 1 as const, appServerSocket: requiredAbsolute(raw.appServerSocket, 'appServerSocket'), policyFile: requiredAbsolute(raw.policyFile, 'policyFile'), botTokenFile: requiredAbsolute(raw.botTokenFile, 'botTokenFile'), stateDir: requiredAbsolute(raw.stateDir, 'stateDir') }
  privateFile(config.botTokenFile, 'Telegram bot token'); privateDirectory(config.stateDir, 'Telegram state directory')
  return config
}

export function readPrivateJson(path: string, label: string): unknown { privateFile(path, label); try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch { throw new Error(`${label} is malformed`) } }
export function privateFile(path: string, label: string): void { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) throw new Error(`${label} must be an owned 0600 regular file`) }
export function privateDirectory(path: string, label: string): void { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) throw new Error(`${label} must be an owned 0700 directory`) }

function requiredAbsolute(value: unknown, label: string): string { if (typeof value !== 'string' || !absolute(value)) throw new Error(`Telegram connection config ${label} is invalid`); return value }
function absolute(value: string): boolean { return isAbsolute(value) && normalize(value) === value && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value) }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
