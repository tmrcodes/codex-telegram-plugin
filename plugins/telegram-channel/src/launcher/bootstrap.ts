#!/usr/bin/env bun
// Configure copies this file into the private profile directory, outside the plugin cache, so the
// `codex` command keeps working when the plugin is updated to a new version directory.
// It must stay self-contained: no relative imports.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, normalize } from 'node:path'

const PLUGIN_ID = 'telegram-channel@codex-telegram'
const LAUNCHER = 'src/launcher/main.ts'

/** Path of the launcher inside whichever plugin version is installed and enabled in this Codex home. */
export function installedLauncherPath(inventory: unknown, codexHome: string): string {
  const rows = (inventory as { installed?: Array<Record<string, unknown>> } | null)?.installed
  const enabled = Array.isArray(rows)
    ? rows.filter(row => row.pluginId === PLUGIN_ID && row.installed === true && row.enabled === true)
    : []
  const version = enabled[0]?.version
  if (enabled.length !== 1 || typeof version !== 'string' || !/^[A-Za-z0-9._+-]+$/u.test(version)) {
    throw new Error(`Install and enable ${PLUGIN_ID} in this Codex home first`)
  }
  return join(codexHome, 'plugins/cache/codex-telegram/telegram-channel', version, LAUNCHER)
}

/** Asks the stock binary which plugin version is installed in this Codex home. */
export function readPluginInventory(codexBinary: string, env: NodeJS.ProcessEnv): unknown {
  const listing = Bun.spawnSync([codexBinary, 'plugin', 'list', '--marketplace', 'codex-telegram', '--json'], {
    stdin: 'ignore',
    stderr: 'pipe',
    env,
  })
  if (listing.exitCode !== 0) {
    // Typically the stock command cannot start at all, e.g. `env: node: No such file or directory`.
    const reason = listing.stderr
      .toString()
      .split('\n')
      .find(line => line.trim() !== '')
      ?.trim()
      .slice(0, 200)
    throw new Error(`Stock Codex could not list installed plugins${reason === undefined ? '' : `: ${reason}`}`)
  }
  return JSON.parse(listing.stdout.toString()) as unknown
}

/** The launcher and the MCP servers it starts need `bun` on PATH even when the shell has none. */
export function bootstrapEnvironment(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env,
  bunBinary = process.execPath,
): NodeJS.ProcessEnv {
  const current = env.PATH ?? ''
  const bunDirectory = dirname(bunBinary)
  const path = current.split(delimiter).includes(bunDirectory)
    ? current
    : [bunDirectory, current].filter(Boolean).join(delimiter)
  return { ...env, CODEX_HOME: codexHome, PATH: path }
}

if (import.meta.main) {
  try {
    const [settingsPath, ...args] = process.argv.slice(2)
    if (!settingsPath) throw new Error('Missing Telegram launcher settings')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { codexBinary?: unknown }
    if (typeof settings.codexBinary !== 'string') throw new Error('Invalid stock Codex path')
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    if (!isAbsolute(codexHome) || normalize(codexHome) !== codexHome) throw new Error('Invalid Codex home')
    const environment = bootstrapEnvironment(codexHome)
    const launcher = installedLauncherPath(readPluginInventory(settings.codexBinary, environment), codexHome)
    if (!statSync(launcher).isFile())
      throw new Error('Installed plugin has no launcher; update the plugin and run configure again')
    const child = Bun.spawn([process.execPath, launcher, ...args], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...environment, CODEX_TELEGRAM_LAUNCHER_CONFIG: settingsPath },
    })
    const forward = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal)
      } catch {
        /* the child has already exited */
      }
    }
    process.on('SIGINT', forward)
    process.on('SIGTERM', forward)
    process.exitCode = await child.exited
  } catch (error) {
    process.stderr.write(`codex Telegram: ${error instanceof Error ? error.message : 'startup failed'}\n`)
    process.exitCode = 1
  }
}
