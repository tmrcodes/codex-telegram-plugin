import { randomBytes } from 'node:crypto'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isPositiveInteger, isRecord } from '../shared/guards'
import { readPrivateJson } from '../shared/private-fs'

/**
 * The state-directory lock names the live owner of a profile and, once its bridge is up, how a
 * newer launch of the same profile can ask it for the channel. Mutual exclusion itself is the
 * kernel-held lease; this file is the rendezvous.
 */
export type HandoffOffer = { path: string; profile: string; botId: string }
export type OwnerLock = { nonce: string; publish(offer: HandoffOffer): void; release(): void }
export type LiveOwner = { nonce: string; offer: HandoffOffer | undefined }

const LABEL = 'Telegram owner lock'

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The owner recorded in the lock, or undefined when there is none or its process has exited. */
export function readLiveOwner(path: string, isAlive: (pid: number) => boolean = processAlive): LiveOwner | undefined {
  if (!existsSync(path)) return undefined
  const value = readPrivateJson(path, LABEL)
  if (!isRecord(value) || !isPositiveInteger(value.pid) || typeof value.nonce !== 'string')
    throw new Error(`${LABEL} is invalid`)
  if (!isAlive(value.pid)) return undefined
  const offer = value.handoff
  const valid =
    isRecord(offer) &&
    typeof offer.path === 'string' &&
    typeof offer.profile === 'string' &&
    typeof offer.botId === 'string'
  return {
    nonce: value.nonce,
    offer: valid
      ? { path: offer.path as string, profile: offer.profile as string, botId: offer.botId as string }
      : undefined,
  }
}

export function acquireOwnerLock(path: string, isAlive: (pid: number) => boolean = processAlive): OwnerLock {
  if (existsSync(path)) {
    if (readLiveOwner(path, isAlive) !== undefined) throw new Error('Telegram state already has a live owner')
    unlinkSync(path)
  }
  const nonce = randomBytes(16).toString('hex')
  writeFileSync(path, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' })
  const isOurs = () => {
    const value = readPrivateJson(path, LABEL)
    return isRecord(value) && value.pid === process.pid && value.nonce === nonce
  }
  return {
    nonce,
    publish(offer) {
      if (!isOurs()) throw new Error(`${LABEL} changed`)
      const temporary = `${path}.${nonce}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify({ pid: process.pid, nonce, handoff: offer }), {
          mode: 0o600,
          flag: 'wx',
        })
        renameSync(temporary, path)
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary)
      }
    },
    release() {
      try {
        if (isOurs()) unlinkSync(path)
      } catch {
        /* never remove a lock we cannot prove is ours */
      }
    },
  }
}
