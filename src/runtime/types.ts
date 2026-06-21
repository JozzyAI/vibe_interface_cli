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

/** Non-recoverable: switching agents would not help — the work or repo is the problem. */
export type NonRecoverableReason =
  | 'tests_failed'
  | 'merge_conflict'
  | 'repo_not_found'
  | 'permission_denied'
  | 'unknown_repo'
  | 'invalid_task'
  // The controlled GitHub auth path did not resolve to an allowlisted account
  // (e.g. the Windows GCM / personal-account fallback). Non-recoverable: every
  // agent on this node shares the same broken credential path, so switching
  // would not help — and we must never fall back to a wrong-auth push.
  | 'auth_misconfigured'

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
}

export interface AgentAdapterContext {
  /** When set, the adapter reads this prompt file instead of record.prompt_file (used to inject handoff). */
  promptOverridePath?: string
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
