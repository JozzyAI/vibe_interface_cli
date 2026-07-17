/**
 * Record contracts for the durable control store — PURE types, a structured
 * error, and light identity/enum validators. No SQLite, no I/O.
 *
 * These records persist ONLY internal recovery/history data. They deliberately
 * EXCLUDE secrets: no Gateway/relay bearer tokens, no encryption keys, no native
 * agent credentials, no environment dumps, and no temporary prompt-file paths.
 */
import { WORKFLOW_EVENT_CONTRACT_VERSION, isStepScopedEvent, type WorkflowEventType } from '../workflow/contract.js'

export type ControlStoreErrorCode =
  | 'not_found'
  | 'revision_conflict'
  | 'duplicate'
  | 'event_conflict'
  | 'event_gap'
  | 'invalid_record'
  | 'corruption'
  | 'invalid_transition'
  | 'too_large'
  | 'forbidden_field'
  | 'unsupported_schema_version'
  | 'idempotency_conflict'
  | 'result_conflict'
  | 'closed'

/** Structured store error. `code` is stable; `message` never echoes payloads. */
export class ControlStoreError extends Error {
  constructor(public readonly code: ControlStoreErrorCode, message: string) { super(message); this.name = 'ControlStoreError' }
}

// ── terminal-state sets ──────────────────────────────────────────────────────
export const TASK_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
export const WORKFLOW_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']) // NOT blocked (resumable)
export const STEP_TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped', 'cancelled'])

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{0,63}$/

export const isSafeId = (s: unknown): s is string => typeof s === 'string' && SAFE_ID_RE.test(s)
export const isTaskEventType = (s: unknown): s is string => typeof s === 'string' && EVENT_TYPE_RE.test(s)
export const isWorkflowEventType = (s: unknown): s is WorkflowEventType => typeof s === 'string' && isWfEventName(s)

const WF_EVENT_NAMES = new Set<string>([
  'workflow.created', 'workflow.validated', 'workflow.started', 'step.started', 'step.task_created',
  'step.completed', 'step.failed', 'edge.selected', 'workflow.round_advanced',
  'workflow.blocked', 'workflow.completed', 'workflow.failed', 'workflow.cancelled',
  'workflow.paused', 'workflow.resumed',
])
function isWfEventName(s: string): boolean { return WF_EVENT_NAMES.has(s) }
export { isStepScopedEvent, WORKFLOW_EVENT_CONTRACT_VERSION }

// ── task records ─────────────────────────────────────────────────────────────

export interface TaskRecord {
  task_id: string
  revision: number
  node_id: string | null
  agent: string
  workspace_key: string | null
  permission_mode: string | null
  status: string
  remote_run_id: string | null
  /** Canonical user task input needed for recovery/history (bounded). NEVER a
   *  temporary prompt-file path. */
  input_text: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  terminal_at: string | null
  last_event_sequence: number
  earliest_retained_sequence: number
  terminal_event_recorded: boolean
  error_code: string | null
  error_message: string | null
  /** Machine-readable event-history completeness (survives restart). */
  history_incomplete: boolean
  /** Sanitized reason, e.g. `gateway_restart_without_node_replay`. */
  history_reason: string | null
  /** Greatest sequence durably consumed BEFORE the known-missing interval. */
  history_boundary_sequence: number | null
  /** Greatest durably-mapped NODE source cursor: NULL = unknown, -1 = known but
   *  nothing consumed, >=0 = a real source sequence. NOT the Gateway task cursor. */
  last_remote_event_sequence: number | null
  /** OPTIONAL client-supplied idempotency key (unique per non-null value). NOT the
   *  public task_id, NOT a credential, NOT a remote run id. */
  idempotency_key: string | null
  /** Deterministic digest of the normalized semantic request (excludes the key
   *  itself; never the raw prompt). Detects a same-key request whose meaning
   *  changed. */
  request_fingerprint: string | null
  /** Bounded projection of the durable AgentTaskResult status (NULL until the
   *  backend terminalizes; then 'available' | 'missing' | 'invalid'). */
  result_status: string | null
}

/** A durable task result row (the authoritative control result, keyed by the
 *  PUBLIC task_id). `result` is the validated envelope when status is 'available'. */
