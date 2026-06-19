/**
 * Mock adapter — emits the same log/approval events the old mock runner did
 * (lifecycle status is owned by the supervisor). For tests it honors
 * VIBE_MOCK_FAIL_REASON to deterministically simulate a recoverable failure so
 * the fallback path can be exercised without a real agent.
 */
import { appendEvent } from '../../events.js'
import type { RunRecord } from '../../types.js'
import type { AgentAdapter, AgentAdapterContext, AgentOutcome } from '../types.js'

const FAKE_LOGS = [
  'Cloning repository...',
  'Installing dependencies...',
  'Analyzing codebase...',
  'Running linter...',
  'Executing task...',
]

/** Map a VIBE_MOCK_FAIL_REASON token to representative failure text the classifier recognizes. */
const FAIL_TEXT: Record<string, string> = {
  session_limit: "You've hit your session limit",
  usage_limit: 'usage limit reached',
  quota_exceeded: 'quota exceeded',
  rate_limited: 'rate limit exceeded',
  context_limit: 'maximum context length exceeded',
  auth_expired: 'All credential paths are exhausted',
  tests_failed: '3 failing tests',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const mockAdapter: AgentAdapter = {
  async run(record: RunRecord, _ctx: AgentAdapterContext): Promise<AgentOutcome> {
    const run_id = record.run_id
    const session_id = record.session_id
    const ts = () => new Date().toISOString()

    const failReason = process.env.VIBE_MOCK_FAIL_REASON
    if (failReason) {
      const message = FAIL_TEXT[failReason] ?? failReason
      await sleep(100)
      appendEvent({ type: 'error', run_id, session_id, message, ts: ts() })
      return { result: 'failed', failureMessage: message, tailOutput: message }
    }

    for (const message of FAKE_LOGS) {
      await sleep(400)
      appendEvent({ type: 'log', run_id, session_id, stream: 'stdout', message, ts: ts() })
    }

    await sleep(1500)

    const approval_id = `appr_${Date.now().toString(36)}`
    appendEvent({ type: 'approval_required', run_id, session_id, approval_id, message: 'Proceed with modifying tracked files?', ts: ts() })

    await sleep(2000)

    return { result: 'completed' }
  },
}
