import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { commandShim, PLUGIN_ID, shimLauncherSettingsPath } from './profile'

/**
 * Installs the `codex` command of a Codex home: `<home>/bin/codex` wraps the stock binary with the
 * Telegram launcher. For the default home the directory is also put on the interactive PATH, so
 * plain `codex` starts Telegram from anywhere. A custom home never shadows the daily command.
 */
const PATH_MARKER = `# ${PLUGIN_ID}`
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

export function commandPath(codexHome: string): string {
  return join(codexHome, 'bin', 'codex')
}

function isDefaultHome(codexHome: string, homeDir: string): boolean {
  return codexHome === join(homeDir, '.codex')
}

/** Refuses to touch a `bin/codex` that is not our own shim. */
export function requireOwnCommand(codexHome: string): void {
  if (existsSync(commandPath(codexHome)) && shimLauncherSettingsPath(codexHome) === undefined) {
    throw new Error('Codex home bin/codex exists and is not the telegram-channel command')
  }
}

export function installCommand(codexHome: string, bun: string, bootstrap: string, settings: string): void {
  requireOwnCommand(codexHome)
  const bin = join(codexHome, 'bin')
  const path = commandPath(codexHome)
  // One `codex` command belongs to one profile: a second profile in the same home never retargets it.
  const current = shimLauncherSettingsPath(codexHome)
  if (current !== undefined && current !== settings) return
  if (existsSync(bin)) {
    const stat = lstatSync(bin)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new Error('Codex home bin must be an owned directory')
  } else mkdirSync(bin, { recursive: true, mode: 0o700 })
  chmodSync(bin, 0o700)
  const staged = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(staged, commandShim(bun, bootstrap, settings, codexHome), { mode: 0o700, flag: 'wx' })
    chmodSync(staged, 0o700)
    renameSync(staged, path)
  } finally {
    if (existsSync(staged)) unlinkSync(staged)
  }
  persistCommandPath(codexHome)
}

export function commandPathBlock(codexHome: string): string {
  const bin = shellQuote(join(codexHome, 'bin'))
  return `${PATH_MARKER}\n_codex_telegram_bin=${bin}\ncase ":$PATH:" in *:"$_codex_telegram_bin":*) ;; *) PATH="$_codex_telegram_bin:$PATH"; export PATH ;; esac\nunset _codex_telegram_bin\n`
}

function usableShellRc(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.size <= 1024 * 1024
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Appends the PATH block to the user's own `~/.zshrc` / `~/.bashrc` once. Default home only. */
export function persistCommandPath(codexHome: string, homeDir = homedir()): boolean {
  try {
    if (!isDefaultHome(codexHome, homeDir)) return false
    const candidates = [join(homeDir, '.zshrc'), join(homeDir, '.bashrc')]
    const existing = candidates.filter(usableShellRc)
    const targets = existing.length > 0 ? existing : [candidates[0]!]
    let persisted = false
    for (const path of targets) {
      if (existsSync(path)) {
        if (!usableShellRc(path)) continue
        const text = readFileSync(path, 'utf8')
        if (!text.includes(PATH_MARKER))
          writeFileSync(
            path,
            text === '' || text.endsWith('\n')
              ? text + commandPathBlock(codexHome)
              : `${text}\n${commandPathBlock(codexHome)}`,
          )
      } else writeFileSync(path, commandPathBlock(codexHome), { mode: 0o644, flag: 'wx' })
      persisted = true
    }
    return persisted
  } catch {
    return false
  }
}

/** What the user should type next; a custom home is named explicitly because `codex` would be the stock binary. */
export function launchInstruction(
  codexHome: string,
  env: Record<string, string | undefined> = process.env,
  homeDir = homedir(),
): string {
  if ((env.PATH ?? '').split(delimiter).includes(join(codexHome, 'bin')))
    return 'Quit this Codex session, then from any directory run:\ncodex'
  if (isDefaultHome(codexHome, homeDir))
    return 'Quit this Codex session, open a new terminal, then from any directory run:\ncodex'
  return `Quit this Codex session, then run this home's command:\n${commandPath(codexHome)}`
}
