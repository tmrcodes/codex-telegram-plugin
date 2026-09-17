import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isRecord } from '../shared/guards'
import { isAbsolutePath, pathExists, readPrivateJson } from '../shared/private-fs'

/**
 * A profile is one private settings directory: bot token, access policy, state and the
 * `launcher.json` that ties them to one stock Codex binary and one Codex home.
 */
export type LauncherSettings = {
  codexBinary: string
  botTokenFile: string
  policyFile: string
  stateDir: string
  codexHome: string
}

export const PLUGIN_ID = 'telegram-channel@codex-telegram'
export const PROFILE_DIRECTORY_NAME = 'codex-telegram'
const SETTINGS_KEYS: ReadonlyArray<keyof LauncherSettings> = [
  'botTokenFile',
  'codexBinary',
  'codexHome',
  'policyFile',
  'stateDir',
]
const SHIM_HEADER = `#!/bin/sh\n# ${PLUGIN_ID} command shim. The installed stock binary remains unchanged.\nexport CODEX_HOME=`

export function codexHomeFrom(env: Record<string, string | undefined>): string {
  return env.CODEX_HOME || join(homedir(), '.codex')
}

export function readLauncherSettings(path: string): LauncherSettings {
  const raw = readPrivateJson(path, 'Telegram launcher settings')
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== [...SETTINGS_KEYS].sort().join(','))
    throw new Error('Telegram launcher settings have an invalid shape')
  for (const key of SETTINGS_KEYS)
    if (!isAbsolutePath(raw[key])) throw new Error(`Telegram launcher settings ${key} is invalid`)
  return raw as LauncherSettings
}

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/** `<Codex home>/bin/codex`: runs the bootstrap for this profile; the stock binary stays untouched. */
export function commandShim(bun: string, bootstrap: string, settings: string, codexHome: string): string {
  return `${SHIM_HEADER}${shellQuote(codexHome)}\nexec ${shellQuote(bun)} ${shellQuote(bootstrap)} ${shellQuote(settings)} "$@"\n`
}

/** Strict inverse of `commandShim`; anything that is not exactly our shim is not ours. */
export function parseCommandShim(
  text: string,
): { bun: string; bootstrap: string; settings: string; codexHome: string } | undefined {
  if (!text.startsWith(SHIM_HEADER)) return undefined
  const rest = text.slice(SHIM_HEADER.length)
  const home = unquote(rest, 0)
  if (home === undefined || rest.slice(home.end, home.end + 6) !== '\nexec ') return undefined
  const bun = unquote(rest, home.end + 6)
  if (bun === undefined || rest[bun.end] !== ' ') return undefined
  const bootstrap = unquote(rest, bun.end + 1)
  if (bootstrap === undefined || rest[bootstrap.end] !== ' ') return undefined
  const settings = unquote(rest, bootstrap.end + 1)
  if (settings === undefined || rest.slice(settings.end) !== ' "$@"\n') return undefined
  return { bun: bun.value, bootstrap: bootstrap.value, settings: settings.value, codexHome: home.value }
}

function unquote(text: string, start: number): { value: string; end: number } | undefined {
  if (text[start] !== "'") return undefined
  let index = start + 1
  let value = ''
  while (index < text.length) {
    if (text.startsWith("'\\''", index)) {
      value += "'"
      index += 4
    } else if (text[index] === "'") return { value, end: index + 1 }
    else value += text[index++]
  }
  return undefined
}

/** The `launcher.json` this home's `codex` command points at, when that command is our shim. */
export function shimLauncherSettingsPath(codexHome: string): string | undefined {
  if (!isAbsolutePath(codexHome)) return undefined
  try {
    const path = join(codexHome, 'bin', 'codex')
    const stat = lstatSync(path)
    const ours =
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === 0o700 &&
      stat.size > 0 &&
      stat.size <= 32 * 1024
    if (!ours) return undefined
    const shim = parseCommandShim(readFileSync(path, 'utf8'))
    if (
      shim === undefined ||
      shim.codexHome !== codexHome ||
      !isAbsolutePath(shim.settings) ||
      !shim.settings.endsWith('/launcher.json')
    )
      return undefined
    return shim.settings
  } catch {
    return undefined
  }
}

/** The profile of this home's `codex` command, else `<Codex home>/codex-telegram`. */
export function defaultProfileDirectory(codexHome: string): string {
  const settings = shimLauncherSettingsPath(codexHome)
  return settings === undefined ? join(codexHome, PROFILE_DIRECTORY_NAME) : dirname(settings)
}

/** Resolution order: the running launch, then this home's `codex` command, then the default directory. */
export function launcherSettingsPath(env: Record<string, string | undefined>): string {
  const path = env.CODEX_TELEGRAM_LAUNCHER_CONFIG ?? join(defaultProfileDirectory(codexHomeFrom(env)), 'launcher.json')
  if (!isAbsolutePath(path) || !pathExists(path))
    throw new Error('Configure this profile first with $telegram-channel:configure')
  return path
}
