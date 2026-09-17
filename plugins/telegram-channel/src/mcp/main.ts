#!/usr/bin/env bun
import { callOwnerBridge } from '../owner/bridge'
import { hasControlCharacters, isRecord } from '../shared/guards'
import {
  describeToolResult,
  MCP_INSTRUCTIONS,
  parseToolRequest,
  safeToolError,
  TOOL_SPECS,
  type ToolResult,
} from '../telegram/tools'
import { VERSION } from '../version'
import { McpStdioServer, type ToolCallResult } from './stdio-server'

/**
 * The MCP server Codex starts for each thread. It owns nothing: every tool call is forwarded to
 * the session owner inside the launcher. Outside a Telegram-enabled launch it exposes no tools.
 */
const NOT_ATTACHED =
  "Telegram is not attached to this session. Start Codex with this profile's `codex` command to use the Telegram channel."

export function createServer(ownerSocket: string | undefined, write: (line: string) => void): McpStdioServer {
  return new McpStdioServer(
    {
      name: 'telegram',
      version: VERSION,
      instructions: ownerSocket === undefined ? NOT_ATTACHED : MCP_INSTRUCTIONS,
      tools: ownerSocket === undefined ? [] : TOOL_SPECS,
      callTool: async (name, args, meta) => {
        try {
          if (ownerSocket === undefined) throw new Error(NOT_ATTACHED)
          const request = parseToolRequest(name, args)
          const result = await callOwnerBridge(ownerSocket, {
            operation: 'tool',
            threadId: threadIdFrom(meta),
            tool: request.tool,
            arguments: request.arguments,
          })
          return success(request.tool, describeToolResult(request, result as ToolResult), result)
        } catch (error) {
          return { content: [{ type: 'text', text: `telegram tool failed: ${safeToolError(error)}` }], isError: true }
        }
      },
    },
    write,
  )
}

function success(operation: string, text: string, result: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text }], structuredContent: { ...result, success: true, operation } }
}

/** The host names the calling thread in `_meta`; the owner checks it against the signed handle. */
function threadIdFrom(meta: unknown): string {
  const threadId = isRecord(meta) ? meta.threadId : undefined
  if (
    typeof threadId !== 'string' ||
    threadId === '' ||
    Array.from(threadId).length > 256 ||
    hasControlCharacters(threadId)
  ) {
    throw new Error('thread metadata is invalid')
  }
  return threadId
}

if (import.meta.main) {
  const server = createServer(process.env.CODEX_TELEGRAM_OWNER_SOCKET, line => process.stdout.write(line))
  let exiting = false
  const exit = () => {
    if (exiting) return
    exiting = true
    void server.idle().finally(() => process.exit(0))
  }
  process.stdin.on('data', (chunk: Buffer) => server.receive(chunk))
  process.stdin.once('end', exit)
  process.stdin.once('close', exit)
  process.once('SIGINT', exit)
  process.once('SIGTERM', exit)
}
