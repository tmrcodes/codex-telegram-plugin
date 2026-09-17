#!/usr/bin/env bun
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedLauncherPath, readPluginInventory } from '../launcher/bootstrap'
import { freshPolicy, parseTelegramPolicy, TelegramPolicySource } from '../policy/policy'
import { isBotToken, isRecord, type JsonObject, nowSeconds } from '../shared/guards'
import {
  pathExists,
  readPrivateJson,
  readPrivateText,
  requireAbsolutePath,
  writePrivateFileAtomic,
} from '../shared/private-fs'
import { TelegramApiError, TelegramBotApi } from '../telegram/bot-api'
import { installCommand, launchInstruction, requireOwnCommand } from './command'
import {
  codexHomeFrom,
  defaultProfileDirectory,
  type LauncherSettings,
  parseCommandShim,
  readLauncherSettings,
} from './profile'

/**
 * The helper behind `$telegram-channel:configure`: status, first-time setup, token rotation, clear
 * and launcher refresh. It validates a token with `getMe` only and never starts a host or a poller.
 * A token arrives on stdin or from a private file, never in argv.
 */
export type ConfigureRequest = {
  action: 'status' | 'clear' | 'configure' | 'refresh'
  token?: string
  tokenFile?: string
  directory?: string
  codexHome?: string
  codexBinary?: string
}

/** Seams for tests; production uses the defaults. */
export type ConfigureOptions = {
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  bootstrapSource?: string
  inventory?: (codexBinary: string, codexHome: string) => unknown
  replaceToken?: (path: string, token: string) => void
}

const REQUEST_KEYS = ['action', 'token', 'tokenFile', 'directory', 'codexHome', 'codexBinary']
const ACTIONS = ['status', 'clear', 'configure', 'refresh']
const PAIRING_GUIDE =
  'Pair your own private DM first: DM the bot, then enter $telegram-channel:access pair <exact code> locally. That first pairing becomes ' +
  'the sole tool approval operator; later pairings grant chat access only. After intended users are paired: $telegram-channel:access policy allowlist'

export async function configure(request: ConfigureRequest, options: ConfigureOptions = {}): Promise<JsonObject> {
  if (
    !isRecord(request) ||
    !ACTIONS.includes(request.action) ||
    Object.keys(request).some(key => !REQUEST_KEYS.includes(key)) ||
    Object.values(request).some(value => typeof value !== 'string')
  )
    throw new Error('Invalid configure request')
  if (
    request.action !== 'configure' &&
    (request.token !== undefined || request.tokenFile !== undefined || request.codexBinary !== undefined)
  ) {
    throw new Error('Only configure accepts a token or a binary')
  }
  const env = options.env ?? process.env
  const codexHome = requireAbsolutePath(request.codexHome ?? codexHomeFrom(env), 'Codex home')
  const directory = profileDirectory(request, env, codexHome)
  const settingsPath = join(directory, 'launcher.json')
  if (pathExists(directory) && !pathExists(settingsPath))
    throw new Error('Settings directory exists but is not a Telegram profile; nothing was changed')
  const settings = pathExists(directory) ? readLauncherSettings(settingsPath) : undefined
  if (settings !== undefined && settings.codexHome !== codexHome)
    throw new Error('Selected Codex home does not match this profile')
  const tokenPath = settings?.botTokenFile ?? join(directory, 'bot-token')
  const botId = settings === undefined ? undefined : retainedBotId(directory, tokenPath)

  switch (request.action) {
    case 'status':
      return {
        configured: settings !== undefined,
        tokenSet: pathExists(tokenPath),
        directory,
        codexHome,
        botId: botId ?? null,
        ...(settings === undefined ? {} : accessSummary(settings)),
        ...(settings === undefined ? {} : { polling: pollingSummary(settings.stateDir) }),
        next: pathExists(tokenPath)
          ? launchInstruction(codexHome, env)
          : '$telegram-channel:configure <complete BotFather token>',
      }

    case 'clear':
      if (pathExists(tokenPath)) unlinkSync(tokenPath)
      return {
        cleared: true,
        directory,
        retainedAccess: settings !== undefined,
        next:
          'Stop the channel-enabled session to discard its in-memory token; clearing the file does not stop a running bot. ' +
          'Configure the same bot again to restore this profile; use a separate Codex home for a different bot.',
      }

    case 'refresh': {
      if (settings === undefined) throw new Error('Nothing to refresh: configure this profile first')
      installLauncher(directory, settings, options)
      return { refreshed: true, directory, next: launchInstruction(codexHome, env) }
    }

    case 'configure': {
      if ((request.token === undefined) === (request.tokenFile === undefined))
        throw new Error('Provide exactly one complete token via stdin or one private token-file path')
      const token =
        request.tokenFile === undefined
          ? request.token!.trim()
          : readPrivateText(requireAbsolutePath(request.tokenFile, 'Token file'), 'Telegram token input')
      if (!isBotToken(token))
        throw new Error('Expected one complete BotFather token, without surrounding prose. No changes made')
      if (botId !== undefined && token.split(':')[0] !== botId) {
        throw new Error(
          'This token belongs to a different bot. Use a separate Codex home for it; existing access was not transferred',
        )
      }
      const bot = await verifyToken(token, options.fetch ?? fetch)
      if (settings === undefined) createProfile(directory, codexHome, token, request.codexBinary, env, options)
      else {
        if (
          request.codexBinary !== undefined &&
          realpathSync(requireAbsolutePath(request.codexBinary, 'Codex binary')) !== settings.codexBinary
        ) {
          throw new Error('Reconfigure cannot replace the stock binary of an existing profile')
        }
        // Also repairs a missing or outdated `codex` command before the credential changes.
        installLauncher(directory, settings, options)
        try {
          ;(options.replaceToken ?? ((path, value) => writePrivateFileAtomic(path, `${value}\n`)))(tokenPath, token)
        } catch {
          throw new Error(
            'Could not replace the private credential. Policy and launcher were not changed; inspect the retained credential before retrying',
          )
        }
      }
      return {
        configured: true,
        bot: `@${bot.username}`,
        botId: bot.id,
        directory,
        preservedAccess: settings !== undefined,
        next: `${launchInstruction(codexHome, env)}\n${settings === undefined ? PAIRING_GUIDE : 'Access settings of this profile were kept.'}`,
        // Only a token that travelled through the prompt can have ended up in the transcript.
        ...(request.token === undefined
          ? {}
          : {
              warning:
                'A token pasted into a Codex prompt may remain in the transcript and be sent to the model backend. This helper does not erase it.',
            }),
      }
    }
  }
}

