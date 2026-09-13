import { join } from 'node:path'

export function installedLauncher(inventory: unknown, codexHome: string): string {
  const rows = (inventory as { installed?: Array<Record<string, unknown>> })?.installed
  const enabled = rows?.filter(row => row.pluginId === 'telegram-channel@codex-telegram' && row.installed === true && row.enabled === true) ?? []
  if (enabled.length !== 1 || typeof enabled[0]!.version !== 'string' || !/^[A-Za-z0-9._+-]+$/u.test(enabled[0]!.version)) throw new Error('Install and enable telegram-channel@codex-telegram in this Codex home first')
  return join(codexHome, 'plugins/cache/codex-telegram/telegram-channel', enabled[0]!.version, 'dist/scripts/telegram-launcher.js')
}
