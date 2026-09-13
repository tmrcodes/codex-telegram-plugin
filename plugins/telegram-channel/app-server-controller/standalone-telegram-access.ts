#!/usr/bin/env bun
import { TelegramPolicySource } from '../telegram-policy'
import { readStandaloneTelegramConfig } from './standalone-telegram-config'

export function standaloneTelegramAccess(command: string | undefined, values: readonly string[], env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const source = new TelegramPolicySource(readStandaloneTelegramConfig(env).policyFile)
  const policy = source.read(); const retained = policy.pending.filter(item => item.expiresAt > now)
  if (command === 'status' || command === 'policy') return { policy: displayPolicy(policy, retained) }
  if (command === 'pair') {
    if (values.length !== 1) throw new Error('telegram-access pair requires the six-character code shown in the DM')
    const match = retained.find(item => item.code === values[0] && item.senderId !== undefined && item.expiresAt >= now)
    if (match === undefined) throw new Error('Telegram pairing code is unknown, expired, or unbound')
    source.update(draft => { const allowFrom = ids(draft.allowFrom); if (!allowFrom.includes(match.senderId!)) allowFrom.push(match.senderId!); draft.allowFrom = allowFrom; draft.pending = retained.filter(item => item !== match) })
    return { paired: match.senderId }
  }
  if (command === 'deny') {
    if (values.length !== 1) throw new Error('telegram-access deny requires one pairing code')
    source.update(draft => { draft.pending = retained.filter(item => item.code !== values[0]) }); return { denied: values[0] }
  }
  if (command === 'allow' || command === 'remove') {
    if (values.length !== 1 || !telegramId(values[0]!)) throw new Error(`telegram-access ${command} requires one Telegram user id`)
    source.update(draft => { const allowFrom = ids(draft.allowFrom); draft.allowFrom = command === 'allow' ? (allowFrom.includes(values[0]!) ? allowFrom : [...allowFrom, values[0]!]) : allowFrom.filter(value => value !== values[0]) })
    return { [command]: values[0]! }
  }
  if (command === 'set') {
    if (values.length !== 2) throw new Error('telegram-access set requires field and value')
    const [field, value] = values
    source.update(draft => { const permissions = object(draft.permissions); if (field === 'dmPolicy' && ['pairing', 'allowlist', 'disabled'].includes(value!)) draft.dmPolicy = value; else if (field === 'allowAllGroups' && ['true', 'false'].includes(value!)) draft.allowAllGroups = value === 'true'; else if (field === 'typing' && ['true', 'false'].includes(value!)) draft.typing = value === 'true'; else if (field === 'ackReaction' && Array.from(value!).length <= 16 && !/[\u0000-\u001f\u007f]/u.test(value!)) draft.ackReaction = value; else if (field === 'replyToMode' && ['off', 'first', 'all'].includes(value!)) draft.replyToMode = value; else if (field === 'textChunkLimit' && /^\d+$/u.test(value!) && Number(value) >= 1 && Number(value) <= 4096) draft.textChunkLimit = Number(value); else if (field === 'chunkMode' && ['length', 'newline'].includes(value!)) draft.chunkMode = value; else if (field === 'deliveryMode' && ['steer', 'queue', 'auto'].includes(value!)) draft.deliveryMode = value; else if (field === 'permissions.enabled' && ['true', 'false'].includes(value!)) { permissions.enabled = value === 'true'; draft.permissions = permissions } else throw new Error('telegram-access set value is invalid') })
    return { set: field! }
  }
  if (command === 'group') {
    if (values.length === 0 || !['add', 'rm', 'set'].includes(values[0]!)) throw new Error('telegram-access group requires add|rm|set')
    const [action, ...rest] = values
    if (action === 'rm') { if (rest.length !== 1 || !telegramId(rest[0]!)) throw new Error('telegram-access group rm requires chat id'); source.update(draft => { const groups = object(draft.groups); delete groups[rest[0]!]; draft.groups = groups }); return { groupRemoved: rest[0]! } }
    if (rest.length < 2 || !telegramId(rest[0]!) || !['true', 'false'].includes(rest[1]!) || rest.slice(2).some(value => !telegramId(value))) throw new Error('telegram-access group add/set requires chat id requireMention and optional sender ids')
    source.update(draft => { const groups = object(draft.groups); groups[rest[0]!] = { allowFrom: [...new Set(rest.slice(2))], requireMention: rest[1] === 'true' }; draft.groups = groups }); return { group: rest[0]! }
  }
  throw new Error('unknown telegram-access command')
}

export function main(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): void {
  try { process.stdout.write(`${JSON.stringify(standaloneTelegramAccess(argv[0], argv.slice(1), env))}\n`) }
  catch (error) { process.stderr.write(`telegram-access: ${error instanceof Error ? error.message : 'policy operation failed'}\n`); process.exitCode = 1 }
}
if (import.meta.main) main()

function displayPolicy(policy: ReturnType<TelegramPolicySource['read']>, pending: readonly { code: string; expiresAt: number; senderId?: string; reminded?: boolean }[]): Record<string, unknown> { return { schemaVersion: policy.schemaVersion, dmPolicy: policy.dmPolicy, allowFrom: [...policy.allowFrom], groups: Object.fromEntries([...policy.groups].map(([chatId, group]) => [chatId, { allowFrom: [...group.allowFrom], requireMention: group.requireMention }])), allowAllGroups: policy.allowAllGroups, mentionPatterns: [...policy.mentionPatterns], ackReaction: policy.ackReaction, typing: policy.typing, replyToMode: policy.replyToMode, textChunkLimit: policy.textChunkLimit, chunkMode: policy.chunkMode, deliveryMode: policy.deliveryMode, permissions: { enabled: policy.permissions.enabled, operatorDmChatIds: [...policy.permissions.operatorDmChatIds] }, pending } }
function ids(value: unknown): string[] { return Array.isArray(value) ? value as string[] : [] }
function object(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Telegram policy has an invalid shape'); return structuredClone(value) as Record<string, unknown> }
function telegramId(value: string): boolean { return /^-?[1-9]\d{0,19}$/u.test(value) }
