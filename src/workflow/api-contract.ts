/**
 * Workflow REST contract — PURE types, request validation, durable projections,
 * and a structured error envelope. No I/O, no SQL, no runtime here.
 *
 * Reuses the Gateway error envelope shape (`{ error, code, message, retryable, ts,
 * details? }`) with workflow-specific `code`s so old clients keep parsing it. A
 * projection NEVER exposes tokens, encryption keys, credentials, backend PIDs,
 * native-agent histories, DB paths, SQL, prompts-as-secrets, or stack traces.
 */
import { ControlStoreError } from '../control/records.js'
import { WorkflowRuntimeError } from './errors.js'
import { validateWorkflowSpec, type ValidationIssue } from './validator.js'
import type { WorkflowRecord, StepExecutionRecord, WorkflowEventRecord, WorkflowWorkspaceLeaseRecord } from '../control/records.js'

export type WorkflowApiErrorCode =
  | 'invalid_request'
  | 'workflow_not_found'
  | 'invalid_workflow_spec'
  | 'invalid_workflow_inputs'
  | 'workflow_state_conflict'
  | 'workspace_lease_conflict'     // a required Node workspace is already leased by another workflow
  | 'workspace_lease_unsupported'  // a workspace-bound workflow cannot start without a lease authority
  | 'workspace_lease_unavailable'  // the workspace-lease service was unreachable at start
  | 'workflow_storage_failure'
  | 'workflow_runtime_unavailable'
  | 'internal_error'

export interface WorkflowApiError {
  error: true
  code: WorkflowApiErrorCode
  message: string
  retryable: boolean
  ts: string
  details?: Record<string, unknown>
}

const RETRYABLE: Record<WorkflowApiErrorCode, boolean> = {
  invalid_request: false,
  workflow_not_found: false,
  invalid_workflow_spec: false,
  invalid_workflow_inputs: false,
  workflow_state_conflict: false,
  workspace_lease_conflict: false,
  workspace_lease_unsupported: false,
  workspace_lease_unavailable: true,
  workflow_storage_failure: true,
  workflow_runtime_unavailable: true,
  internal_error: true,
}

export function workflowApiError(code: WorkflowApiErrorCode, message: string, details?: Record<string, unknown>): WorkflowApiError {
  return { error: true, code, message, retryable: RETRYABLE[code], ts: new Date().toISOString(), ...(details ? { details } : {}) }
}

export function workflowErrorHttpStatus(code: WorkflowApiErrorCode): number {
  switch (code) {
    case 'invalid_request': return 400
    case 'invalid_workflow_spec': return 400
    case 'invalid_workflow_inputs': return 400
    case 'workflow_not_found': return 404
    case 'workflow_state_conflict': return 409
    case 'workspace_lease_conflict': return 409
    case 'workspace_lease_unsupported': return 422
    case 'workspace_lease_unavailable': return 503
    case 'workflow_runtime_unavailable': return 503
    case 'workflow_storage_failure': return 500
    case 'internal_error': return 500
  }
}

/** Map a thrown runtime/store error to a sanitized envelope + HTTP status. Never
 *  echoes prompts, input values, SQL, DB paths, or stack traces. */
export function mapThrownError(err: unknown): { error: WorkflowApiError; status: number } {
  if (err instanceof WorkflowRuntimeError) {
    let code: WorkflowApiErrorCode = 'internal_error'
    if (err.code === 'invalid_spec') code = 'invalid_workflow_spec'
    else if (err.code === 'invalid_input_values') code = 'invalid_workflow_inputs'
    else if (err.code === 'invalid_transition') code = 'workflow_state_conflict'
    else if (err.code === 'workspace_lease_conflict') code = 'workspace_lease_conflict'
    else if (err.code === 'workspace_lease_unsupported') code = 'workspace_lease_unsupported'
    else if (err.code === 'workspace_lease_unavailable') code = 'workspace_lease_unavailable'
    else if (err.code === 'workspace_node_ambiguous') code = 'invalid_workflow_spec' // a workspace-bound step lacks an explicit node_id
    // Only the code's own safe meta (issues / input name) is surfaced — never raw values.
    const safeDetails = sanitizeMeta(err.meta)
    const e = workflowApiError(code, safeMessage(err.message), safeDetails)
    return { error: e, status: workflowErrorHttpStatus(code) }
  }
  if (err instanceof ControlStoreError) {
    const code: WorkflowApiErrorCode = err.code === 'not_found' ? 'workflow_not_found' : err.code === 'invalid_transition' || err.code === 'revision_conflict' ? 'workflow_state_conflict' : 'workflow_storage_failure'
    const e = workflowApiError(code, 'a durable workflow store operation failed') // never echo the store message (may name columns)
    return { error: e, status: workflowErrorHttpStatus(code) }
  }
  return { error: workflowApiError('internal_error', 'internal error'), status: 500 }
}