function profileDirectory(
  request: ConfigureRequest,
  env: Record<string, string | undefined>,
  codexHome: string,
): string {
  if (request.directory !== undefined) return requireAbsolutePath(request.directory, 'Settings directory')
  const active = env.CODEX_TELEGRAM_LAUNCHER_CONFIG
  if (active === undefined) return defaultProfileDirectory(codexHome)
  const directory = dirname(requireAbsolutePath(active, 'Launcher settings'))
  if (active !== join(directory, 'launcher.json'))
    throw new Error('Expected a launcher.json profile; supply its settings directory explicitly')
  return directory
}

/** The bot this profile belongs to. It survives `clear`, so another bot can never inherit the access list. */
function retainedBotId(directory: string, tokenPath: string): string | undefined {
  const identityPath = join(directory, 'bot-identity.json')
  let stored: string | undefined
  if (pathExists(identityPath)) {
    const raw = readPrivateJson(identityPath, 'Telegram bot identity')
    if (
      !isRecord(raw) ||
      Object.keys(raw).length !== 1 ||
      typeof raw.botId !== 'string' ||
      !/^\d{5,}$/u.test(raw.botId)
    )
      throw new Error('Telegram bot identity file is invalid')
    stored = raw.botId
  }
  if (!pathExists(tokenPath)) return stored
  const token = readPrivateText(tokenPath, 'Telegram token')
  if (!isBotToken(token)) throw new Error('Telegram token file is malformed')
  const current = token.split(':')[0]!
  if (stored !== undefined && stored !== current) throw new Error('Bot identity and token disagree; no changes made')
  return current
}

function accessSummary(settings: LauncherSettings): JsonObject {
  const policy = new TelegramPolicySource(settings.policyFile).read()
  return {
    dmPolicy: policy.dmPolicy,
    allowedUsers: policy.allowFrom.size,
    pendingRequests: policy.pending.filter(item => item.expiresAt > nowSeconds()).length,
    allowAllGroups: policy.allowAllGroups,
    ownerApprovalBootstrapPending: policy.permissions.bootstrapFirstPairAsOperator,
    inbox: join(settings.stateDir, 'inbox'),
  }
}

/** Last state written by the poller. A crashed session can leave `running: true` behind, hence the age. */
function pollingSummary(stateDir: string): JsonObject | string {
  try {
    const health = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8')) as unknown
    if (!isRecord(health)) return 'unknown'
    const last = typeof health.lastSuccessfulPoll === 'number' ? health.lastSuccessfulPoll : undefined
    return {
      running: health.running === true,
      ...(last === undefined
        ? {}
        : { secondsSinceLastSuccessfulPoll: Math.max(0, Math.round((Date.now() - last) / 1000)) }),
      consecutiveErrors: health.consecutiveErrors ?? 0,
      ...(typeof health.lastError === 'string' ? { lastError: health.lastError } : {}),
    }
  } catch {
    return 'never started'
  }
}

async function verifyToken(token: string, send: typeof fetch): Promise<{ id: string; username: string }> {
  let identity
  try {
    identity = await new TelegramBotApi(token, { fetch: send }).getMe(AbortSignal.timeout(10_000))
  } catch (error) {
    const status = error instanceof TelegramApiError ? error.status : undefined
    if (status === undefined)
      throw new Error(
        'Could not reach Telegram to validate the token. Existing configuration is unchanged; retry when connected',
      )
    if (status === 401 || status === 404)
      throw new Error('Telegram rejected the token. Existing configuration is unchanged')
    throw new Error('Telegram validation is temporarily unavailable. Existing configuration is unchanged')
  }
  if (
    !isRecord(identity) ||
    identity.is_bot !== true ||
    !Number.isSafeInteger(identity.id) ||
    String(identity.id) !== token.split(':')[0] ||
    typeof identity.username !== 'string' ||
    !/^[A-Za-z0-9_]+$/u.test(identity.username)
  )
    throw new Error('Telegram returned an unexpected bot identity. No changes made')
  return { id: String(identity.id), username: identity.username }
}