export interface TaskResultRecord {
  task_id: string
  result_status: string
  result: import('../lib/agent-task-result.js').AgentTaskResultV1 | null
}

/** Stable reason codes for an incomplete persisted event history. */
export type HistoryIncompleteReason =
  | 'gateway_restart_without_node_replay'
  | 'remote_source_cursor_unknown'
  | 'node_journal_truncated'

export interface CreateTaskInput {
  task_id: string
  node_id?: string | null
  agent: string
  workspace_key?: string | null
  permission_mode?: string | null
  status: string
  remote_run_id?: string | null
  input_text?: string | null
  metadata?: Record<string, unknown> | null
  /** Set ONLY through createTaskIdempotently. Non-idempotent creates leave both NULL. */
  idempotency_key?: string | null
  request_fingerprint?: string | null
}

/** Mutable task fields (identity fields are intentionally absent — immutable). */
export interface TaskPatch {
  status?: string
  remote_run_id?: string | null
  workspace_key?: string | null
  permission_mode?: string | null
  metadata?: Record<string, unknown> | null
  terminal_at?: string | null
  error_code?: string | null
  error_message?: string | null
}

export interface TaskEventInput {
  sequence: number
  event_type: string
  ts: string
  payload: unknown
  /** Optional NODE source sequence this canonical event maps to (NULL for
   *  Gateway-generated / non-Node events). Unique per task when present. */
  source_sequence?: number | null
}

export interface TaskEventRecord extends TaskEventInput { task_id: string; created_at: string }

// ── workflow records ─────────────────────────────────────────────────────────

export interface WorkflowRecord {
  workflow_id: string
  revision: number
  spec_version: string
  workflow_name: string
  spec: unknown
  status: string
  current_step_id: string | null
  current_round: number
  total_tasks: number
  total_failures: number
  started_at: string | null
  created_at: string
  updated_at: string
  terminal_at: string | null
  last_event_sequence: number
  context_revision: number
  earliest_retained_sequence: number
  /** Immutable validated workflow input values (bounded). NULL for legacy rows. */
  input_values: Record<string, unknown> | null
  /** Durable cancellation intent (set BEFORE remote task cancellation). */
  cancel_requested: boolean
}

export interface CreateWorkflowInput {
  workflow_id: string
  spec_version: string
  workflow_name: string
  spec: unknown
  status?: string
  current_step_id?: string | null
  current_round?: number
  input_values?: Record<string, unknown> | null
}

export interface WorkflowPatch {
  status?: string
  current_step_id?: string | null
  current_round?: number
  total_tasks?: number
  total_failures?: number
  started_at?: string | null
  terminal_at?: string | null
  cancel_requested?: boolean
}

export interface StepExecutionRecord {
  step_execution_id: string
  workflow_id: string
  step_id: string
  round: number
  attempt: number
  task_id: string | null
  revision: number
  status: string
  output: unknown
  error: unknown
  created_at: string
  started_at: string | null
  updated_at: string
  terminal_at: string | null
  /** workspace_lease_v1: the workspace revision observed BEFORE this step's task was
   *  created, and AFTER that task terminalized (a bounded WorkspaceRevision, or null). */
  revision_before: unknown
  revision_after: unknown
}

export interface CreateStepExecutionInput {
  step_execution_id: string
  workflow_id: string
  step_id: string
  round: number
  attempt: number
  task_id?: string | null
  status?: string
}

export interface StepExecutionPatch {
  status?: string
  task_id?: string | null
  output?: unknown
  error?: unknown
  started_at?: string | null
  terminal_at?: string | null
}

export interface WorkflowEventInput {
  sequence: number
  event_type: string
  ts: string
  step_execution_id?: string | null
  payload: unknown
}

/** A durable HUMAN PAUSE request (input / approval) gating a workflow step. At most
 *  one active request per step execution. Bounded; carries no secrets. */
export interface WorkflowHumanRequestRecord {
  request_id: string
  workflow_id: string
  step_execution_id: string
  kind: string          // 'input' | 'approval'
  prompt: string
  choices: string[] | null
  status: string        // 'pending' | 'answered' | 'approved' | 'rejected'
  response_value: string | null   // the answered input value (bounded); null for approval
  created_at: string
  responded_at: string | null
  updated_at: string
  revision: number
}