/** Keep only bounded, safe fields from a runtime error's meta (issue codes/paths,
 *  an input name) — never raw values. */
function sanitizeMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const m = meta as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (Array.isArray(m.issues)) out.issues = (m.issues as Array<Record<string, unknown>>).slice(0, 20).map((i) => ({ code: i.code, ...(i.path ? { path: i.path } : {}) }))
  if (typeof m.name === 'string') out.field = m.name
  return Object.keys(out).length ? out : undefined
}

const MAX_MESSAGE = 300
function safeMessage(msg: string): string { return typeof msg === 'string' ? msg.slice(0, MAX_MESSAGE) : 'error' }

// ── create-request validation ──────────────────────────────────────────────────

export interface CreateWorkflowBody { spec: unknown; input_values?: Record<string, unknown> }

/** Validate the create-workflow request SHAPE (not the deep spec — the runtime
 *  does that). Returns the body or a structured invalid_request. */
export function parseCreateWorkflowBody(body: unknown): { ok: true; value: CreateWorkflowBody } | { ok: false; error: WorkflowApiError } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: workflowApiError('invalid_request', 'request body must be a JSON object') }
  const b = body as Record<string, unknown>
  if (typeof b.spec !== 'object' || b.spec === null || Array.isArray(b.spec)) return { ok: false, error: workflowApiError('invalid_request', '`spec` must be a WorkflowSpec object') }
  if (b.input_values !== undefined && (typeof b.input_values !== 'object' || b.input_values === null || Array.isArray(b.input_values))) return { ok: false, error: workflowApiError('invalid_request', '`input_values` must be an object') }
  for (const k of Object.keys(b)) if (k !== 'spec' && k !== 'input_values') return { ok: false, error: workflowApiError('invalid_request', `unknown field: ${k}`) }
  return { ok: true, value: { spec: b.spec, input_values: b.input_values as Record<string, unknown> | undefined } }
}

/** Rich, sanitized 400 for a spec that fails validation (issue code/severity/
 *  message/path only — never raw prompt/spec values beyond the safe message). */
export function specValidationError(issues: ValidationIssue[]): WorkflowApiError {
  const errs = issues.filter((i) => i.severity === 'error').slice(0, 25).map((i) => ({ code: i.code, severity: i.severity, message: safeMessage(i.message), ...(i.path ? { path: i.path } : {}) }))
  return workflowApiError('invalid_workflow_spec', 'the workflow spec failed validation', { issues: errs })
}

/** Validate a spec up front so the API can return rich issues (the runtime also
 *  re-validates). Returns null when valid. */
export function preflightSpec(spec: unknown): WorkflowApiError | null {
  const v = validateWorkflowSpec(spec)
  return v.valid ? null : specValidationError(v.issues)
}

// ── list query ─────────────────────────────────────────────────────────────────

export const MAX_LIST_LIMIT = 200
const DEFAULT_LIST_LIMIT = 50
const WORKFLOW_STATUSES = new Set(['draft', 'ready', 'running', 'blocked', 'completed', 'failed', 'cancelled'])

export function parseListQuery(search: URLSearchParams): { ok: true; value: { status?: string; limit: number; offset: number } } | { ok: false; error: WorkflowApiError } {
  const status = search.get('status') ?? undefined
  if (status !== undefined && !WORKFLOW_STATUSES.has(status)) return { ok: false, error: workflowApiError('invalid_request', 'invalid `status` filter') }
  let limit = DEFAULT_LIST_LIMIT
  const rawLimit = search.get('limit')
  if (rawLimit !== null) { const n = Number(rawLimit); if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) return { ok: false, error: workflowApiError('invalid_request', `\`limit\` must be an integer in [1, ${MAX_LIST_LIMIT}]`) }; limit = n }
  let offset = 0
  const rawOffset = search.get('offset')
  if (rawOffset !== null) { const n = Number(rawOffset); if (!Number.isInteger(n) || n < 0) return { ok: false, error: workflowApiError('invalid_request', '`offset` must be a non-negative integer') }; offset = n }
  return { ok: true, value: { status, limit, offset } }
}

// ── durable projections (no secrets; bounded) ────────────────────────────────────

export interface WorkflowSummary {
  workflow_id: string
  name: string
  status: string
  current_step_id: string | null
  current_round: number
  total_tasks: number
  total_failures: number
  created_at: string
  started_at: string | null
  updated_at: string
  terminal_at: string | null
  cancel_requested: boolean
}

export function toWorkflowSummary(r: WorkflowRecord): WorkflowSummary {
  return {
    workflow_id: r.workflow_id, name: r.workflow_name, status: r.status,
    current_step_id: r.current_step_id, current_round: r.current_round,
    total_tasks: r.total_tasks, total_failures: r.total_failures,
    created_at: r.created_at, started_at: r.started_at, updated_at: r.updated_at,
    terminal_at: r.terminal_at, cancel_requested: r.cancel_requested,
  }
}

