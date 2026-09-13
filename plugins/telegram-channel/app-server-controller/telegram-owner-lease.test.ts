import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { acquireTelegramOwnerLeaseForTests, TelegramOwnerLeaseContentionError } from './telegram-owner-lease'

function privateDirectory(path: string): void { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700) }
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'telegram-owner-lease-'))
  const root = join(base, 'ownership'); const stateA = join(base, 'state-a'); const stateB = join(base, 'state-b')
  privateDirectory(root); privateDirectory(stateA); privateDirectory(stateB)
  return { base, root, stateA, stateB }
}
function acquire(bot: string, state: string, root: string) { return acquireTelegramOwnerLeaseForTests(bot, state, root) }
function expectContended(run: () => unknown): void { expect(run).toThrow(TelegramOwnerLeaseContentionError) }

async function waitForStatus(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) {
      const status = readFileSync(path, 'utf8')
      if (['acquired', 'contended', 'fatal'].includes(status)) return status
    }
    await Bun.sleep(10)
  }
  throw new Error('fixture child did not report within one second')
}
function child(root: string, bot: string, state: string, status: string, mode: 'hold' | 'gc-hold' | 'attempt') {
  return Bun.spawn([process.execPath, join(import.meta.dir, 'telegram-owner-lease.fixture.ts'), root, bot, state, status, mode], { stdout: 'ignore', stderr: 'ignore' })
}
async function stop(process: Bun.Subprocess): Promise<void> {
  if (process.exitCode === null) process.kill('SIGKILL')
  await process.exited
}
async function waitForCollections(path: string, minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path) && Number(readFileSync(path, 'utf8')) >= minimum) return
    await Bun.sleep(10)
  }
  throw new Error('fixture did not confirm forced garbage collection within one second')
}

test('one bot and one state directory have one owner, with explicit release only', async () => {
  const value = fixture(); let first: ReturnType<typeof acquire> | undefined
  try {
    first = acquire('900001', value.stateA, value.root)
    expectContended(() => acquire('900001', value.stateB, value.root))
    // Closing the losing connection must not release the original POSIX advisory lock.
    expectContended(() => acquire('900001', value.stateB, value.root))
    const status = join(value.base, 'after-loser.status'); const outsider = child(value.root, '900001', value.stateB, status, 'attempt')
    expect(await waitForStatus(status)).toBe('contended'); await outsider.exited
    first.release(); first.release(); first = undefined
    const newOwner = acquire('900001', value.stateB, value.root); newOwner.release()
  } finally { first?.release(); rmSync(value.base, { recursive: true, force: true }) }
})

test('bot and state leases reject crossed ownership while independent pairs succeed', () => {
  const value = fixture(); let first: ReturnType<typeof acquire> | undefined; let independent: ReturnType<typeof acquire> | undefined
  try {
    first = acquire('900001', value.stateA, value.root)
    expectContended(() => acquire('900002', value.stateA, value.root))
    expectContended(() => acquire('900001', value.stateB, value.root))
    independent = acquire('900002', value.stateB, value.root)
    independent.release(); independent = undefined; first.release(); first = undefined
  } finally { independent?.release(); first?.release(); rmSync(value.base, { recursive: true, force: true }) }
})

test('state contention releases the just-acquired bot lease across processes', async () => {
  const value = fixture(); let stateOwner: ReturnType<typeof acquire> | undefined
  try {
    stateOwner = acquire('900001', value.stateA, value.root)
    expectContended(() => acquire('900002', value.stateA, value.root))
    const status = join(value.base, 'state-conflict.status'); const contender = child(value.root, '900002', value.stateA, status, 'attempt')
    expect(await waitForStatus(status)).toBe('contended'); await contender.exited
    const releasedBot = acquire('900002', value.stateB, value.root)
    releasedBot.release(); stateOwner.release(); stateOwner = undefined
  } finally { stateOwner?.release(); rmSync(value.base, { recursive: true, force: true }) }
})

