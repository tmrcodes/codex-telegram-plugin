import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TELEGRAM_POLL_STALE_MS, TelegramHealthFile } from './telegram-health'

test('health resets transient failures on poll success and marks eight conflicts stopped', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tmr-health-')), 'telegram-health.json'); const health = new TelegramHealthFile(path)
  health.failure(new Error('401 unauthorized'), 'fingerprint'); health.success('fingerprint')
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ consecutiveErrors: 0, policyValid: true, running: true })
  for (let index = 0; index < 8; index++) health.failure(new Error('409 conflict'), 'fingerprint')
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ consecutive409: 8, lastStatus: 409, running: false })
})

test('health marks an active controller unhealthy after its last poll becomes stale', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tmr-health-')), 'telegram-health.json'); let now = 1_000; const health = new TelegramHealthFile(path, () => now)
  health.success('fingerprint'); now += TELEGRAM_POLL_STALE_MS + 1
  expect(health.stale()).toBeTrue()
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ lastSuccessfulPoll: 1_000, lastError: 'Telegram polling is stale', running: false })
})
