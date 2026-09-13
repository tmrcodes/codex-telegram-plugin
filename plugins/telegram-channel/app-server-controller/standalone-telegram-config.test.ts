import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { readStandaloneTelegramConfig } from './standalone-telegram-config'

function privateFile(path: string, value: string): void { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600) }

test('shared standalone connection reader validates the existing complete private schema without runtime imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'standalone-config-')); const stateDir = join(root, 'state'); const token = join(root, 'token'); const policy = join(root, 'telegram.json'); const config = join(root, 'connection.json')
  try {
    mkdirSync(stateDir, { mode: 0o700 }); chmodSync(stateDir, 0o700); privateFile(token, 'synthetic-token'); privateFile(policy, '{}'); privateFile(config, JSON.stringify({ schemaVersion: 1, appServerSocket: join(root, 'host.sock'), policyFile: policy, botTokenFile: token, stateDir }))
    expect(readStandaloneTelegramConfig({ CODEX_TELEGRAM_CONFIG: config })).toEqual({ schemaVersion: 1, appServerSocket: join(root, 'host.sock'), policyFile: policy, botTokenFile: token, stateDir })
    privateFile(config, JSON.stringify({ schemaVersion: 1, policyFile: policy }))
    expect(() => readStandaloneTelegramConfig({ CODEX_TELEGRAM_CONFIG: config })).toThrow('appServerSocket is invalid')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
