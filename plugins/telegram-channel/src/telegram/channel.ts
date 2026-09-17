import type { Origin } from '../app-server/transport'
import type { DeliveryMode } from '../policy/policy'
import { nowSeconds } from '../shared/guards'
import { type CallbackOutcome, type PolicyReader, TelegramAdapter } from './adapter'
import type { TelegramApi } from './bot-api'
import { HANDLE_TTL_SECONDS, HandleAuthority } from './handles'
import { chunkText } from './outbound'
import { renderDisplayPreview, renderModelInput } from './render'
import { CHANNEL_GUIDANCE, type ToolRequest, type ToolResult } from './tools'

export type Admit = (origin: Origin, deliveryMode: DeliveryMode) => Promise<void>
export type CallbackHandler = (query: Record<string, unknown>) => CallbackOutcome

export type TelegramChannelOptions = {
  api: TelegramApi
  policy: PolicyReader
  /** The thread that receives admitted messages. */
  threadId: string
  /** Signing namespace derived from the thread; a handle is valid only for the profile it names. */
  profile: string
  handleKey: string
  workspaceRoot: string
  inboxRoot: string
  admit: Admit
  onCallback?: CallbackHandler
  onHealth?: (ok: boolean, error?: unknown) => void
  initialOffset?: number
}

/** Telegram ingress and tool egress for one bound thread, with only caller-supplied authority and paths. */
export class TelegramChannel {
  readonly adapter: TelegramAdapter
  readonly #handles: HandleAuthority
  readonly #policy: PolicyReader
  readonly #tools = new Set<Promise<unknown>>()
  #threadId: string
  #profile: string
  #admit: Admit
  #onCallback: CallbackHandler | undefined

  constructor(options: TelegramChannelOptions) {
    this.#threadId = options.threadId
    this.#profile = options.profile
    this.#admit = options.admit
    this.#onCallback = options.onCallback
    this.#policy = options.policy
    this.#handles = new HandleAuthority(options.handleKey)
    this.adapter = new TelegramAdapter({
      api: options.api,
      policy: options.policy,
      fileRoots: [options.workspaceRoot, options.inboxRoot],
      inbox: options.inboxRoot,
      onCallback: query => this.#onCallback?.(query) ?? false,
      onHealth: options.onHealth,
      initialOffset: options.initialOffset,
      receive: async message => {
        const { deliveryMode } = this.#policy.read()
        await this.#admit(
          {
            id: message.id,
            threadId: this.#threadId,
            text: renderModelInput(message, this.#handles, this.#profile),
            displayText: renderDisplayPreview(message),
            guidance: CHANNEL_GUIDANCE,
            clientUserMessageId: message.id,
            localImagePaths: (message.attachments ?? []).flatMap(item =>
              item.localImagePath === undefined ? [] : [item.localImagePath],
            ),
          },
          deliveryMode,
        )
      },
    })
  }

  poll(): Promise<void> {
    return this.adapter.poll()
  }

  close(): void {
    this.adapter.close()
  }

  async closeAndDrain(): Promise<void> {
    await this.adapter.closeAndDrain()
    await this.#settleTools()
  }

  async pauseAndDrain(): Promise<void> {
    await this.adapter.pauseAndDrain()
    await this.#settleTools()
  }

  resume(): void {
    this.adapter.resume()
  }

  isQuiescent(): boolean {
    return this.adapter.isQuiescent() && this.#tools.size === 0
  }

  /** Moves a drained channel to another thread; handles of the previous thread stay verifiable. */
  rebind(threadId: string, profile: string, admit: Admit, onCallback?: CallbackHandler): void {
    if (!this.isQuiescent()) throw new Error('Telegram channel is not quiescent')
    this.#threadId = threadId
    this.#profile = profile
    this.#admit = admit
    this.#onCallback = onCallback
  }

  executeTool(request: ToolRequest): Promise<ToolResult> {
    return this.#track(this.#execute(request, this.#profile))
  }

  /** A tool call from a previously bound thread: authorized only by handles signed for that thread. */
  executeRetainedTool(profile: string, request: ToolRequest): Promise<ToolResult> {
    return this.#track(this.#execute(request, profile))
  }

  async #execute(request: ToolRequest, profile: string): Promise<ToolResult> {
    const expiresAt = nowSeconds() + HANDLE_TTL_SECONDS
    switch (request.tool) {
      case 'reply': {
        const policy = this.#policy.read()
        const target = this.#handles.verifyReply(request.arguments.reply_handle, profile, route =>
          this.adapter.allowsRoute(route),
        )
        const ids = await this.adapter.reply(target, request.arguments)
        const { text } = request.arguments
        const textParts =
          text === undefined || text === '' ? 0 : chunkText(text, policy.textChunkLimit, policy.chunkMode).length
        const { messageThreadId } = target
        return {
          message_ids: ids,
          message_handles: ids.map((messageId, index) =>
            this.#handles.signMessage({
              profile,
              direction: 'outbound',
              chatId: target.chatId,
              messageId,
              ...(messageThreadId === undefined ? {} : { messageThreadId }),
              kind: index < textParts ? 'text' : 'media',
              expiresAt,
            }),
          ),
        }
      }
      case 'react':
        await this.adapter.react(
          this.#handles.verifyMessage(request.arguments.target_handle, profile),
          request.arguments.emoji,
        )
        return {}
      case 'edit_message': {
        const target = this.#handles.verifyMessage(request.arguments.message_handle, profile, { outboundOnly: true })
        if (target.kind === 'media') throw new Error('media message handles cannot be edited')
        await this.adapter.edit(target, request.arguments.text, request.arguments.parse_mode)
        return {}
      }
      case 'download_attachment': {
        const attachment = this.#handles.verifyAttachment(request.arguments.attachment_handle, profile)
        return { path: await this.adapter.downloadAttachment(attachment, attachment.fileId, attachment.kind) }
      }
    }
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#tools.add(operation)
    const forget = () => {
      this.#tools.delete(operation)
    }
    void operation.then(forget, forget)
    return operation
  }

  async #settleTools(): Promise<void> {
    while (this.#tools.size > 0) await Promise.allSettled([...this.#tools])
  }
}
