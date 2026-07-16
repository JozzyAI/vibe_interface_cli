/**
 * Claude Code adapter — parses claude's stream-json stdout into log/tool_call/
 * pr_created events. Lifecycle status is owned by the supervisor.
 */
import { detectPrUrl } from '../../pr-detect.js'
import { execAgent, type EmitHelpers } from './exec.js'
import type { RunRecord } from '../../types.js'
import type { AgentAdapter, AgentAdapterContext, AgentOutcome } from '../types.js'

interface ClaudeStreamEvent {
  type: string
  subtype?: string
  session_id?: string
  /** Claude Code stream-json emits a terminal `type:"result"` message whose
   *  `result` field is the AUTHORITATIVE final assistant answer. */
  result?: string
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>
  }
}

function handleLine(line: string, emit: EmitHelpers): void {
  try {
    const msg = JSON.parse(line) as ClaudeStreamEvent
    if (msg.type === 'system' && msg.session_id) emit.setSession(msg.session_id)
    // Authoritative final output: the dedicated terminal `result` message (not the
    // concatenation of intermediate assistant text, and never the event log).
    if (msg.type === 'result' && typeof msg.result === 'string') emit.setFinal(msg.result)
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          emit.log('stdout', block.text)
          const prUrl = detectPrUrl(block.text)
          if (prUrl) emit.pr(prUrl)
        } else if (block.type === 'tool_use' && block.name) {
          emit.toolCall(block.name, block.input)
        }
      }
    }
  } catch {
    emit.log('stdout', line)
    const prUrl = detectPrUrl(line)
    if (prUrl) emit.pr(prUrl)
  }
}

export const claudeAdapter: AgentAdapter = {
  run(record: RunRecord, ctx: AgentAdapterContext): Promise<AgentOutcome> {
    return execAgent(record, ctx, {
      binary: 'claude',
      label: 'claude',
      buildArgs: (rec) => {
        const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']
        if (rec.permission_mode === 'unsafe-skip') args.push('--dangerously-skip-permissions')
        return args
      },
      onStdoutLine: handleLine,
      // Claude Code has a dedicated final-result message → explicit capture.
      finalOutputStrategy: 'explicit',
    })
  },
}
