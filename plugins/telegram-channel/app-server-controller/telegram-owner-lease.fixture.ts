import { writeFileSync } from 'node:fs'
import { acquireTelegramOwnerLeaseForTests, TelegramOwnerLeaseContentionError } from './telegram-owner-lease'

const [root, botUserId, stateDir, statusPath, mode] = process.argv.slice(2)
if ([root, botUserId, stateDir, statusPath, mode].some(value => value === undefined)) throw new Error('fixture arguments are required')
if (!['hold', 'gc-hold', 'attempt'].includes(mode!)) throw new Error('fixture mode is invalid')

try {
  const lease = acquireTelegramOwnerLeaseForTests(botUserId!, stateDir!, root!)
  if (mode === 'hold' || mode === 'gc-hold') {
    let collections = 0
    const timer = setInterval(() => {
      if (mode === 'gc-hold') {
        Bun.gc(true)
        writeFileSync(`${statusPath}.gc`, String(++collections), { mode: 0o600 })
      }
    }, 10)
    // The registered listener strongly retains lease (and its DB closures).
    // An empty timer alone would not prove lifetime ownership under GC.
    process.once('SIGTERM', () => {
      clearInterval(timer)
      try { lease.release(); process.exitCode = 0 } catch { process.exitCode = 4 }
    })
  } else lease.release()
  writeFileSync(statusPath!, 'acquired', { mode: 0o600 })
} catch (error) {
  if (error instanceof TelegramOwnerLeaseContentionError) {
    writeFileSync(statusPath!, 'contended', { mode: 0o600 })
    process.exitCode = 2
  } else {
    writeFileSync(statusPath!, 'fatal', { mode: 0o600 })
    process.exitCode = 3
  }
}