export interface CreateHumanRequestInput {
  request_id: string
  workflow_id: string
  step_execution_id: string
  kind: string
  prompt: string
  choices: string[] | null
}

/** An IMMUTABLE natural-language compiler WorkflowDraft. Content fields are frozen once
 *  finalized; only approval binds a materialized workflow (once). No secrets/tokens. */
export interface WorkflowDraftRecord {
  draft_id: string
  idempotency_key: string | null
  /** Hash of the NORMALIZED request + constraints (NO volatile inventory fields) —
   *  the compile-operation request identity, distinct from inventory provenance. */
  request_fingerprint: string | null
  compiler_task_id: string | null
  /** Bounded, safe compiler-task capability/permission summary (no secrets). */
  compiler_capability: unknown
  constraints: unknown
  inventory_snapshot: unknown
  inventory_hash: string | null
  spec: unknown
  input_values: unknown
  spec_hash: string | null
  policy_summary: unknown
  policy_summary_hash: string | null
  preview: unknown
  rationale: unknown
  warnings: unknown
  questions: unknown
  compiler_status: string   // pending | ready | needs_input | impossible | policy_denied
  validation_status: string // pending | valid | invalid
  approval_status: string   // unapproved | approved
  materialized_workflow_id: string | null
  created_at: string
  updated_at: string
}

/** Durable ControlStore PROJECTION of a Node workspace lease held by a workflow.
 *  The Node remains authoritative — this row supports recovery/inspection only.
 *  Never carries tokens/keys/paths; revisions are bounded WorkspaceRevision JSON. */
export interface WorkflowWorkspaceLeaseRecord {
  workspace_lease_id: string
  workflow_id: string
  node_id: string
  workspace_key: string
  mode: string
  status: string
  revision: number
  base_revision: unknown
  current_revision: unknown
  acquired_at: string | null
  release_requested_at: string | null
  released_at: string | null
  created_at: string
  updated_at: string
}

export interface WorkflowEventRecord extends Required<WorkflowEventInput> { workflow_id: string; created_at: string }

export interface WorkflowSnapshot {
  workflow: WorkflowRecord
  context: unknown
  context_revision: number
}

// ── light input validators (identity/enum/format only; sizes live in the store) ──

export function validateCreateTask(i: CreateTaskInput): void {
  if (!isSafeId(i.task_id)) throw new ControlStoreError('invalid_record', 'task.task_id is not a safe id')
  if (typeof i.agent !== 'string' || i.agent.trim() === '') throw new ControlStoreError('invalid_record', 'task.agent is required')
  if (typeof i.status !== 'string' || i.status === '') throw new ControlStoreError('invalid_record', 'task.status is required')
}

export function validateCreateWorkflow(i: CreateWorkflowInput): void {
  if (!isSafeId(i.workflow_id)) throw new ControlStoreError('invalid_record', 'workflow.workflow_id is not a safe id')
  if (typeof i.workflow_name !== 'string' || i.workflow_name === '') throw new ControlStoreError('invalid_record', 'workflow.workflow_name is required')
  if (typeof i.spec_version !== 'string' || i.spec_version === '') throw new ControlStoreError('invalid_record', 'workflow.spec_version is required')
}

export function validateCreateStepExecution(i: CreateStepExecutionInput): void {
  if (!isSafeId(i.step_execution_id)) throw new ControlStoreError('invalid_record', 'step.step_execution_id is not a safe id')
  if (!isSafeId(i.workflow_id)) throw new ControlStoreError('invalid_record', 'step.workflow_id is not a safe id')
  if (!isSafeId(i.step_id)) throw new ControlStoreError('invalid_record', 'step.step_id is not a safe id')
  if (!Number.isInteger(i.round) || i.round < 1) throw new ControlStoreError('invalid_record', 'step.round must be a positive integer')
  if (!Number.isInteger(i.attempt) || i.attempt < 1) throw new ControlStoreError('invalid_record', 'step.attempt must be a positive integer')
}