test('persistent lease databases contain no tables, rows, tokens, or session state', () => {
  const value = fixture(); const botFile = join(value.root, 'bot-900001.sqlite')
  try {
    const lease = acquire('900001', value.stateA, value.root); lease.release()
    const database = new Database(botFile, { readonly: true })
    expect(database.query("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([])
    database.close()
  } finally { rmSync(value.base, { recursive: true, force: true }) }
})

test('two processes racing an absent lock do not self-elect after one-shot contention', async () => {
  const value = fixture(); const firstStatus = join(value.base, 'first.status'); const secondStatus = join(value.base, 'second.status')
  const first = child(value.root, '900001', value.stateA, firstStatus, 'hold'); const second = child(value.root, '900001', value.stateB, secondStatus, 'hold')
  try {
    const [firstState, secondState] = await Promise.all([waitForStatus(firstStatus), waitForStatus(secondStatus)])
    // SQLite with busy_timeout=0 may report BUSY to both initial contenders. That
    // is an intentional safe availability loss: neither waits, retries, or elects.
    expect([firstState, secondState].every(state => state === 'acquired' || state === 'contended')).toBeTrue()
    expect([firstState, secondState].filter(state => state === 'acquired').length).toBeLessThanOrEqual(1)
    expect([firstState, secondState]).toContain('contended')
    if (firstState === 'contended') await first.exited
    if (secondState === 'contended') await second.exited
    await Bun.sleep(40)
    expect(readFileSync(firstStatus, 'utf8')).toBe(firstState)
    expect(readFileSync(secondStatus, 'utf8')).toBe(secondState)
    if (firstState === 'acquired') await stop(first)
    if (secondState === 'acquired') await stop(second)
    const newContender = acquire('900001', value.stateA, value.root); newContender.release()
  } finally { await stop(first); await stop(second); rmSync(value.base, { recursive: true, force: true }) }
})

test('SIGKILL releases SQLite lifetime locking without replacing the persistent inode', async () => {
  const value = fixture(); const status = join(value.base, 'owner.status'); const database = join(value.root, 'bot-900001.sqlite')
  const owner = child(value.root, '900001', value.stateA, status, 'hold')
  try {
    expect(await waitForStatus(status)).toBe('acquired')
    const inode = lstatSync(database).ino
    await stop(owner)
    const recovered = acquire('900001', value.stateA, value.root)
    expect(lstatSync(database).ino).toBe(inode)
    recovered.release()
  } finally { await stop(owner); rmSync(value.base, { recursive: true, force: true }) }
})

test('forced GC retains a live owner, then graceful release admits only a fresh contender', async () => {
  const value = fixture(); const status = join(value.base, 'gc-owner.status')
  const owner = child(value.root, '900001', value.stateA, status, 'gc-hold')
  const contenders: Bun.Subprocess[] = []; let recovered: ReturnType<typeof acquire> | undefined
  try {
    expect(await waitForStatus(status)).toBe('acquired')
    const inode = lstatSync(join(value.root, 'bot-900001.sqlite')).ino
    for (let round = 1; round <= 3; round++) {
      await waitForCollections(`${status}.gc`, round * 5)
      const probeStatus = join(value.base, `gc-contender-${round}.status`)
      const probe = child(value.root, '900001', value.stateB, probeStatus, 'attempt'); contenders.push(probe)
      expect(await waitForStatus(probeStatus)).toBe('contended')
      expect(await probe.exited).toBe(2)
    }
    owner.kill('SIGTERM')
    expect(await owner.exited).toBe(0)
    recovered = acquire('900001', value.stateB, value.root)
    expect(lstatSync(join(value.root, 'bot-900001.sqlite')).ino).toBe(inode)
    for (const probe of contenders) expect(probe.exitCode).toBe(2)
  } finally {
    recovered?.release()
    await stop(owner)
    for (const probe of contenders) await stop(probe)
    rmSync(value.base, { recursive: true, force: true })
  }
})

test('rejects unsafe ownership files and fatal SQLite failures without calling them contention', () => {
  const value = fixture(); const botFile = join(value.root, 'bot-900001.sqlite')
  try {
    writeFileSync(botFile, Buffer.alloc(4096, 0x7f), { mode: 0o600 }); chmodSync(botFile, 0o600)
    const corrupt = (() => { try { acquire('900001', value.stateA, value.root) } catch (error) { return error } })()
    expect(corrupt).toBeInstanceOf(Error); expect(corrupt).not.toBeInstanceOf(TelegramOwnerLeaseContentionError)
    rmSync(botFile)
    const wal = new Database(botFile, { create: true, readwrite: true }); wal.exec('PRAGMA journal_mode = WAL'); wal.close(); chmodSync(botFile, 0o600)
    expect(() => acquire('900001', value.stateA, value.root)).toThrow('journal mode is not DELETE')
    rmSync(botFile)
    writeFileSync(join(value.root, 'target'), '', { mode: 0o600 }); chmodSync(join(value.root, 'target'), 0o600); symlinkSync(join(value.root, 'target'), botFile)
    expect(() => acquire('900001', value.stateA, value.root)).toThrow('regular file')
    rmSync(botFile); rmSync(join(value.root, 'target'))
    writeFileSync(botFile, '', { mode: 0o600 }); chmodSync(botFile, 0o644)
    expect(() => acquire('900001', value.stateA, value.root)).toThrow('0600')
    rmSync(botFile); writeFileSync(botFile, '', { mode: 0o600 }); chmodSync(botFile, 0o600); linkSync(botFile, join(value.root, 'second-link'))
    expect(() => acquire('900001', value.stateA, value.root)).toThrow('hard links')
  } finally { rmSync(value.base, { recursive: true, force: true }) }
})

test('ancestor aliases resolve to one state-directory lease identity', () => {
  const value = fixture(); const alias = join(value.base, 'state-parent-alias'); let first: ReturnType<typeof acquire> | undefined
  try {
    symlinkSync(value.base, alias)
    first = acquire('900001', value.stateA, value.root)
    expectContended(() => acquire('900002', join(alias, 'state-a'), value.root))
  } finally { first?.release(); rmSync(value.base, { recursive: true, force: true }) }
})

test('requires private roots and validated positive bot IDs without exposing caller input', () => {
  const value = fixture()
  try {
    chmodSync(value.root, 0o755); expect(() => acquire('900001', value.stateA, value.root)).toThrow('0700'); chmodSync(value.root, 0o700)
    chmodSync(value.stateA, 0o755); expect(() => acquire('900001', value.stateA, value.root)).toThrow('0700'); chmodSync(value.stateA, 0o700)
    const stateLink = join(value.base, 'state-link'); symlinkSync(value.stateA, stateLink)
    expect(() => acquire('900001', stateLink, value.root)).toThrow('private directory')
    const supplied = 'not-a-credential-but-private-input'
    let error: Error | undefined
    try { acquire(supplied, value.stateA, value.root) } catch (caught) { error = caught as Error }
    expect(error?.message).not.toContain(supplied); expect(error?.message).toContain('positive decimal ID')
  } finally { rmSync(value.base, { recursive: true, force: true }) }
})
