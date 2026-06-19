/**
 * Run supervisor — the single detached entrypoint behind every backend.
 *
 * It owns the run lifecycle so a fallback agent can supersede a failed primary
 * under the SAME run_id: it emits exactly one `status:running` at the start and
 * exactly one terminal `status` at the end. In between it runs the primary
 * adapter, and on a recoverable failure that the policy opts into, writes a
 * handoff and runs the next fallback agent in the same workspace.
 *
 * Backward compatibility: with no `agent_policy` metadata, `resolveAgentPolicy`
 * yields no fallbacks, so this collapses to "run one agent, emit its outcome" —
 * byte-identical to the old per-agent runners.
 */
import fs from 'fs'
import path from 'path'
import { appendEvent } from '../events.js'
import { readRun, updateRun } from '../store.js'
import { vibeDir } from '../config.js'
import type { AgentBackend, RunRecord } from '../types.js'
import { classifyFailure } from './classify.js'
import { resolveAgentPolicy } from './policy.js'
import { writeHandoff, handoffPath } from './handoff.js'
import type { AgentAdapter, AgentAdapterContext, AgentOutcome, FailureReason } from './types.js'
import { mockAdapter } from './adapters/mock.js'
import { claudeAdapter } from './adapters/claude.js'
import { codexAdapter } from './adapters/codex.js'

const ADAPTERS: Record<AgentBackend, AgentAdapter | undefined> = {
  mock: mockAdapter,
  'claude-code': claudeAdapter,
  codex: codexAdapter,
  opencode: undefined,
}

/** Compose `handoff + --- + original prompt` to a deterministic file the fallback adapter reads. */
function buildFallbackPrompt(record: RunRecord, handoffFile: string): string {
  const handoffText = fs.existsSync(handoffFile) ? fs.readFileSync(handoffFile, 'utf8') : ''
  let original = ''
  if (record.prompt_file && fs.existsSync(record.prompt_file)) {
    original = fs.readFileSync(record.prompt_file, 'utf8')
  }
  const composed = `${handoffText}\n\n---\n\n${original}`
  const out = path.join(vibeDir(), 'handoff', `${record.run_id}.fallback.prompt.md`)
  fs.writeFileSync(out, composed)
  return out
}

export async function runSupervisor(run_id: string): Promise<void> {
  const initial = readRun(run_id)
  const policy = resolveAgentPolicy(initial)
  const session_id = initial.session_id
  const ts = () => new Date().toISOString()

  const startedAgent = policy.primary
  updateRun(run_id, { started_agent: startedAgent })
  appendEvent({ type: 'status', run_id, session_id, status: 'running', ts: ts() })

  // Agents to try, in order: primary then each fallback.
  const chain: AgentBackend[] = [policy.primary, ...policy.fallbacks]

  let ctx: AgentAdapterContext = {}
  let switched = false
  let switchReason: FailureReason | undefined
  let handoffStr: string | undefined

  for (let i = 0; i < chain.length; i++) {
    const agent = chain[i]
    const adapter = ADAPTERS[agent]
    const record = readRun(run_id)

    if (!adapter) {
      // Unknown/unsupported agent — terminal, no point switching for it.
      appendEvent({ type: 'error', run_id, session_id, message: `no adapter for agent: ${agent}`, ts: ts() })
      updateRun(run_id, {
        status: 'failed', final_agent: agent, switched, failure_reason: 'invalid_task', recoverable: false,
        ...(switchReason && { switch_reason: switchReason }), ...(handoffStr && { handoff_path: handoffStr }),
        child_pid: undefined,
      })
      appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
      return
    }

    // An adapter that throws (rather than returning a failed outcome) must not
    // leave the run without a terminal status — treat the throw as a failure so
    // classification/fallback still runs and exactly one terminal status is written.
    let outcome: AgentOutcome
    try {
      outcome = await adapter.run(record, ctx)
    } catch (err) {
      const message = `${agent} adapter crashed: ${(err as Error).message}`
      appendEvent({ type: 'error', run_id, session_id, message, ts: ts() })
      outcome = { result: 'failed', failureMessage: message, tailOutput: message }
    }

    // `vibe run stop` may have written a terminal `status:stopped` while we ran —
    // in that case the adapter returns failed without a diagnostic and we must
    // not emit another terminal status.
    if (readRun(run_id).status === 'stopped') return

    if (outcome.result === 'completed') {
      updateRun(run_id, {
        status: 'completed', final_agent: agent, switched,
        ...(switchReason && { switch_reason: switchReason }),
        ...(handoffStr && { handoff_path: handoffStr }),
        child_pid: undefined,
      })
      appendEvent({ type: 'status', run_id, session_id, status: 'completed', ts: ts() })
      return
    }

    // ── Failed: classify and decide whether to switch ──────────────────────────
    const cls = classifyFailure(outcome.tailOutput ?? outcome.failureMessage)
    const hasNext = i < chain.length - 1
    const willSwitch = cls.recoverable && policy.switchOn.includes(cls.reason) && hasNext

    if (!willSwitch) {
      // Terminal failure. The adapter already emitted the diagnostic `error`
      // event, so we only write the terminal status (matches old runner output).
      updateRun(run_id, {
        status: 'failed', final_agent: agent, switched,
        failure_reason: cls.reason, recoverable: cls.recoverable,
        ...(switchReason && { switch_reason: switchReason }),
        ...(handoffStr && { handoff_path: handoffStr }),
        child_pid: undefined,
      })
      appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
      return
    }

    // ── Switch to the next agent in the chain (same workspace, same run_id) ────
    const next = chain[i + 1]
    switched = true
    switchReason = cls.reason

    // Handoff generation is best-effort: if it fails we still switch (the fallback
    // just runs on the original prompt), so we never strand the run without a
    // terminal status.
    if (policy.handoffOnSwitch) {
      try {
        handoffStr = writeHandoff(record, agent, next, cls.reason, outcome.failureMessage)
      } catch (err) {
        appendEvent({ type: 'error', run_id, session_id, message: `handoff generation failed: ${(err as Error).message}`, ts: ts() })
        handoffStr = undefined
      }
    }
    appendEvent({
      type: 'log', run_id, session_id, stream: 'stdout',
      message: `↪ switching agent: ${agent} → ${next} (reason: ${cls.reason})`, ts: ts(),
    })
    updateRun(run_id, {
      final_agent: next, switched: true, switch_reason: cls.reason,
      ...(handoffStr && { handoff_path: handoffStr }),
    })

    // Fallback inherits the handoff prepended to the original task. preserveWorkspace
    // keeps the same workspace_path/branch (no delete/reset/re-clone here).
    ctx = {}
    if (handoffStr) {
      try {
        ctx = { promptOverridePath: buildFallbackPrompt(record, handoffStr) }
      } catch {
        ctx = {} // fall back to the original prompt_file
      }
    }
  }
}

// re-exported for callers/tests that want the canonical handoff location
export { handoffPath }