/** A COMPACT, path-free revision projection: the observable state hash + kind (and,
 *  for Git, the head commit + dirty flag) — never the changed-files path list. */
export interface RevisionView { revision_kind: string; state_hash: string; dirty?: boolean; head_commit?: string | null; observed_at?: string }
export function toRevisionView(rev: unknown): RevisionView | null {
  if (!rev || typeof rev !== 'object') return null
  const r = rev as Record<string, unknown>
  if (typeof r.state_hash !== 'string' || typeof r.revision_kind !== 'string') return null
  const out: RevisionView = { revision_kind: r.revision_kind, state_hash: r.state_hash }
  if (r.revision_kind === 'git') { if (typeof r.dirty === 'boolean') out.dirty = r.dirty; out.head_commit = typeof r.head_commit === 'string' ? r.head_commit : null }
  if (typeof r.observed_at === 'string') out.observed_at = r.observed_at
  return out
}

/** Bounded, path-free workspace-lease projection for the snapshot. `status` surfaces
 *  release-pending (`release_requested`) and released state. Opaque routing keys
 *  (node_id / workspace_key) only — never a filesystem path, token, or credential. */
export interface WorkspaceLeaseView {
  workspace_lease_id: string; node_id: string; workspace_key: string; status: string
  base_revision: RevisionView | null; current_revision: RevisionView | null
  acquired_at: string | null; release_requested_at: string | null; released_at: string | null
}
export function toWorkspaceLeaseView(l: WorkflowWorkspaceLeaseRecord): WorkspaceLeaseView {
  return { workspace_lease_id: l.workspace_lease_id, node_id: l.node_id, workspace_key: l.workspace_key, status: l.status, base_revision: toRevisionView(l.base_revision), current_revision: toRevisionView(l.current_revision), acquired_at: l.acquired_at, release_requested_at: l.release_requested_at, released_at: l.released_at }
}

export interface StepExecutionView {
  step_execution_id: string
  step_id: string
  round: number
  attempt: number
  status: string
  task_id: string | null
  output: unknown
  error: unknown
  revision_before: RevisionView | null
  revision_after: RevisionView | null
  created_at: string
  started_at: string | null
  updated_at: string
  terminal_at: string | null
}

export function toStepExecutionView(s: StepExecutionRecord): StepExecutionView {
  return { step_execution_id: s.step_execution_id, step_id: s.step_id, round: s.round, attempt: s.attempt, status: s.status, task_id: s.task_id, output: s.output, error: s.error, revision_before: toRevisionView(s.revision_before), revision_after: toRevisionView(s.revision_after), created_at: s.created_at, started_at: s.started_at, updated_at: s.updated_at, terminal_at: s.terminal_at }
}

/** The full durable workflow snapshot (spec, inputs, context, step executions,
 *  current task, timestamps, cancel intent, terminal/blocked reason). Bounded; the
 *  underlying records are already size-bounded by the store. */
export function toWorkflowSnapshotView(
  record: WorkflowRecord,
  context: unknown,
  contextRevision: number,
  steps: StepExecutionRecord[],
  reason: { reason?: string } | null,
  leases: WorkflowWorkspaceLeaseRecord[] = [],
): Record<string, unknown> {
  const spec = record.spec as { description?: unknown } | null
  const currentStep = steps.find((s) => s.step_id === record.current_step_id && s.round === record.current_round)
  const leaseViews = leases.map(toWorkspaceLeaseView)
  return {
    ...toWorkflowSummary(record),
    description: spec && typeof spec === 'object' && typeof spec.description === 'string' ? spec.description : undefined,
    spec: record.spec,
    input_values: record.input_values,
    context,
    context_revision: contextRevision,
    step_executions: steps.map(toStepExecutionView),
    current_task: currentStep?.task_id ? { task_id: currentStep.task_id, step_execution_id: currentStep.step_execution_id } : undefined,
    // Bounded workspace-lease projection (Node is authoritative). `release_pending` is
    // true while any lease still awaits release after the workflow terminalized.
    workspace_leases: leaseViews,
    release_pending: leaseViews.some((l) => l.status === 'release_requested'),
    history: { complete: record.earliest_retained_sequence === 0, earliest_retained_sequence: record.earliest_retained_sequence },
    ...(reason?.reason ? { reason: reason.reason } : {}),
  }
}

/** Extract the stable reason from the last terminal/blocked workflow event (safe
 *  payload field only). */
export function reasonFromEvents(events: WorkflowEventRecord[]): { reason?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.event_type === 'workflow.failed' || e.event_type === 'workflow.blocked') {
      const p = e.payload as { reason?: unknown; limit?: unknown } | null
      if (p && typeof p === 'object') { const r = typeof p.reason === 'string' ? p.reason : typeof p.limit === 'string' ? `limit_${p.limit}` : undefined; return { reason: r } }
      return null
    }
    if (e.event_type === 'workflow.completed' || e.event_type === 'workflow.cancelled') return null
  }
  return null
}
