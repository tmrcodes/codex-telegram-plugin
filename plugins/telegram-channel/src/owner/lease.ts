import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

/**
 * One poller per bot and per state directory for this OS user.
 *
 * The lease is an exclusive SQLite transaction held for the life of the process: the kernel
 * releases it when the process dies, so there is no stale lock to clean up and no PID to trust.
 * It stores no token, session, PID or queue data.
 */
export type OwnerLease = { release(): void }

export class OwnerLeaseContentionError extends Error {
  constructor() {
    super('Telegram polling ownership is already held')
    this.name = 'OwnerLeaseContentionError'
  }
}

function fail(message: string): never {
  throw new Error(`Telegram owner lease: ${message}`)
}

function ownedPrivateDirectory(path: string) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ownership directory is not a private directory')
  if (stat.uid !== process.getuid?.()) fail('ownership directory is not owned by this OS user')
  if ((stat.mode & 0o777) !== 0o700) fail('ownership directory does not have mode 0700')
  return stat
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  ownedPrivateDirectory(path)
}

/** Fixed under the real OS user's home so that no environment variable can split the lock space. */
export function defaultOwnershipRoot(): string {
  const home = userInfo().homedir
  if (!isAbsolute(home) || normalize(home) !== home) fail('OS user home is not an absolute normalized path')
  const parent = join(home, '.codex-telegram-channel')
  ensurePrivateDirectory(parent)
  const root = join(parent, 'ownership')
  ensurePrivateDirectory(root)
  return root
}

function createLockFile(path: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('ownership lock is not a regular file')
  if (stat.uid !== process.getuid?.()) fail('ownership lock is not owned by this OS user')
  if ((stat.mode & 0o777) !== 0o600) fail('ownership lock does not have mode 0600')
  if (stat.nlink !== 1) fail('ownership lock must not have hard links')
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return error instanceof Error && (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
}

function acquireFileLease(path: string): Database {
  // The exclusive create above is the only other descriptor ever opened for this file:
  // opening and closing a second one for an existing SQLite inode can drop POSIX locks.
  createLockFile(path)
  let database: Database | undefined
  try {
    database = new Database(path, { create: false, readwrite: true })
    database.exec('PRAGMA busy_timeout = 0')
    database.exec('BEGIN EXCLUSIVE')
    const mode = database.query('PRAGMA journal_mode').get() as Record<string, unknown> | null
    const journal = mode === null ? undefined : Object.values(mode)[0]
    if (typeof journal !== 'string') fail('could not verify SQLite journal mode')
    if (journal.toLowerCase() !== 'delete') fail('SQLite journal mode is not DELETE')
    // Force SQLite to read the existing database before trusting its lock.
    database.query('SELECT count(*) AS lock_file_check FROM sqlite_schema').get()
    return database
  } catch (error) {
    try {
      database?.close()
    } catch {
      /* the acquisition error stays authoritative */
    }
    if (isBusy(error)) throw new OwnerLeaseContentionError()
    throw error
  }
}

function releaseAll(databases: Database[]): void {
  let firstError: unknown
  for (const database of databases.reverse()) {
    try {
      database.exec('ROLLBACK')
    } catch (error) {
      firstError ??= error
    }
    try {
      database.close()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== undefined) throw firstError
}

/**
 * Acquires two non-waiting lifetime leases in a fixed order: bot identity, then state directory.
 * `botUserId` must come from a successful `getMe`.
 */
export function acquireOwnerLease(
  botUserId: string,
  stateDir: string,
  ownershipRoot = defaultOwnershipRoot(),
): OwnerLease {
  if (!isAbsolute(ownershipRoot) || normalize(ownershipRoot) !== ownershipRoot)
    fail('ownership root must be an absolute normalized path')
  ownedPrivateDirectory(ownershipRoot)
  if (!/^[1-9][0-9]{0,18}$/u.test(botUserId)) fail('verified bot user ID must be a positive decimal ID')
  if (!isAbsolute(stateDir) || normalize(stateDir) !== stateDir)
    fail('state directory must be an absolute normalized path')
  // Device and inode identify the directory despite case or ancestor aliases on a
  // case-insensitive filesystem; no state path is persisted.
  const state = ownedPrivateDirectory(stateDir)
  const stateKey = createHash('sha256').update(`${state.dev}:${state.ino}`).digest('hex')

  const databases: Database[] = []
  try {
    databases.push(acquireFileLease(join(ownershipRoot, `bot-${botUserId}.sqlite`)))
    databases.push(acquireFileLease(join(ownershipRoot, `state-${stateKey}.sqlite`)))
  } catch (error) {
    try {
      releaseAll(databases)
    } catch {
      /* the acquisition error stays authoritative */
    }
    throw error
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      releaseAll(databases)
    },
  }
}
