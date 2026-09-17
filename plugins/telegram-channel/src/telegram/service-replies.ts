import type { TelegramPolicy } from '../policy/policy'
import { nowSeconds } from '../shared/guards'

/**
 * Deterministic bot answers that never reach the model: `/start`, `/help`, `/status`
 * and the pairing prompt. None of them can grant access.
 */
export type ServiceCommand = { name: 'start' | 'help' | 'status'; addressedTo?: string }

export function parseServiceCommand(text: string): ServiceCommand | undefined {
  const match = /^\/(start|help|status)(?:@([A-Za-z0-9_]+))?(?:\s|$)/u.exec(text)
  if (match === null) return undefined
  return { name: match[1] as ServiceCommand['name'], ...(match[2] === undefined ? {} : { addressedTo: match[2] }) }
}

function localPairingInstructions(code: string): string {
  return `In your local Codex composer:\n$telegram-channel:access pair ${code}\n\nTerminal alternative:\ncodex telegram pair ${code}`
}

function isOperator(policy: TelegramPolicy, senderId: string): boolean {
  return policy.permissions.enabled && policy.permissions.operatorDmChatIds.has(senderId)
}

export function statusReply(policy: TelegramPolicy, senderId: string): string {
  if (policy.allowFrom.has(senderId)) {
    return `Paired as ${senderId}. Tool approval operator: ${isOperator(policy, senderId) ? 'enabled' : 'not enabled'}.`
  }
  const pending = policy.pending.find(item => item.senderId === senderId && item.expiresAt > nowSeconds())
  if (pending === undefined) return 'Not paired. Send a message to receive your pairing code.'
  return `Pairing pending. ${localPairingInstructions(pending.code)}`
}

export function helpReply(policy: TelegramPolicy, senderId: string): string {
  const header =
    'Telegram for Codex\nText and small media reach the connected Codex session.\n/start — setup\n/help — this guide\n/status — your access\n\n'
  if (policy.allowFrom.has(senderId)) {
    return (
      header +
      (isOperator(policy, senderId)
        ? 'You are paired and can approve tool requests: approval cards arrive in this chat. Send a message to start.'
        : 'You are paired for chat access only; this account cannot approve tools. Send a message to start.')
    )
  }
  const ownerFirst = policy.permissions.bootstrapFirstPairAsOperator
    ? 'Pair your own private DM first. The first successful pairing becomes the sole tool approval operator; later pairings grant chat access only.\n\n'
    : ''
  return `${header}${ownerFirst}Send a message to get a pairing code. ${localPairingInstructions('CODE')}\nAfter everyone is paired, in Codex:\n$telegram-channel:access policy allowlist`
}

export function pairingPrompt(code: string): string {
  return `Pairing required. ${localPairingInstructions(code)}\n\nThis code expires in one hour. Your first message was not forwarded.`
}
