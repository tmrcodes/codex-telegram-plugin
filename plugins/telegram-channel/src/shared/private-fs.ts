import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import { hasControlCharacters } from './guards'

const MAX_PRIVATE_FILE_BYTES = 64 * 1024

/** An absolute, normalized, bounded path without control characters. */
export function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    normalize(value) === value &&
    value.length <= 1024 &&
    !hasControlCharacters(value)
  )
}

export function requireAbsolutePath(value: unknown, label: string): string {
  if (!isAbsolutePath(value)) throw new Error(`${label} must be a normalized absolute path`)
  return value
}

/** `existsSync` follows symlinks; a dangling symlink must not look like an absent file. */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function ownedByThisUser(uid: number): boolean {
  return uid === process.getuid?.()
}

/** Secrets and settings must be owned, regular, unlinked `0600` files. */
export function privateFile(path: string, label: string): void {
  const stat = lstatSync(path)
  const mode = stat.mode & 0o777
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !ownedByThisUser(stat.uid) ||
    mode !== 0o600 ||
    stat.size > MAX_PRIVATE_FILE_BYTES
  ) {
    throw new Error(`${label} must be an owned 0600 regular file`)
  }
}

export function privateDirectory(path: string, label: string): void {
  const stat = lstatSync(path)
  const mode = stat.mode & 0o777
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByThisUser(stat.uid) || mode !== 0o700) {
    throw new Error(`${label} must be an owned 0700 directory`)
  }
}

export function privateSocket(path: string, label: string): void {
  const stat = lstatSync(path)
  if (!stat.isSocket() || !ownedByThisUser(stat.uid) || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} is not private`)
  }
}

export function readPrivateJson(path: string, label: string): unknown {
  privateFile(path, label)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error(`${label} is malformed`)
  }
}

export function readPrivateText(path: string, label: string): string {
  privateFile(path, label)
  const value = readFileSync(path, 'utf8').trim()
  if (value === '') throw new Error(`${label} is invalid`)
  return value
}

/** Replaces a private file through an exclusive temporary file and an atomic rename. */
export function writePrivateFileAtomic(path: string, text: string): void {
  if (pathExists(path)) privateFile(path, 'Retained private file')
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
