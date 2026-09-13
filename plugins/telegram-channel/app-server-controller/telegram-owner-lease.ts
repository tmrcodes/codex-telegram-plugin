import { Database } from 'bun:sqlite'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { createHash } from 'node:crypto'

/** A caller must obtain this ID from a successful Telegram getMe response. */
export type VerifiedTelegramBotUserId = string

export type TelegramOwnerLease = {
  release(): void
}

export class TelegramOwnerLeaseContentionError extends Error {
  constructor() {
    super('Telegram polling ownership is already held')
    this.name = 'TelegramOwnerLeaseContentionError'
  }
}

const privateMode = 0o700
const fileMode = 0o600

function fail(message: string): never { throw new Error(`Telegram owner lease: ${message}`) }

function ownPrivateDirectory(path: string) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ownership directory is not a private directory')
  if (stat.uid !== process.getuid?.()) fail('ownership directory is not owned by this OS user')
  if ((stat.mode & 0o777) !== privateMode) fail('ownership directory does not have mode 0700')
  return stat
}

function createPrivateDirectory(path: string): void {
  try { mkdirSync(path, { mode: privateMode }) } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  ownPrivateDirectory(path)
}

function stableOwnershipRoot(privateRootForTests: string | undefined): string {
  if (privateRootForTests !== undefined) {
    if (!isAbsolute(privateRootForTests) || normalize(privateRootForTests) !== privateRootForTests) fail('test ownership root must be an absolute normalized path')
    ownPrivateDirectory(privateRootForTests)
    return privateRootForTests
  }
  const home = userInfo().homedir
  if (!isAbsolute(home) || normalize(home) !== home) fail('OS user home is not an absolute normalized path')
  const parent = join(home, '.codex-telegram-channel')
  createPrivateDirectory(parent)
  const root = join(parent, 'ownership')
  createPrivateDirectory(root)
  return root
}

function verifiedBotUserId(value: VerifiedTelegramBotUserId): string {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) fail('verified bot user ID must be a positive decimal ID')
  return value
}

function privateStateDirectory(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value) fail('state directory must be an absolute normalized path')
  const stat = ownPrivateDirectory(value)
  // Device/inode identifies the validated directory despite case or ancestor
  // aliases on a case-insensitive filesystem. No state path is persisted.
  return `${stat.dev}:${stat.ino}`
}

function createLockFile(path: string): void {
  try {
    const descriptor = openSync(path, 'wx', fileMode)
    closeSync(descriptor)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('ownership lock is not a regular file')
  if (stat.uid !== process.getuid?.()) fail('ownership lock is not owned by this OS user')
  if ((stat.mode & 0o777) !== fileMode) fail('ownership lock does not have mode 0600')
  if (stat.nlink !== 1) fail('ownership lock must not have hard links')
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED'
}

function closeDatabase(database: Database | undefined): void {
  if (database === undefined) return
  database.close()
}

function journalMode(database: Database): string {
  const row = database.query('PRAGMA journal_mode').get() as Record<string, unknown> | null
  const value = row === null ? undefined : Object.values(row)[0]
  if (typeof value !== 'string') fail('could not verify SQLite journal mode')
  return value.toLowerCase()
}

function acquireFileLease(path: string): Database {
  // The only separate file descriptor is the exclusive create above. Opening and
  // closing a second descriptor for an existing SQLite inode can drop POSIX locks.
  createLockFile(path)
  let database: Database | undefined
  try {
    database = new Database(path, { create: false, readwrite: true })
    database.exec('PRAGMA busy_timeout = 0')
    database.exec('BEGIN EXCLUSIVE')
    if (journalMode(database) !== 'delete') fail('SQLite journal mode is not DELETE')
    // Force SQLite to read the existing database before accepting its lock.
    database.query('SELECT count(*) AS lock_file_check FROM sqlite_schema').get()
    return database
  } catch (error) {
    try { closeDatabase(database) } catch { /* Preserve the acquisition result. */ }
    if (isBusy(error)) throw new TelegramOwnerLeaseContentionError()
    throw error
  }
}

function releaseDatabases(databases: Database[]): void {
  let firstError: unknown
  for (const database of databases.reverse()) {
    try { database.exec('ROLLBACK') } catch (error) { firstError ??= error }
    try { database.close() } catch (error) { firstError ??= error }
  }
  if (firstError !== undefined) throw firstError
}

/**
 * Acquires two non-waiting lifetime leases in a fixed order: bot identity, then
 * state directory. It deliberately stores no token, session, PID, or queue data.
 */
function acquire(botUserId: VerifiedTelegramBotUserId, stateDir: string, privateRootForTests: string | undefined): TelegramOwnerLease {
  const root = stableOwnershipRoot(privateRootForTests)
  const bot = verifiedBotUserId(botUserId)
  const state = privateStateDirectory(stateDir)
  const botPath = join(root, `bot-${bot}.sqlite`)
  const statePath = join(root, `state-${createHash('sha256').update(state).digest('hex')}.sqlite`)
  const databases: Database[] = []
  try {
    databases.push(acquireFileLease(botPath))
    databases.push(acquireFileLease(statePath))
  } catch (error) {
    try { releaseDatabases(databases) } catch { /* Acquisition error remains authoritative. */ }
    throw error
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      releaseDatabases(databases)
    },
  }
}

/** Production entry point. Its root is fixed to the real OS user's home. */
export function acquireTelegramOwnerLease(botUserId: VerifiedTelegramBotUserId, stateDir: string): TelegramOwnerLease {
  return acquire(botUserId, stateDir, undefined)
}

/** Test-only entry point; no runtime configuration or environment can override the root. */
export function acquireTelegramOwnerLeaseForTests(botUserId: VerifiedTelegramBotUserId, stateDir: string, privateRootForTests: string): TelegramOwnerLease {
  return acquire(botUserId, stateDir, privateRootForTests)
}
