#!/usr/bin/env bun
import { launcherSettingsPath, readLauncherSettings } from '../setup/profile'
import {
  hasControlCharacters,
  isBotToken,
  isRecord,
  isTelegramId,
  isTelegramUserId,
  type JsonObject,
  nowSeconds,
} from '../shared/guards'
import { pathExists, readPrivateText } from '../shared/private-fs'
import { TelegramBotApi } from '../telegram/bot-api'
import {
  CHUNK_MODES,
  DELIVERY_MODES,
  DM_POLICIES,
  REPLY_TO_MODES,
  type TelegramPolicy,
  TelegramPolicySource,
} from './policy'

/**
 * Local access management: `$telegram-channel:access ...` in Codex or `codex telegram ...` in a
 * terminal. It edits the profile's policy file, which the running channel re-reads on every
 * message, and never starts a host or a poller. Nothing sent through Telegram can reach it.
 */
const USAGE = {
  policy: 'policy requires pairing | allowlist | disabled',
  pair: 'pair requires the six-character code shown in the DM',
  deny: 'deny requires one pairing code',
  user: (command: string) => `${command} requires one Telegram user ID`,
  operator: 'operator requires list | add USER_ID | remove USER_ID (private user IDs only)',
  set: 'set requires a field and a value',
  group: 'group requires add|set CHAT_ID --allow-from ID,ID [--require-mention true|false], or rm CHAT_ID',
}

export function accessCommand(
  source: TelegramPolicySource,
  command: string | undefined,
  values: readonly string[],
  now = nowSeconds(),
): JsonObject {
  const policy = source.read()
  const pending = policy.pending.filter(item => item.expiresAt > now)
  const [first, second] = values

  switch (command) {
    case undefined:
    case 'status':
      if (values.length > 0) throw new Error('status takes no arguments')
      return { policy: displayPolicy(policy, pending) }

    case 'policy':
      if (values.length === 0) return { policy: displayPolicy(policy, pending) }
      if (values.length !== 1 || !(DM_POLICIES as readonly string[]).includes(first!)) throw new Error(USAGE.policy)
      source.update(draft => {
        draft.dmPolicy = first
      })
      return { policySet: first! }

    case 'pair': {
      if (values.length !== 1) throw new Error(USAGE.pair)
      const match = pending.find(item => item.code === first && item.senderId !== undefined)
      if (match === undefined) throw new Error('Telegram pairing code is unknown, expired, or unbound')
      const senderId = match.senderId!
      let approvalOperator = false
      source.update(draft => {
        draft.allowFrom = [...new Set([...stringArray(draft.allowFrom), senderId])]
        draft.pending = pending.filter(item => item !== match)
        const permissions = cloneRecord(draft.permissions)
        // One-shot owner bootstrap of a fresh profile: the first paired private account approves tools.
        if (permissions.bootstrapFirstPairAsOperator === true) {
          if (!isTelegramUserId(senderId)) throw new Error('Owner bootstrap requires a private Telegram user ID')
          permissions.enabled = true
          permissions.operatorDmChatIds = [senderId]
          delete permissions.bootstrapFirstPairAsOperator
          approvalOperator = true
        }
        draft.permissions = permissions
      })
      return { paired: senderId, ...(approvalOperator ? { approvalOperator: true } : {}) }
    }

    case 'deny':
      if (values.length !== 1) throw new Error(USAGE.deny)
      source.update(draft => {
        draft.pending = pending.filter(item => item.code !== first)
      })
      return { denied: first! }

    case 'allow':
      if (values.length !== 1 || !isTelegramId(first)) throw new Error(USAGE.user(command))
      source.update(draft => {
        draft.allowFrom = [...new Set([...stringArray(draft.allowFrom), first])]
      })
      return { allow: first }

    case 'remove':
      if (values.length !== 1 || !isTelegramId(first)) throw new Error(USAGE.user(command))
      // Removing a user revokes everything that user held: chat, group memberships and approvals.
      source.update(draft => {
        draft.allowFrom = stringArray(draft.allowFrom).filter(id => id !== first)
        const permissions = cloneRecord(draft.permissions)
        permissions.operatorDmChatIds = stringArray(permissions.operatorDmChatIds).filter(id => id !== first)
        draft.permissions = permissions
        const groups = cloneRecord(draft.groups)
        for (const [chatId, group] of Object.entries(groups)) {
          const entry = cloneRecord(group)
          entry.allowFrom = stringArray(entry.allowFrom).filter(id => id !== first)
          groups[chatId] = entry
        }
        draft.groups = groups
      })
      return { remove: first }

    case 'operator': {
      if (values.length === 1 && first === 'list')
        return { operators: [...policy.permissions.operatorDmChatIds], enabled: policy.permissions.enabled }
      if (values.length !== 2 || (first !== 'add' && first !== 'remove') || !isTelegramUserId(second))
        throw new Error(USAGE.operator)
      if (first === 'add' && !policy.allowFrom.has(second))
        throw new Error('Pair or allow this user before granting approval authority')
      source.update(draft => {
        const permissions = cloneRecord(draft.permissions)
        const operators = stringArray(permissions.operatorDmChatIds)
        permissions.operatorDmChatIds =
          first === 'add' ? [...new Set([...operators, second])] : operators.filter(id => id !== second)
        // Managing operators explicitly means the owner bootstrap is no longer wanted.
        delete permissions.bootstrapFirstPairAsOperator
        draft.permissions = permissions
      })
      return { operator: second, action: first }
    }

    case 'set': {
      if (values.length !== 2) throw new Error(USAGE.set)
      const operators = [...policy.permissions.operatorDmChatIds]
      if (
        first === 'permissions.enabled' &&
        second === 'true' &&
        (operators.length === 0 || operators.some(id => !isTelegramUserId(id)))
      ) {
        throw new Error('Add a private operator first with: codex telegram operator add USER_ID')
      }
      source.update(draft => applySetting(draft, first!, second!))
      return { set: first! }
    }

    case 'group': {
      const [action, chatId, ...flags] = values
      if (action === 'rm') {
        if (values.length !== 2 || !isTelegramId(chatId)) throw new Error(USAGE.group)
        source.update(draft => {
          const groups = cloneRecord(draft.groups)
          delete groups[chatId]
          draft.groups = groups
        })
        return { groupRemoved: chatId }
      }
      if ((action !== 'add' && action !== 'set') || !isTelegramId(chatId)) throw new Error(USAGE.group)
      const rule = groupRule(flags)
      source.update(draft => {
        const groups = cloneRecord(draft.groups)
        groups[chatId] = rule
        draft.groups = groups
      })
      return { group: chatId }
    }

    default:
      throw new Error('unknown access command')
  }
}

