/**
 * Codex sandbox / permission decision.
 *
 * Maps a Codex task's declared permission mode + workspace-write policy + the
 * NODE-validated workspace lease to the NARROWEST Codex sandbox that still lets
 * the task do its job:
 *   - a read-only task stays read-only (never fails), even if a lease is bound;
 *   - a write-permitted task gets `workspace-write` ONLY when an active lease
 *     for THIS node + THIS exact workspace authorizes it — its writable root is
 *     scoped to that leased workspace;
 *   - a write-permitted task with a missing / inactive / mismatched / invalid
 *     lease FAILS CLOSED (the caller must not launch Codex).
 *
 * Writes are never inferred from the agent name or the workspace path — only
 * from an explicit write policy AND a valid lease. `default` is NEVER escalated
 * to `danger-full-access`; that remains the pre-existing, explicit `unsafe-skip`
 * mode (unchanged public semantics), handled by the adapter directly and never
 * routed through this function. Network / secret / push / deploy / external
 * effects stay disabled: `workspace-write` keeps Codex's network OFF and
 * approvals disabled for unattended execution.
 *
 * Pure + fully testable — the IO (reading the lease from the Node journal) lives
 * in the caller (the supervisor gate).
 */
import type { PermissionMode } from '../types.js'

export type CodexSandboxMode = 'read-only' | 'workspace-write'

/** How the (required) workspace lease resolved, from the Node authority. Only
 *  consulted when the task is write-permitted. */
export type LeaseDecisionState =
  | 'active_match'   // active, this node, this exact workspace — writes allowed
  | 'none'           // write permitted but no lease was bound to the run
  | 'inactive'       // a lease exists but is not active (acquiring/released/…)
  | 'mismatch'       // the lease is for a different node / workspace
  | 'invalid'        // no such lease / malformed lease record

export interface CodexSandboxInput {
  permissionMode: PermissionMode | undefined
  /** Whether task/workflow policy permits this task to MODIFY the workspace. */
  writeRequested: boolean
  /** Lease resolution — ONLY meaningful when writeRequested is true. */
  lease: LeaseDecisionState
  /** The resolved, contained leased workspace path (the writable root when granted). */
  workspacePath: string
}

export type CodexSandboxDenyCode =
  | 'workspace_lease_required'   // write permitted, but no lease was bound
  | 'workspace_lease_inactive'   // the bound lease is not active
  | 'workspace_lease_mismatch'   // the lease is for another node / workspace
  | 'workspace_lease_invalid'    // no such / malformed lease record

/** Sanitized, secret-free record of the decision for task diagnostics/metadata. */
export interface SandboxDiagnostics {
  agent: 'codex'
  permission_mode: string
  write_requested: boolean
  lease_state: LeaseDecisionState | 'not_consulted'
  sandbox: CodexSandboxMode | 'denied'
  /** Constant reminders that the grant never widens beyond the leased tree. */
  network: 'restricted'
  approvals: 'never'
}

export type CodexSandboxDecision =
  | { ok: true; mode: CodexSandboxMode; writableRoot?: string; diagnostics: SandboxDiagnostics }
  | { ok: false; code: CodexSandboxDenyCode; reason: string; diagnostics: SandboxDiagnostics }

const DENY: Record<Exclude<LeaseDecisionState, 'active_match'>, CodexSandboxDenyCode> = {
  none: 'workspace_lease_required',
  inactive: 'workspace_lease_inactive',
  mismatch: 'workspace_lease_mismatch',
  invalid: 'workspace_lease_invalid',
}

/**
 * Resolve the Codex sandbox for a `default`-permission task. `unsafe-skip` is
 * NOT handled here (the adapter preserves its explicit bypass); callers must not
 * route it through this function.
 */
export function resolveCodexSandbox(input: CodexSandboxInput): CodexSandboxDecision {
  const base = {
    agent: 'codex' as const,
    permission_mode: input.permissionMode ?? 'default',
    network: 'restricted' as const,
    approvals: 'never' as const,
  }
  // Read-only task (no write policy): the narrowest sandbox. Never fails and
  // never escalates — even if an active lease happens to be bound.
  if (!input.writeRequested) {
    return { ok: true, mode: 'read-only', diagnostics: { ...base, write_requested: false, lease_state: 'not_consulted', sandbox: 'read-only' } }
  }
  // Write permitted: allowed ONLY inside an active, exactly-matched lease, and
  // scoped to that leased workspace.
  if (input.lease === 'active_match') {
    return { ok: true, mode: 'workspace-write', writableRoot: input.workspacePath, diagnostics: { ...base, write_requested: true, lease_state: 'active_match', sandbox: 'workspace-write' } }
  }
  // Any other lease state fails closed — Codex must not launch.
  const code = DENY[input.lease]
  return { ok: false, code, reason: `codex workspace-write denied: ${code}`, diagnostics: { ...base, write_requested: true, lease_state: input.lease, sandbox: 'denied' } }
}
