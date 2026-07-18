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
import { preflightGithubAuth, preauthEnabled } from './preauth.js'
import {
  assertCleanRepoUrl,
  checkWorkspaceRepoMatch,
  readOriginUrl,
  RepoUrlCredentialsError,
  WorkspaceRepoMismatchError,
} from '../workspace.js'
import {
  assertRepoAllowed,
  resolveRepoAllowlist,
  repoAllowlistEnabled,
  RepoNotAllowedError,
} from '../repo-policy.js'
import type { AgentAdapter, AgentAdapterContext, AgentOutcome, FailureReason } from './types.js'
import { resolveCodexSandbox, type LeaseDecisionState } from './codex-sandbox.js'
import { openNodeJournal } from '../node-journal/sqlite-journal.js'
import type { WorkspaceLeaseV1 } from '../lib/workspace-lease.js'
import { buildTaskResult, MAX_FINAL_OUTPUT_BYTES, type AgentTaskResultV1, type TaskResultStatus } from '../lib/agent-task-result.js'
import type { TaskVerificationV1 } from '../lib/task-verification.js'
import { runVerifier, verifierPreflight } from './verifier.js'
import { mockAdapter } from './adapters/mock.js'
import { claudeAdapter } from './adapters/claude.js'
import { codexAdapter } from './adapters/codex.js'

const ADAPTERS: Record<AgentBackend, AgentAdapter | undefined> = {
  mock: mockAdapter,
  'claude-code': claudeAdapter,
  codex: codexAdapter,
  opencode: undefined,
}

/** Injectable IO for the supervisor (test seam). The default reads the
 *  Node-authoritative workspace lease from the local node journal. */
export interface SupervisorDeps {
  /** Look up the Node's durable workspace lease by id (null when absent). Only
   *  consulted for a write-permitted Codex task. */
  resolveWorkspaceLease?: (leaseId: string) => WorkspaceLeaseV1 | null
}

/** Default lease resolver — the Node journal is the lease authority. Opened
 *  lazily and ONLY when a write-permitted Codex task actually needs it, so a
 *  read-only or non-lease run never touches it. */
function defaultResolveWorkspaceLease(leaseId: string): WorkspaceLeaseV1 | null {
  try { return openNodeJournal().getWorkspaceLease(leaseId) } catch { return null }
}

/** Classify a Codex task's bound lease against the run for the sandbox decision.
 *  Any divergence (absent binding, no record, not active, wrong node/workspace)
 *  is a distinct fail-closed state — never a silent read-only downgrade. */
function deriveLeaseState(record: RunRecord, lease: WorkspaceLeaseV1 | null): LeaseDecisionState {
  if (!record.workspace_lease_id) return 'none'      // write permitted but no lease bound
  if (!lease) return 'invalid'                        // presented id resolves to nothing
  if (lease.status !== 'active') return 'inactive'
  if (lease.node_id !== record.node_id || lease.workspace_key !== record.workspace_key) return 'mismatch'
  return 'active_match'
}

/** Whether to run the github.com auth preflight: only when enabled, the run
 *  targets a github.com remote, and a real (pushing) agent is in the chain.
 *  The mock agent never pushes, so a mock-only chain is exempt. */
function shouldPreauth(record: RunRecord, chain: AgentBackend[]): boolean {
  if (!preauthEnabled()) return false
  if (!record.repo_url || !/github\.com/i.test(record.repo_url)) return false
  return chain.some((a) => a === 'claude-code' || a === 'codex')
}

/** Whether to run the repo allowlist/remote gate: only when enforcement is on,
 *  the run targets a github.com remote, and a real (pushing) agent is in the
 *  chain. Mock-only chains never push, so they are exempt. */
export function shouldRepoGate(record: RunRecord, chain: AgentBackend[]): boolean {
  if (!repoAllowlistEnabled()) return false
  if (!record.repo_url || !/github\.com/i.test(record.repo_url)) return false
  return chain.some((a) => a === 'claude-code' || a === 'codex')
}

export interface RepoGateResult {
  ok: boolean
  code?: string
  reason?: FailureReason
  message?: string
}

/**
 * Fail-closed repo gate run before a real pushing agent launches. Verifies the
 * requested repo_url is clean + allowlisted, and (when the workspace already has
 * a checkout) that its origin remote matches, is clean, and is allowlisted. No
 * fallback for any of these — they are binding/config problems, and no token ever
 * appears in the returned message.
 */
