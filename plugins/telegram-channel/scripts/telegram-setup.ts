#!/usr/bin/env bun
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTelegramPolicy } from '../telegram-policy'
import { privateDirectory, privateFile, readPrivateJson } from '../app-server-controller/standalone-telegram-config'
import { installedLauncher } from './telegram-installed'

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
export function activation(bun: string, bootstrap: string, settings: string, codexHome: string): string {
  return `# Opt-in terminal function; the installed stock binary remains unchanged.\ncodex() { CODEX_HOME=${quote(codexHome)} ${quote(bun)} ${quote(bootstrap)} ${quote(settings)} "$@"; }\n`
}

type LauncherSettings = { codexBinary: string; botTokenFile: string; policyFile: string; stateDir: string; codexHome?: string }
type RefreshOptions = { bootstrapSource?: string; bunBinary?: string; codexHome?: string; inventory?: (codexBinary: string) => unknown }

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`)
  return value
}

function launcherSettings(directory: string): { path: string; value: LauncherSettings; legacy: boolean } {
  privateDirectory(directory, 'Telegram setup directory')
  const path = join(directory, 'launcher.json')
  const raw = readPrivateJson(path, 'Telegram launcher settings')
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Telegram launcher settings have an invalid shape')
  const row = raw as Record<string, unknown>
  const keys = Object.keys(row).sort().join(',')
  const legacy = keys === 'botTokenFile,codexBinary,policyFile,stateDir'
  if (!legacy && keys !== 'botTokenFile,codexBinary,codexHome,policyFile,stateDir') throw new Error('Telegram launcher settings have an invalid shape')
  const value = {
    codexBinary: absolutePath(row.codexBinary, 'Stock Codex binary'),
    botTokenFile: absolutePath(row.botTokenFile, 'Telegram token file'),
    policyFile: absolutePath(row.policyFile, 'Telegram policy file'),
    stateDir: absolutePath(row.stateDir, 'Telegram state directory'),
    ...(legacy ? {} : { codexHome: absolutePath(row.codexHome, 'Codex home') }),
  }
  const binary = lstatSync(value.codexBinary)
  if (!binary.isFile() || binary.isSymbolicLink()) throw new Error('Stock Codex binary must be a regular file')
  accessSync(value.codexBinary, constants.X_OK)
  privateFile(value.botTokenFile, 'Telegram token')
  const token = readFileSync(value.botTokenFile, 'utf8').trim()
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/u.test(token)) throw new Error('Telegram token file does not contain a bot token')
  parseTelegramPolicy(readPrivateJson(value.policyFile, 'Telegram policy'))
  privateDirectory(value.stateDir, 'Telegram state directory')
  return { path, value, legacy }
}

function runtimeFile(path: string, label: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.size === 0 || stat.size > 1024 * 1024) throw new Error(`${label} must be an owned regular runtime file`)
}

function temporaryPath(target: string): string {
  return join(dirname(target), `.${target.slice(target.lastIndexOf('/') + 1)}.refresh-${process.pid}-${crypto.randomUUID()}`)
}

function stageReplacement(target: string, content: string | Uint8Array): string {
  const staged = temporaryPath(target)
  writeFileSync(staged, content, { mode: 0o600, flag: 'wx' })
  return staged
}

/** Refresh only the cache-following bootstrap and activation; retained credentials, policy and state are validation-only. */
export function refreshLauncher(directoryInput: string, options: RefreshOptions = {}): string {
  const directory = absolutePath(directoryInput, 'Settings directory')
  const settings = launcherSettings(directory)
  const requestedHome = options.codexHome === undefined ? undefined : absolutePath(options.codexHome, 'Codex home')
  if (settings.value.codexHome && requestedHome && settings.value.codexHome !== requestedHome) throw new Error('--codex-home does not match the Codex home retained by setup')
  if (!settings.value.codexHome && !requestedHome) throw new Error('Legacy launcher settings require an explicit --codex-home for one-time migration')
  const codexHome = settings.value.codexHome ?? requestedHome!
  const inventory = options.inventory?.(settings.value.codexBinary) ?? (() => {
    const listing = Bun.spawnSync([settings.value.codexBinary, 'plugin', 'list', '--marketplace', 'codex-telegram', '--json'], { stdin: 'ignore', stderr: 'pipe', env: { ...process.env, CODEX_HOME: codexHome } })
    if (listing.exitCode !== 0) throw new Error('Stock Codex could not list installed plugins')
    return JSON.parse(listing.stdout.toString()) as unknown
  })()
  const launcher = installedLauncher(inventory, codexHome)
  runtimeFile(launcher, 'Installed bundled terminal launcher')
  const source = options.bootstrapSource ?? join(dirname(fileURLToPath(import.meta.url)), 'telegram-bootstrap.js')
  runtimeFile(source, 'Installed bundled bootstrap')

  const candidates = [join(directory, 'bootstrap.js'), join(directory, 'bootstrap.ts')].filter(existsSync)
  if (candidates.length > 1) throw new Error('Settings directory contains ambiguous bootstrap files')
  const activate = join(directory, 'activate.sh')
  if (existsSync(activate)) privateFile(activate, 'Telegram activation')
  if (candidates.length === 0 && existsSync(activate)) throw new Error('Existing activation has no retained bootstrap to refresh')
  const bootstrap = candidates[0] ?? join(directory, 'bootstrap.js')
  if (existsSync(bootstrap)) privateFile(bootstrap, 'Telegram bootstrap')

  let stagedBootstrap: string | undefined, stagedActivate: string | undefined, stagedSettings: string | undefined
  try {
    stagedBootstrap = stageReplacement(bootstrap, readFileSync(source))
    stagedActivate = stageReplacement(activate, activation(options.bunBinary ?? process.execPath, bootstrap, settings.path, codexHome))
    if (settings.legacy) stagedSettings = stageReplacement(settings.path, JSON.stringify({ ...settings.value, codexHome }) + '\n')
    renameSync(stagedActivate, activate); stagedActivate = undefined
    // Installing the home-pinning activation first keeps a legacy bootstrap
    // usable if the process is interrupted between the two replacements.
    renameSync(stagedBootstrap, bootstrap); stagedBootstrap = undefined
    if (stagedSettings) { renameSync(stagedSettings, settings.path); stagedSettings = undefined }
  } finally {
    if (stagedBootstrap) try { unlinkSync(stagedBootstrap) } catch {}
    if (stagedActivate) try { unlinkSync(stagedActivate) } catch {}
    if (stagedSettings) try { unlinkSync(stagedSettings) } catch {}
  }
  return activate
}

export function setup(args: string[]): string {
  const options: Record<string, string> = {}
  const allowed = new Set(['--codex-binary', '--token-file', '--allow-from', '--policy-file', '--directory', '--codex-home'])
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1]
    if (!allowed.has(key) || value === undefined || Object.hasOwn(options, key)) throw new Error('Usage: telegram-setup.ts --codex-binary /path/to/stock/codex --token-file /private/token (--allow-from USER_ID | --policy-file /private/policy.json) [--directory /private/settings] [--codex-home /absolute/codex/home]')
    options[key] = value
  }
  if (!options['--codex-binary'] || !options['--token-file']) throw new Error('Provide the installed stock Codex binary and an existing private token file')
  if (Boolean(options['--allow-from']) === Boolean(options['--policy-file'])) throw new Error('Provide exactly one --allow-from or --policy-file')
  const codexBinary = realpathSync(resolve(options['--codex-binary']))
  const codexHome = absolutePath(options['--codex-home'] ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'Codex home')
  const listing = Bun.spawnSync([codexBinary, 'plugin', 'list', '--marketplace', 'codex-telegram', '--json'], { stdin: 'ignore', stderr: 'pipe', env: { ...process.env, CODEX_HOME: codexHome } })
  if (listing.exitCode !== 0) throw new Error('Stock Codex could not list installed plugins')
  const launcher = installedLauncher(JSON.parse(listing.stdout.toString()), codexHome)
  if (!existsSync(launcher)) throw new Error('Update the installed plugin to a version containing the bundled terminal launcher first')
  const sourceToken = resolve(options['--token-file']); privateFile(sourceToken, 'Telegram token')
  const token = readFileSync(sourceToken, 'utf8').trim()
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/u.test(token)) throw new Error('Telegram token file does not contain a bot token')
  let policy: unknown
  if (options['--policy-file']) {
    const sourcePolicy = resolve(options['--policy-file']); privateFile(sourcePolicy, 'Telegram policy'); policy = JSON.parse(readFileSync(sourcePolicy, 'utf8'))
  } else {
    if (!/^[1-9]\d{0,19}$/u.test(options['--allow-from']!)) throw new Error('--allow-from must be a numeric Telegram user ID')
    policy = { schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: [options['--allow-from']], groups: {}, allowAllGroups: false, mentionPatterns: [], ackReaction: '👀', typing: true, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'newline', deliveryMode: 'queue', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [] }
  }
  parseTelegramPolicy(policy)
  const directory = options['--directory'] ? resolve(options['--directory']) : join(codexHome, 'codex-telegram')
  if (!isAbsolute(directory)) throw new Error('Settings directory must be absolute')
  if (existsSync(directory)) throw new Error('Settings directory already exists; retained settings were not overwritten')
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); privateDirectory(directory, 'Telegram setup directory')
  const stateDir = join(directory, 'state'); mkdirSync(stateDir, { mode: 0o700 })
  const botTokenFile = join(directory, 'bot-token'), policyFile = join(directory, 'policy.json'), settings = join(directory, 'launcher.json')
  for (const [path, content] of [[botTokenFile, token + '\n'], [policyFile, JSON.stringify(policy) + '\n'], [settings, JSON.stringify({ codexBinary, botTokenFile, policyFile, stateDir, codexHome }) + '\n']]) writeFileSync(path!, content!, { mode: 0o600, flag: 'wx' })
  const bootstrap = join(directory, 'bootstrap.js')
  writeFileSync(bootstrap, readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'telegram-bootstrap.js')), { mode: 0o600, flag: 'wx' }); chmodSync(bootstrap, 0o600)
  const activate = join(directory, 'activate.sh')
  writeFileSync(activate, activation(process.execPath, bootstrap, settings, codexHome), { mode: 0o600, flag: 'wx' })
  return activate
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const refresh = args[0] === '--refresh-launcher'
    let activate: string
    if (refresh) {
      const refreshOptions: Record<string, string> = {}
      const allowed = new Set(['--directory', '--codex-home'])
      for (let i = 1; i < args.length; i += 2) {
        const key = args[i]!, value = args[i + 1]
        if (!allowed.has(key) || value === undefined || Object.hasOwn(refreshOptions, key)) throw new Error('Usage: telegram-setup.ts --refresh-launcher --directory /private/settings [--codex-home /absolute/codex/home]')
        refreshOptions[key] = value
      }
      if (!refreshOptions['--directory']) throw new Error('Usage: telegram-setup.ts --refresh-launcher --directory /private/settings [--codex-home /absolute/codex/home]')
      activate = refreshLauncher(refreshOptions['--directory'], { codexHome: refreshOptions['--codex-home'] })
    } else activate = setup(args)
    process.stdout.write(`${refresh ? 'Launcher refreshed; retained token, policy, state, and conversation were not changed.' : 'Settings saved.'} Activate this terminal with:\nsource ${quote(activate)}\n\nThen run codex as usual. Add that source line to your shell rc once to retain activation.\n`)
  }
  catch (error) { process.stderr.write(`telegram-setup: ${error instanceof Error ? error.message : 'setup failed'}\n`); process.exitCode = 1 }
}