function applySetting(draft: JsonObject, field: string, value: string): void {
  const flag = value === 'true' || value === 'false' ? value === 'true' : undefined
  if (field === 'mentionPatterns') {
    // Shape, limits and regex compilation are validated by the policy parser before anything is written.
    try {
      draft.mentionPatterns = JSON.parse(value) as unknown
    } catch {
      throw new Error('set mentionPatterns requires a JSON array of regex source strings')
    }
  } else if (field === 'dmPolicy' && (DM_POLICIES as readonly string[]).includes(value)) draft.dmPolicy = value
  else if (field === 'allowAllGroups' && flag !== undefined) draft.allowAllGroups = flag
  else if (field === 'typing' && flag !== undefined) draft.typing = flag
  else if (field === 'ackReaction' && Array.from(value).length <= 16 && !hasControlCharacters(value))
    draft.ackReaction = value
  else if (field === 'replyToMode' && (REPLY_TO_MODES as readonly string[]).includes(value)) draft.replyToMode = value
  else if (field === 'textChunkLimit' && /^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 4096)
    draft.textChunkLimit = Number(value)
  else if (field === 'chunkMode' && (CHUNK_MODES as readonly string[]).includes(value)) draft.chunkMode = value
  else if (field === 'deliveryMode' && (DELIVERY_MODES as readonly string[]).includes(value)) draft.deliveryMode = value
  else if (field === 'permissions.enabled' && flag !== undefined) {
    const permissions = cloneRecord(draft.permissions)
    permissions.enabled = flag
    delete permissions.bootstrapFirstPairAsOperator
    draft.permissions = permissions
  } else throw new Error('set field or value is invalid')
}

