#!/usr/bin/env bun
import { StandaloneTelegram, serveStandaloneTelegram, serveStandaloneTelegramOwnerProxy } from './standalone-telegram'

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const ownerSocket = env.CODEX_TELEGRAM_OWNER_SOCKET
  if (ownerSocket !== undefined) {
    if (env.CODEX_TELEGRAM_OWNER_CONFIG !== env.CODEX_TELEGRAM_CONFIG) throw new Error('Telegram owner proxy config does not match this MCP child')
    await serveStandaloneTelegramOwnerProxy(ownerSocket)
    return
  }
  await serveStandaloneTelegram(new StandaloneTelegram(env))
}

if (import.meta.main) void main().catch(() => { process.stderr.write('telegram MCP: standalone channel failed\n'); process.exitCode = 1 })