/** First-time setup. Everything is staged in a sibling directory and appears with one rename. */
function createProfile(
  directory: string,
  codexHome: string,
  token: string,
  requestedBinary: string | undefined,
  env: Record<string, string | undefined>,
  options: ConfigureOptions,
): void {
  const codexBinary =
    requestedBinary === undefined
      ? findStockCodex(env.PATH)
      : realpathSync(requireAbsolutePath(requestedBinary, 'Codex binary'))
  if (codexBinary === undefined)
    throw new Error('Cannot locate stock Codex on PATH. Supply codexBinary as an absolute path')
  requireOwnCommand(codexHome)
  const settings: LauncherSettings = {
    codexBinary,
    botTokenFile: join(directory, 'bot-token'),
    policyFile: join(directory, 'policy.json'),
    stateDir: join(directory, 'state'),
    codexHome,
  }
  const policy = freshPolicy()
  parseTelegramPolicy(policy)
  // Nothing is created unless the `codex` command can be installed afterwards.
  requireInstalledLauncher(settings, options)
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
  const staged = mkdtempSync(join(dirname(directory), '.telegram-setup-'))
  try {
    chmodSync(staged, 0o700)
    mkdirSync(join(staged, 'state'), { mode: 0o700 })
    const files: Array<[string, string]> = [
      ['bot-token', `${token}\n`],
      ['policy.json', `${JSON.stringify(policy)}\n`],
      ['launcher.json', `${JSON.stringify(settings)}\n`],
      ['bot-identity.json', `${JSON.stringify({ botId: token.split(':')[0] })}\n`],
    ]
    for (const [name, content] of files) writeFileSync(join(staged, name), content, { mode: 0o600, flag: 'wx' })
    if (pathExists(directory)) throw new Error('Settings directory appeared during setup; nothing was overwritten')
    renameSync(staged, directory)
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
  writeLauncher(directory, settings, options)
}

/** The plugin must be installed and enabled in this Codex home before its `codex` command can work. */
function requireInstalledLauncher(settings: LauncherSettings, options: ConfigureOptions): void {
  const inventory =
    options.inventory?.(settings.codexBinary, settings.codexHome) ??
    readPluginInventory(settings.codexBinary, { ...process.env, CODEX_HOME: settings.codexHome })
  const launcher = installedLauncherPath(inventory, settings.codexHome)
  if (!existsSync(launcher)) throw new Error('The installed plugin has no launcher; update the plugin first')
}

function installLauncher(directory: string, settings: LauncherSettings, options: ConfigureOptions): void {
  requireInstalledLauncher(settings, options)
  writeLauncher(directory, settings, options)
}

/** Copies the bootstrap of the running plugin version into the profile and points `bin/codex` at it. */
function writeLauncher(directory: string, settings: LauncherSettings, options: ConfigureOptions): void {
  const source = options.bootstrapSource ?? join(dirname(fileURLToPath(import.meta.url)), '../launcher/bootstrap.ts')
  const bootstrap = join(directory, 'bootstrap.ts')
  writePrivateFileAtomic(bootstrap, readFileSync(source, 'utf8'))
  installCommand(settings.codexHome, process.execPath, bootstrap, join(directory, 'launcher.json'))
}

/** The first executable `codex` on PATH that is not this plugin's own command. */
export function findStockCodex(path: string | undefined): string | undefined {
  for (const directory of (path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'codex')
    try {
      accessSync(candidate, constants.X_OK)
      const real = realpathSync(candidate)
      const stat = statSync(real)
      if (!stat.isFile()) continue
      if (stat.size <= 32 * 1024 && parseCommandShim(readFileSync(real, 'utf8')) !== undefined) continue
      return real
    } catch {
      /* not here */
    }
  }
  return undefined
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    let request: ConfigureRequest | undefined
    if (args.length === 0) request = { action: 'status' }
    else if (args.length === 1 && (args[0] === 'clear' || args[0] === 'refresh')) request = { action: args[0] }
    else if (args.length === 1 && args[0] === '--stdin')
      request = JSON.parse(await Bun.stdin.text()) as ConfigureRequest
    if (request === undefined)
      throw new Error(
        'Use no arguments for status, `clear`, `refresh`, or `--stdin` with a JSON request; never put a token in argv',
      )
    process.stdout.write(`${JSON.stringify(await configure(request))}\n`)
  } catch (error) {
    const message =
      error instanceof Error && !(error instanceof SyntaxError) ? error.message : 'Invalid request; no changes made'
    process.stderr.write(`telegram-configure: ${message}\n`)
    process.exitCode = 1
  }
}
