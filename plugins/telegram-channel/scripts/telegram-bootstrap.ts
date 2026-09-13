#!/usr/bin/env bun
// This small entrypoint is copied outside the plugin cache by one-time setup.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, normalize } from 'node:path'
import { installedLauncher } from './telegram-installed'

export function bootstrapEnvironment(codexHome: string, env: NodeJS.ProcessEnv = process.env, bunBinary = process.execPath): NodeJS.ProcessEnv {
  const current = env.PATH ?? ''
  const bunDirectory = dirname(bunBinary)
  const path = current.split(delimiter).includes(bunDirectory) ? current : [bunDirectory, current].filter(Boolean).join(delimiter)
  return { ...env, CODEX_HOME: codexHome, PATH: path }
}

if (import.meta.main) {
  try {
    const [settings, ...args] = process.argv.slice(2)
    if (!settings) throw new Error('Missing one-time Telegram settings')
    const config = JSON.parse(readFileSync(settings, 'utf8'))
    if (typeof config.codexBinary !== 'string') throw new Error('Invalid stock Codex path')
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    if (!isAbsolute(codexHome) || normalize(codexHome) !== codexHome) throw new Error('Invalid Codex home')
    const environment = bootstrapEnvironment(codexHome)
    const listing = Bun.spawnSync([config.codexBinary, 'plugin', 'list', '--marketplace', 'codex-telegram', '--json'], { stdin: 'ignore', stderr: 'pipe', env: environment })
    if (listing.exitCode !== 0) throw new Error('Stock Codex could not list installed plugins')
    const path = installedLauncher(JSON.parse(listing.stdout.toString()), codexHome)
    if (!statSync(path).isFile()) throw new Error('Installed plugin lacks the bundled terminal launcher; update the plugin and rerun setup')
    const child = Bun.spawn([process.execPath, path, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { ...environment, CODEX_TELEGRAM_LAUNCHER_CONFIG: settings } })
    const forward = (signal: NodeJS.Signals) => { try { child.kill(signal) } catch {} }
    process.on('SIGINT', forward); process.on('SIGTERM', forward)
    process.exitCode = await child.exited
    process.off('SIGINT', forward); process.off('SIGTERM', forward)
  } catch (error) { process.stderr.write(`codex Telegram: ${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1 }
}
