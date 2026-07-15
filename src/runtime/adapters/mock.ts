/**
 * Mock adapter — emits the same log/approval events the old mock runner did
 * (lifecycle status is owned by the supervisor). For tests it honors
 * VIBE_MOCK_FAIL_REASON to deterministically simulate a recoverable failure so
 * the fallback path can be exercised without a real agent,
 * VIBE_MOCK_RUN_MS to control how long it takes to reach a terminal outcome
 * (for exercising "still running" / long-running behavior without a real agent),
 * and VIBE_MOCK_OUTPUT to emit an exact stdout payload (e.g. a structured JSON
 * result) as the ONLY output — used by the Workflow Runtime acceptance to drive a
 * deterministic, parseable agent output without a real agent.
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

/** Map a VIBE_MOCK_FAIL_REASON token to representative failure text the classifier recognizes,
 *  and the exit code a real process would plausibly have produced for it. */
const FAIL_TEXT: Record<string, { message: string; exitCode: number }> = {
  session_limit: { message: "You've hit your session limit", exitCode: 1 },
  usage_limit: { message: 'usage limit reached', exitCode: 1 },
  quota_exceeded: { message: 'quota exceeded', exitCode: 1 },
  rate_limited: { message: 'rate limit exceeded', exitCode: 1 },
  context_limit: { message: 'maximum context length exceeded', exitCode: 1 },
  auth_expired: { message: 'All credential paths are exhausted', exitCode: 1 },
  tests_failed: { message: '3 failing tests', exitCode: 1 },
  // Matches exec.ts's real spawn-ENOENT wording so the same classify.ts rule
  // recognizes both a real missing binary and this simulation. 127 is the
  // conventional shell "command not found" exit status.
  command_not_found: { message: 'mock CLI not found in PATH', exitCode: 127 },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Explicit override for the total time before a terminal outcome, in ms.
 *  Unset (the default) preserves the original fixed per-step timings exactly. */
function runMsOverride(): number | undefined {
  const raw = process.env.VIBE_MOCK_RUN_MS
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export const mockAdapter: AgentAdapter = {
  async run(record: RunRecord, _ctx: AgentAdapterContext): Promise<AgentOutcome> {
    const run_id = record.run_id
    const session_id = record.session_id
    const ts = () => new Date().toISOString()

    const failReason = process.env.VIBE_MOCK_FAIL_REASON
    if (failReason) {
      const fail = FAIL_TEXT[failReason] ?? { message: failReason, exitCode: 1 }
      await sleep(100)
      appendEvent({ type: 'error', run_id, session_id, message: fail.message, ts: ts() })
      return { result: 'failed', failureMessage: fail.message, tailOutput: fail.message, exitCode: fail.exitCode }
    }

    // VIBE_MOCK_OUTPUT set: emit exactly that text as the SOLE stdout output and
    // complete (no fixed logs, no approval). Lets a workflow acceptance drive a
    // deterministic, parseable structured result without a real agent.
    const mockOutput = process.env.VIBE_MOCK_OUTPUT
    if (mockOutput) {
      await sleep(50)
      appendEvent({ type: 'log', run_id, session_id, stream: 'stdout', message: mockOutput, ts: ts() })
      return { result: 'completed', exitCode: 0 }
    }

    // VIBE_MOCK_RUN_MS unset: byte-identical to the original fixed timings.
    // VIBE_MOCK_RUN_MS set: same event sequence, spread evenly over that
    // duration instead — lets a test exercise a long-running (or near-instant)
    // mock without waiting on the fixed ~4.4s default.
    const override = runMsOverride()
    const logStepMs = override !== undefined ? override / (FAKE_LOGS.length + 2) : 400
    const preApprovalMs = override !== undefined ? logStepMs : 1500
    const postApprovalMs = override !== undefined ? logStepMs : 2000

    for (const message of FAKE_LOGS) {
      await sleep(logStepMs)
      appendEvent({ type: 'log', run_id, session_id, stream: 'stdout', message, ts: ts() })
    }

    await sleep(preApprovalMs)

    const approval_id = `appr_${Date.now().toString(36)}`
    appendEvent({ type: 'approval_required', run_id, session_id, approval_id, message: 'Proceed with modifying tracked files?', ts: ts() })

    await sleep(postApprovalMs)

    return { result: 'completed', exitCode: 0 }
  },
}
