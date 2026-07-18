/**
 * Meta-Agent Runtime types.
 *
 * The runtime sits between the run record and the concrete coding agents. It
 * runs a primary agent, classifies a recoverable failure, optionally writes a
 * handoff, and falls back to another agent — all under one run_id, so Symphony
 * still sees a single run with a single terminal status.
 */
import type { AgentBackend } from '../types.js'

// ── Failure classification ───────────────────────────────────────────────────

/** Recoverable: the failure is about the agent/runtime (limits, auth), not the work itself. */
export type RecoverableReason =
  | 'session_limit'
  | 'usage_limit'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'context_limit'
  | 'auth_expired'
  // The configured agent's CLI binary is missing from PATH (real spawn ENOENT,
  // or a mock simulating it). Recoverable: a different agent's binary may well
  // exist, so a fallback is worth trying — unlike `auth_misconfigured` (below),
  // this is not opted out of DEFAULT_SWITCH_ON for any reason, but is still not
  // in it by default to keep existing callers byte-identical unless they opt in.
  | 'command_not_found'

/** Non-recoverable: switching agents would not help — the work or repo is the problem. */
export type NonRecoverableReason =
  | 'tests_failed'
  | 'merge_conflict'
  | 'repo_not_found'
  | 'permission_denied'
  | 'unknown_repo'
  | 'invalid_task'
  // The step declared a Harness test verifier but this node cannot run it (bad
  // config or the program is not installed). Fail-closed BEFORE any agent runs so
  // we never produce a "completed" result that can never be trust-verified.
  | 'verifier_unavailable'
  // The controlled GitHub auth path did not resolve to an allowlisted account
  // (e.g. the Windows GCM / personal-account fallback). Non-recoverable: every
  // agent on this node shares the same broken credential path, so switching
  // would not help — and we must never fall back to a wrong-auth push.
  | 'auth_misconfigured'
  // The requested repo (or a stale workspace's origin) is not an allowlisted
  // remote, or carries embedded credentials (PR C1 repo gate). Non-recoverable:
  // it is a binding/config problem, not an agent problem — switching agents
  // would just point the next one at the same unsafe repo.
  | 'repo_not_allowed'

export type FailureReason = RecoverableReason | NonRecoverableReason | 'unknown'

export interface FailureClassification {
  reason: FailureReason
  recoverable: boolean
}

/**
 * Default set of reasons that trigger an automatic fallback in v1 when the
 * caller supplies fallback agents but no explicit --switch-on. Deliberately
 * excludes `auth_expired` / credential exhaustion: a fallback agent could push
 * under different (e.g. personal) GitHub auth, so that must be opted in.
 */
export const DEFAULT_SWITCH_ON: RecoverableReason[] = [
  'session_limit',
  'usage_limit',
  'quota_exceeded',
  'rate_limited',
]

// ── Policy ───────────────────────────────────────────────────────────────────

export interface AgentPolicy {
  primary: AgentBackend
  fallbacks: AgentBackend[]
  /** Failure reasons that trigger a switch to the next fallback. */
  switchOn: FailureReason[]
  preserveWorkspace: boolean
  handoffOnSwitch: boolean
}

// ── Adapter outcome ──────────────────────────────────────────────────────────

/**
 * What an AgentAdapter returns after a single agent has run to completion.
 * Adapters do NOT emit the initial `status:running` or the final terminal
 * status — that is the supervisor's job, so a fallback can replace a failure
 * with a later success under the same run_id.
 */
export interface AgentOutcome {
  result: 'completed' | 'failed'
  /** Human-readable failure message (already emitted as a diagnostic `error` event by the adapter). */
  failureMessage?: string
  /** Bounded tail of the agent's stdout+stderr, used by the classifier. Never contains secrets (redacted upstream). */
  tailOutput?: string
  /** Process/adapter exit status, when the adapter has one (e.g. a spawned CLI's real exit code, or a mock's simulated one). Projected onto the run record's `exit_code` on the terminal outcome. */
  exitCode?: number
  /**
   * The provider's AUTHORITATIVE final output text, captured through the adapter's
   * OWN completion path (e.g. Claude's stream-json `result` message) — NOT by
   * scanning the persisted event history. `undefined` means the backend produced
   * no authoritative final result (→ result_status = `missing`). The provider layer
   * never parses workflow schemas (planner_decision/executor_handoff); it supplies
   * only generic final text. Bounded by the supervisor before persistence.
   */
  finalOutput?: string
}

export interface AgentAdapterContext {
  /** When set, the adapter reads this prompt file instead of record.prompt_file (used to inject handoff). */
  promptOverridePath?: string
  /** Supervisor-resolved Codex sandbox (from the codex-sandbox gate: permission
   *  mode + write policy + the Node-validated workspace lease). Consumed ONLY by
   *  the codex adapter. Absent → read-only (the safe default). `unsafe-skip`
   *  bypasses this and is handled by the adapter directly. */
  codexSandbox?: import('./codex-sandbox.js').CodexSandboxMode
}

export interface AgentAdapter {
  run(run: import('../types.js').RunRecord, ctx: AgentAdapterContext): Promise<AgentOutcome>
}

// ── Normalized run result (projected onto the run record / status output) ────

export interface RunResult {
  status: 'completed'
  started_agent: AgentBackend
  final_agent: AgentBackend
  switched: boolean
  switch_reason?: FailureReason
  workspace_path: string
  branch?: string
  pr_url?: string
  handoff_path?: string
}

export interface RunFailure {
  status: 'failed'
  started_agent: AgentBackend
  final_agent: AgentBackend
  failure_reason: FailureReason
  recoverable: boolean
  workspace_path: string
  handoff_path?: string
}
