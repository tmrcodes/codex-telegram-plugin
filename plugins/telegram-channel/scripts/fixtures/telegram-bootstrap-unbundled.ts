#!/usr/bin/env bun
// This small entrypoint is copied outside the plugin cache by one-time setup.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function installedLauncher(inventory: unknown, codexHome: string): string {
  const rows = (inventory as { installed?: Array<Record<string, unknown>> })?.installed
  const enabled = rows?.filter(row => row.pluginId === 'telegram-channel@codex-telegram' && row.installed === true && row.enabled === true) ?? []
  if (enabled.length !== 1 || typeof enabled[0]!.version !== 'string' || !/^[A-Za-z0-9._+-]+$/u.test(enabled[0]!.version)) throw new Error('Install and enable telegram-channel@codex-telegram in this Codex home first')
  return join(codexHome, 'plugins/cache/codex-telegram/telegram-channel', enabled[0]!.version, 'scripts/telegram-launcher.ts')
}

const RUNTIME_PACKAGES = ['grammy', '@modelcontextprotocol/sdk', 'zod']
export function ensureRuntimeDependencies(launcher: string): void {
  const root = dirname(dirname(launcher))
  if (RUNTIME_PACKAGES.every(name => existsSync(join(root, 'node_modules', name, 'package.json')))) return
  const install = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile', '--production'], { cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  if (install.exitCode !== 0 || !RUNTIME_PACKAGES.every(name => existsSync(join(root, 'node_modules', name, 'package.json')))) throw new Error('Could not install the plugin runtime dependencies from its frozen lockfile')
}

if (import.meta.main) {
  try {
    const [settings, ...args] = process.argv.slice(2)
    if (!settings) throw new Error('Missing one-time Telegram settings')
    const config = JSON.parse(readFileSync(settings, 'utf8'))
    if (typeof config.codexBinary !== 'string') throw new Error('Invalid stock Codex path')
    const listing = Bun.spawnSync([config.codexBinary, 'plugin', 'list', '--marketplace', 'codex-telegram', '--json'], { stdin: 'ignore', stderr: 'pipe' })
    if (listing.exitCode !== 0) throw new Error('Stock Codex could not list installed plugins')
    const path = installedLauncher(JSON.parse(listing.stdout.toString()), process.env.CODEX_HOME || join(homedir(), '.codex'))
    if (!statSync(path).isFile()) throw new Error('Installed plugin lacks the terminal launcher; update the plugin and rerun setup')
    ensureRuntimeDependencies(path)
    const child = Bun.spawn([process.execPath, path, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, CODEX_TELEGRAM_LAUNCHER_CONFIG: settings } })
    const forward = (signal: NodeJS.Signals) => { try { child.kill(signal) } catch {} }
    process.on('SIGINT', forward); process.on('SIGTERM', forward)
    process.exitCode = await child.exited
    process.off('SIGINT', forward); process.off('SIGTERM', forward)
  } catch (error) { process.stderr.write(`codex Telegram: ${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1 }
}