export function runRepoGate(repoUrl: string, workspacePath: string): RepoGateResult {
  const allowlist = resolveRepoAllowlist()
  try {
    // Requested repo: token-bearing first (precise error), then allowlist.
    assertCleanRepoUrl(repoUrl)
    assertRepoAllowed(repoUrl, allowlist)

    // Stale-workspace defense: if a checkout already exists, its origin must be
    // clean, allowlisted, and match the requested repo (no wrong/stale remote).
    const origin = readOriginUrl(workspacePath)
    if (origin) {
      assertCleanRepoUrl(origin)
      assertRepoAllowed(origin, allowlist)
    }
    checkWorkspaceRepoMatch(workspacePath, repoUrl)
  } catch (err) {
    if (err instanceof RepoUrlCredentialsError) {
      return { ok: false, code: err.code, reason: 'repo_not_allowed', message: err.message }
    }
    if (err instanceof RepoNotAllowedError) {
      return { ok: false, code: err.code, reason: 'repo_not_allowed', message: err.message }
    }
    if (err instanceof WorkspaceRepoMismatchError) {
      return { ok: false, code: err.code, reason: 'unknown_repo', message: err.message }
    }
    return { ok: false, code: 'repo_gate_error', reason: 'repo_not_allowed', message: `repo gate failed: ${(err as Error).message}` }
  }
  return { ok: true }
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

/** Build the durable AgentTaskResult from an adapter's authoritative final output.
 *  Absent or oversized final output → `missing` (never a guess from event history).
 *  `verification` (when a verifier ran) is embedded as the ONLY authoritative test
 *  evidence. */
function finalizeResult(outcome: AgentOutcome, verification?: TaskVerificationV1): { result_status: TaskResultStatus; task_result?: AgentTaskResultV1 } {
  const fo = outcome.finalOutput
  if (typeof fo === 'string' && Buffer.byteLength(fo, 'utf8') <= MAX_FINAL_OUTPUT_BYTES) {
    return { result_status: 'available', task_result: buildTaskResult({ text: fo, processExitCode: outcome.exitCode, ...(verification ? { verification } : {}) }) }
  }
  return { result_status: 'missing' }
}

export async function runSupervisor(run_id: string, deps: SupervisorDeps = {}): Promise<void> {
  const resolveWorkspaceLease = deps.resolveWorkspaceLease ?? defaultResolveWorkspaceLease
  const initial = readRun(run_id)
  const policy = resolveAgentPolicy(initial)
  const session_id = initial.session_id
  const ts = () => new Date().toISOString()

  const startedAgent = policy.primary
  updateRun(run_id, { started_agent: startedAgent })
  appendEvent({ type: 'status', run_id, session_id, status: 'running', ts: ts() })

  // Agents to try, in order: primary then each fallback.
  const chain: AgentBackend[] = [policy.primary, ...policy.fallbacks]

  // ── Fail-closed GitHub auth preflight ──────────────────────────────────────
  // Before a real (pushing) agent runs against a github.com remote, confirm the
  // controlled credential path resolves to an allowlisted account, not the
  // Windows GCM / personal-account fallback (JOZ-32). Fail before any agent runs
  // so nothing is ever pushed under the wrong identity. Not recoverable → no
  // fallback for a wrong-auth node misconfiguration.
  if (shouldPreauth(initial, chain)) {
    const pre = preflightGithubAuth()
    if (!pre.ok) {
      const message = `auth preflight failed: ${pre.reason}`
      appendEvent({ type: 'error', run_id, session_id, message, code: 'auth_misconfigured', ts: ts() })
      updateRun(run_id, {
        status: 'failed', started_agent: startedAgent, final_agent: startedAgent,
        switched: false, failure_reason: 'auth_misconfigured', recoverable: false,
        child_pid: undefined,
      })
      appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
      return
    }
  }

  // ── Fail-closed repo allowlist / remote gate ────────────────────────────────
  // Before a real pushing agent runs against a github.com remote, confirm the
  // requested repo and any existing workspace origin are clean (no token),
  // allowlisted, and consistent — so an agent can never be pointed at the wrong
  // or non-JozzyAI repo. Fail before any agent runs; not recoverable → no fallback.
  if (shouldRepoGate(initial, chain)) {
    const gate = runRepoGate(initial.repo_url as string, initial.workspace_path)
    if (!gate.ok) {
      appendEvent({ type: 'error', run_id, session_id, message: gate.message as string, code: gate.code, ts: ts() })
      updateRun(run_id, {
        status: 'failed', started_agent: startedAgent, final_agent: startedAgent,
        switched: false, failure_reason: gate.reason, recoverable: false,
        child_pid: undefined,
      })
      appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
      return
    }
  }

  // ── Fail-closed test-verifier capability check ──────────────────────────────
  // If the step declared a Harness verifier, confirm THIS node can run it BEFORE any
  // agent launches. A missing/misconfigured verifier is terminal (not recoverable):
  // running the agent anyway would yield a "completed" result that could never carry
  // trusted test evidence, silently defeating the completion policy.
  if (initial.verify) {
    const pf = verifierPreflight(initial.verify)
    if (!pf.ok) {
      const message = `test verifier unavailable: ${pf.message}`
      appendEvent({ type: 'error', run_id, session_id, message, code: 'verifier_unavailable', ts: ts() })
      updateRun(run_id, {
        status: 'failed', started_agent: startedAgent, final_agent: startedAgent,
        switched: false, failure_reason: 'verifier_unavailable', recoverable: false,
        child_pid: undefined,
      })
      appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
      return
    }
  }

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

    // ── Fail-closed Codex workspace-write gate (BEFORE Codex launches) ─────────
    // Map this Codex task's permission mode + write policy + the Node-validated
    // workspace lease to the narrowest sandbox. A write-permitted task with a
    // missing / inactive / mismatched / invalid lease fails closed here — Codex
    // never starts. `unsafe-skip` keeps its explicit bypass (handled in the
    // adapter). Read-only tasks stay read-only. The resolved sandbox is threaded
    // to the adapter via ctx; the decision is logged as a sanitized diagnostic.
    if (agent === 'codex' && record.permission_mode !== 'unsafe-skip') {
      const writeRequested = record.workspace_write === true
      let lease: LeaseDecisionState = 'none'
      if (writeRequested) {
        const rec = record.workspace_lease_id ? resolveWorkspaceLease(record.workspace_lease_id) : null
        lease = deriveLeaseState(record, rec)
      }
      const decision = resolveCodexSandbox({ permissionMode: record.permission_mode, writeRequested, lease, workspacePath: record.workspace_path })
      const d = decision.diagnostics
      appendEvent({ type: 'log', run_id, session_id, stream: 'stdout', message: `codex sandbox: ${d.sandbox} (permission=${d.permission_mode}, write_requested=${d.write_requested}, lease=${d.lease_state}, network=${d.network}, approvals=${d.approvals})`, ts: ts() })
      if (!decision.ok) {
        appendEvent({ type: 'error', run_id, session_id, message: `codex workspace-write denied: ${decision.code}`, code: decision.code, ts: ts() })
        updateRun(run_id, {
          status: 'failed', final_agent: agent, switched, failure_reason: 'permission_denied', recoverable: false,
          ...(switchReason && { switch_reason: switchReason }), ...(handoffStr && { handoff_path: handoffStr }),
          child_pid: undefined,
        })
        appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
        return
      }
      ctx = { ...ctx, codexSandbox: decision.mode }
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
      // ── Harness-owned test verification (runs AFTER the agent exits, BEFORE the
      // result is finalized). The verifier is a TRUSTED spec-declared command run in
      // the leased workspace; its exit code is the sole source of tests_passed/
      // tests_failed evidence. Agent-reported test claims are never consulted. The
      // record it produces is embedded in the durable AgentTaskResult so the
      // completion policy sees only this system-observed evidence.
      let verification: TaskVerificationV1 | undefined
      if (record.verify) {
        // Re-check the capability (profile + sandbox) now; if it regressed since the
        // pre-agent preflight, FAIL the run closed rather than complete unverified.
        const pf = verifierPreflight(record.verify)
        if (!pf.ok) {
          const message = `test verifier unavailable after agent run: ${pf.message}`
          appendEvent({ type: 'error', run_id, session_id, message, code: 'verifier_unavailable', ts: ts() })
          updateRun(run_id, { status: 'failed', final_agent: agent, switched, failure_reason: 'verifier_unavailable', recoverable: false, ...(switchReason && { switch_reason: switchReason }), ...(handoffStr && { handoff_path: handoffStr }), child_pid: undefined })
          appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
          return
        }
        try {
          verification = await runVerifier(record.verify, record.workspace_path)
          appendEvent({ type: 'log', run_id, session_id, stream: 'stdout', message: `verification: ${verification.kind} via profile "${verification.profile}" (exit ${verification.exit_code})`, ts: ts() })
        } catch (err) {
          // The sandboxed verifier could not run — fail closed (never complete unverified).
          appendEvent({ type: 'error', run_id, session_id, message: `test verifier error: ${(err as Error).message}`, code: 'verifier_error', ts: ts() })
          updateRun(run_id, { status: 'failed', final_agent: agent, switched, failure_reason: 'verifier_unavailable', recoverable: false, ...(switchReason && { switch_reason: switchReason }), ...(handoffStr && { handoff_path: handoffStr }), child_pid: undefined })
          appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
          return
        }
      }
      // Finalize the authoritative AgentTaskResult from the adapter's OWN completion
      // path (never by scanning the event log). No authoritative/bounded final
      // output → result_status = 'missing' (we never guess from events).
      const { result_status, task_result } = finalizeResult(outcome, verification)
      updateRun(run_id, {
        status: 'completed', final_agent: agent, switched,
        ...(switchReason && { switch_reason: switchReason }),
        ...(handoffStr && { handoff_path: handoffStr }),
        ...(outcome.exitCode !== undefined && { exit_code: outcome.exitCode }),
        result_status, ...(task_result && { task_result }),
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
        ...(outcome.exitCode !== undefined && { exit_code: outcome.exitCode }),
        ...(outcome.failureMessage && { error: outcome.failureMessage }),
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