/** `--allow-from ""` is a valid rule that admits nobody; omitting the flag is an error. */
function groupRule(flags: readonly string[]): { allowFrom: string[]; requireMention: boolean } {
  let allowFrom: string[] | undefined
  let requireMention = true
  const seen = new Set<string>()
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index]!
    const value = flags[index + 1]
    if (value === undefined || seen.has(key)) throw new Error(USAGE.group)
    seen.add(key)
    if (key === '--allow-from') {
      allowFrom = value === '' ? [] : value.split(',')
      if (allowFrom.some(id => !isTelegramId(id))) throw new Error(USAGE.group)
    } else if (key === '--require-mention' && (value === 'true' || value === 'false')) requireMention = value === 'true'
    else throw new Error(USAGE.group)
  }
  if (allowFrom === undefined) throw new Error(USAGE.group)
  return { allowFrom: [...new Set(allowFrom)], requireMention }
}

function displayPolicy(policy: TelegramPolicy, pending: TelegramPolicy['pending']): JsonObject {
  const { fingerprint: _fingerprint, ...rest } = policy
  return {
    ...rest,
    allowFrom: [...policy.allowFrom],
    groups: Object.fromEntries(
      [...policy.groups].map(([chatId, group]) => [
        chatId,
        { allowFrom: [...group.allowFrom], requireMention: group.requireMention },
      ]),
    ),
    mentionPatterns: [...policy.mentionPatterns],
    permissions: { ...policy.permissions, operatorDmChatIds: [...policy.permissions.operatorDmChatIds] },
    pending,
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : []
}

function cloneRecord(value: unknown): JsonObject {
  if (!isRecord(value)) throw new Error('Telegram policy has an invalid shape')
  return structuredClone(value)
}

/** One best-effort confirmation to the newly paired account; never a poller or a retry queue. */
export async function notifyPairing(
  senderId: string,
  source: TelegramPolicySource,
  botTokenFile: string,
  send: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const policy = source.read()
    if (!isTelegramUserId(senderId) || !policy.allowFrom.has(senderId) || !pathExists(botTokenFile)) return false
    const token = readPrivateText(botTokenFile, 'Telegram token')
    if (!isBotToken(token)) return false
    const { enabled, operatorDmChatIds } = policy.permissions
    const text =
      enabled && operatorDmChatIds.has(senderId)
        ? `Paired with Codex${operatorDmChatIds.size === 1 ? ' as the sole tool approval operator' : ' with tool approval authority'}. Approval cards are enabled for this private DM. Send a fresh message to start; /status shows your access.`
        : 'Paired with Codex for chat access only. This account cannot approve tools. Send a fresh message to start; /status shows your access.'
    await new TelegramBotApi(token, { fetch: send }).sendMessage(senderId, text)
    return true
  } catch {
    return false
  }
}

export async function runAccessCli(argv: readonly string[], env: Record<string, string | undefined>): Promise<void> {
  try {
    const settings = readLauncherSettings(launcherSettingsPath(env))
    const source = new TelegramPolicySource(settings.policyFile)
    const result = accessCommand(source, argv[0], argv.slice(1))
    if (typeof result.paired === 'string') {
      result.confirmationSent = await notifyPairing(result.paired, source, settings.botTokenFile)
      if (!result.confirmationSent)
        result.warning =
          'Access was granted, but the Telegram confirmation could not be sent. Ask the user to send /status; do not pair again.'
      result.next = `${
        result.approvalOperator === true
          ? 'This fresh profile enabled approval cards for the first paired private DM only.'
          : 'This pairing grants chat access only.'
      } After everyone is paired, enter locally: $telegram-channel:access policy allowlist (terminal equivalent: codex telegram policy allowlist)`
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`telegram-access: ${error instanceof Error ? error.message : 'policy operation failed'}\n`)
    process.exitCode = 1
  }
}

if (import.meta.main) await runAccessCli(process.argv.slice(2), process.env)
