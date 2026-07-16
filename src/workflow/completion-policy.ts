/**
 * PURE verified-evidence assembly + completion-policy evaluation.
 *
 * An agent's requested `$complete` is a CLAIM. When a WorkflowSpec declares a
 * `completion_policy`, the runtime must verify SYSTEM-OBSERVED evidence before it
 * completes the workflow. This module is pure: it assembles a bounded evidence
 * snapshot from already-durable system facts (authoritative task status, process
 * exit code, AgentTaskResult content hash + provider-structured evidence refs, and
 * the workspace revision observed before/after the step) and evaluates the policy.
 *
 * It NEVER infers test success from agent prose or from repository changes, and it
 * treats agent-reported fields (e.g. `tests_run`) as claims, not evidence.
 */
import crypto from 'crypto'
import type { CompletionPolicy, EvidenceType, WorkflowSpec } from './contract.js'

/** A spec is COMPLETABLE if any edge routes to the reserved `$complete` target. Such
 *  a newly-created spec must declare a completion_policy (enforced at create time). */
export function isCompletableSpec(spec: WorkflowSpec): boolean {
  return Array.isArray(spec.edges) && spec.edges.some((e) => e && (e as { to?: unknown }).to === '$complete')
}
import type { EvidenceRef, AgentTaskResultV1 } from '../lib/agent-task-result.js'
import type { WorkspaceRevision } from '../lib/workspace-lease.js'

/** Bounded, SYSTEM-OBSERVED evidence snapshot for a completing step. Every field is
 *  a fact the runtime observed — never an agent claim. Persisted durably. */
export interface VerifiedEvidence {
  task_status: string | null       // authoritative durable task status
  exit_code: number | null         // AgentTaskResult.process_exit_code
  content_hash: string | null      // AgentTaskResult.content_hash
  revision_before: string | null   // workspace revision state_hash BEFORE the step
  revision_after: string | null    // workspace revision state_hash AFTER the step
  repository_changed: boolean | null // before !== after (null when unobservable)
  changed_files: string[] | null   // observed changed files AFTER (bounded)
  changed_files_hash: string | null // digest of the sorted changed-files list
  tests_passed: boolean | null     // provider-structured test evidence (never prose)
}

/** Provider-structured test evidence: an `evidence_ref` with kind `tests_passed`
 *  (→ true) or `tests_failed` (→ false). Absent → null (NOT inferred from prose). */
export function testsEvidenceFromRefs(refs: EvidenceRef[] | undefined): boolean | null {
  if (!Array.isArray(refs)) return null
  if (refs.some((r) => r && r.kind === 'tests_passed')) return true
  if (refs.some((r) => r && r.kind === 'tests_failed')) return false
  return null
}

const revHash = (r: WorkspaceRevision | null | undefined): string | null => (r && typeof r.state_hash === 'string' ? r.state_hash : null)

/** Assemble the verified evidence from durable system facts. `result` is the durable
 *  AgentTaskResult (may be null); revisions come from the step's before/after
 *  observations (present only for a lease-managed workspace step). */
export function assembleEvidence(input: {
  taskStatus: string | null
  result: AgentTaskResultV1 | null
  revisionBefore: WorkspaceRevision | null
  revisionAfter: WorkspaceRevision | null
}): VerifiedEvidence {
  const before = revHash(input.revisionBefore)
  const after = revHash(input.revisionAfter)
  const changed_files = input.revisionAfter && input.revisionAfter.revision_kind === 'git' ? input.revisionAfter.changed_files : null
  return {
    task_status: input.taskStatus,
    exit_code: input.result?.process_exit_code ?? null,
    content_hash: input.result?.content_hash ?? null,
    revision_before: before,
    revision_after: after,
    repository_changed: before !== null && after !== null ? before !== after : null,
    changed_files,
    changed_files_hash: changed_files ? crypto.createHash('sha256').update(JSON.stringify([...changed_files].sort())).digest('hex') : null,
    tests_passed: testsEvidenceFromRefs(input.result?.evidence_refs),
  }
}

/** Whether a required evidence TYPE is present (observed) in the snapshot. */
function present(type: EvidenceType, e: VerifiedEvidence): boolean {
  switch (type) {
    case 'task_status': return e.task_status === 'completed'
    case 'exit_code': return e.exit_code !== null
    case 'content_hash': return typeof e.content_hash === 'string' && e.content_hash !== ''
    case 'workspace_revision': return e.revision_before !== null && e.revision_after !== null
    case 'changed_files': return e.changed_files !== null
    case 'tests_passed': return e.tests_passed !== null
  }
}

export type CompletionDecision =
  | { decision: 'complete' }
  | { decision: 'blocked'; reason: 'verification_required'; missing: string[] }
  | { decision: 'failed'; reason: string }

/**
 * Evaluate a completion policy against verified evidence + the completing step's
 * declared `remaining_work`. Conflicting evidence (the system contradicts the
 * completion claim) FAILS CLOSED; merely-missing/unmet requirements BLOCK with
 * `verification_required`. `remainingWork` is the agent-declared list (a claim used
 * only for `require_no_remaining_work`), never treated as verified evidence.
 */
export function evaluateCompletion(policy: CompletionPolicy, e: VerifiedEvidence, remainingWork: unknown[] | null): CompletionDecision {
  // 1) Conflicts → fail closed (the system evidence CONTRADICTS "complete"). A
  //    TERMINAL non-completed task status (failed/cancelled) or a non-zero exit
  //    contradicts completion; a non-terminal status (queued/running/null) is merely
  //    "not yet authoritative" and is handled as missing evidence below, not a conflict.
  if (e.task_status === 'failed' || e.task_status === 'cancelled') return { decision: 'failed', reason: 'evidence_conflict_task_status' }
  if (e.exit_code !== null && e.exit_code !== 0) return { decision: 'failed', reason: 'evidence_conflict_nonzero_exit' }
  if (policy.require_tests_passed && e.tests_passed === false) return { decision: 'failed', reason: 'evidence_conflict_tests_failed' }

  // 2) Missing / unmet requirements → blocked (verification_required).
  const missing: string[] = []
  for (const t of policy.required_evidence ?? []) if (!present(t, e)) missing.push(t)
  if (policy.require_repository_change && e.repository_changed !== true) missing.push('repository_change')
  if (policy.require_tests_passed && e.tests_passed !== true) missing.push('tests_passed')
  if (policy.require_no_remaining_work && Array.isArray(remainingWork) && remainingWork.length > 0) missing.push('no_remaining_work')
  if (missing.length > 0) return { decision: 'blocked', reason: 'verification_required', missing: [...new Set(missing)] }

  return { decision: 'complete' }
}
