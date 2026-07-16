/**
 * Canonical Agent Task Contract (Vibe Agent Gateway, layer 1).
 *
 * This is the stable, agent-neutral EXTERNAL schema that the gateway's future
 * REST + SSE surface — and later the A2A and MCP adapters — all map onto. It is
 * PURE: types plus total mapping functions, and NOTHING ELSE. There is
 * deliberately NO HTTP listener, NO bearer-token logic, NO SSE server, NO
 * database, and NO scheduler/runner/event-bus here.
 *
 * The existing run lifecycle remains the single source of truth:
 *   - `RunRecord`  → projected to a public `Task`      (runRecordToTask)
 *   - `RunStatus`  → projected to a public `TaskStatus` (runStatusToTaskStatus)
 *   - `RunEvent`   → projected to a public `TaskEvent`  (runEventToTaskEvent)
 *   - `VibeError` / `RunErrorCode` → mapped to a neutral `ApiError`
 *
 * Backend-specific identifiers (tmux session ids, child PIDs, workspace paths,
 * local AES keys, prompt-file paths) are NEVER exposed — a Task carries only the
 * opaque `task_id` (== `run_id`) and safe projected fields.
 */
import type { RunRecord, RunStatus, RunEvent, AgentBackend, PermissionMode } from '../types.js'
import type { VibeError } from '../types.js'
import type { RunErrorCode } from './run-error.js'

/** Bumped when the wire shape changes incompatibly. Carried on every resource. */
export const TASK_CONTRACT_VERSION = 1

// ── Task identity ────────────────────────────────────────────────────────────
//
// task_id == run_id (1:1). A `run_id` is an internally-generated opaque token
// (e.g. `run_xxxx`) — NOT a process, tmux session, or workspace identifier — so
// exposing it as the public task id leaks nothing. These named mappers make the
// rule explicit and localize any future change (e.g. a separate id space).

export type TaskId = string

export function taskIdForRun(runId: string): TaskId {
  return runId
}

export function runIdForTask(taskId: TaskId): string {
  return taskId
}

export function isValidTaskId(value: unknown): value is TaskId {
  return typeof value === 'string' && value.length > 0
}

// ── Task status + legal transitions ──────────────────────────────────────────
//
// `starting` is gateway-synthesized (accepted, awaiting the node's first
// `status:running`); the status-only mapper never emits it.
//
// DEFERRED (not in this enum):
//   - `timed_out`: the runtime has no structured timeout reason today (a run
//     timeout surfaces as a plain `failed` with a diagnostic string and
//     `failure_reason:'unknown'`). Inferring `timed_out` by regex-matching that
//     string would risk the Task resource and the SSE terminal event disagreeing,
//     so a timed-out run projects to `failed` for contract v1. `timed_out` (and a
//     matching `task.timed_out` SSE terminal event) will be added together with a
//     structured runtime timeout reason so both surfaces agree.
//   - `input_required` / `approval_required`: no runtime path currently produces
//     or PRESERVES a paused/waiting state — `status:'blocked'` is never written
//     today, and `approval_required` run events are informational (the run does
//     not halt). They will be added when interactive tasks land.

export type TaskStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'queued', 'starting', 'running', 'completed', 'failed', 'cancelled',
]

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'completed', 'failed', 'cancelled',
]

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}

/** Legal forward transitions. Terminal states have no outgoing transitions. */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['starting', 'running', 'cancelled', 'failed'],
  starting: ['running', 'completed', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export function isLegalTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

/**
 * Status-only projection of `RunStatus`. `blocked` maps to `running` because no
 * runtime path preserves a paused state today (see the DEFERRED note above).
 * Never returns `starting` (gateway-synthesized). A timed-out run projects to
 * `failed` in v1 (see the `timed_out` DEFERRED note).
 */
export function runStatusToTaskStatus(status: RunStatus): TaskStatus {
  switch (status) {
    case 'queued': return 'queued'
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'stopped': return 'cancelled'
    case 'cancelled': return 'cancelled'
    case 'blocked': return 'running'
  }
}

// ── Task resource ────────────────────────────────────────────────────────────

export interface TaskResult {
  final_agent?: string
  switched?: boolean
  exit_code?: number
}

export interface TaskError {
  message: string
  reason?: string
  recoverable?: boolean
  exit_code?: number
}

export interface Task {
  task_id: TaskId
  agent: AgentBackend
  node_id: string
  status: TaskStatus
  created_at: string
  updated_at: string
  result?: TaskResult
  error?: TaskError
  metadata?: Record<string, unknown>
  contract_version: number
}

/**
 * Project a `RunRecord` to a public `Task`. Intentionally omits every
 * backend-specific field — session_id, child_pid, workspace_path, prompt_file,
 * repo_url/branch, and all *_aes_key values are never copied. A run that timed
 * out projects to `failed` in v1 (see the `timed_out` DEFERRED note).
 */
export function runRecordToTask(record: RunRecord): Task {
  const status = runStatusToTaskStatus(record.status)
  const task: Task = {
    task_id: taskIdForRun(record.run_id),
    agent: record.final_agent ?? record.agent,
    node_id: record.node_id,
    status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    contract_version: TASK_CONTRACT_VERSION,
  }
  if (status === 'completed') {
    const result: TaskResult = {}
    if (record.final_agent) result.final_agent = record.final_agent
    if (record.switched) result.switched = record.switched
    if (record.exit_code !== undefined) result.exit_code = record.exit_code
    task.result = result
  }
  if (status === 'failed') {
    const err: TaskError = { message: record.error ?? 'run failed' }
    if (record.failure_reason) err.reason = record.failure_reason
    if (record.recoverable !== undefined) err.recoverable = record.recoverable
    if (record.exit_code !== undefined) err.exit_code = record.exit_code
    task.error = err
  }
  if (record.metadata) task.metadata = record.metadata
  return task
}

// ── Task creation request ────────────────────────────────────────────────────
//
// Only the fields the approved gateway arc needs. Deliberately excludes
// approvals, follow-up messages, artifacts, file transfer, and multi-user
// ownership.

export interface CreateTaskRequest {
  agent: string
  node_id?: string
  input: { text: string }
  // Gateway v1 honours only `workspace.workspace_key` and
  // `execution.permission_mode`. Other workspace/execution fields
  // (path/repo_url/branch, timeout_seconds) are DEFERRED and FAIL CLOSED —
  // validateCreateTaskRequest rejects them rather than silently dropping them.
  workspace?: {
    workspace_key?: string
  }
  execution?: {
    permission_mode?: PermissionMode
  }
  metadata?: Record<string, unknown>
  /** OPTIONAL client-supplied idempotency key. Retrying the SAME creation request
   *  with the SAME key returns the SAME durable task instead of starting a second
   *  run (the future WorkflowRuntime will pass a step_execution_id here). It is a
   *  bounded safe identifier — NOT a task id, NOT a credential, NEVER forwarded to
   *  the relay/node/backend. */
  idempotency_key?: string
  /** OPTIONAL workspace lease id (workspace_lease_v1) authorizing this run against
   *  a Node's active workspace lease. Bounded safe identifier, DISTINCT from
   *  task_id / remote_run_id / idempotency_key / workflow_id. Participates in the
   *  request fingerprint. Reaches the Node ONLY for authorization — NEVER forwarded
   *  to the provider (prompt/metadata/env) and never logged. */
  workspace_lease_id?: string
}

/**
 * A valid idempotency key: starts alphanumeric, then alphanumeric/`.`/`_`/`:`/`-`,
 * max 128 chars. Deliberately identical to the durable store's safe-id shape so a
 * WorkflowStepExecutionRef.step_execution_id is a valid key. Rejects whitespace,
 * control characters, path separators (`/`, `\`), and arbitrary Unicode.
 */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Opaque workspace key: an identifier the runtime uses to key a run's workspace —
 * NOT a filesystem path. Must start alphanumeric, then alphanumeric/`.`/`_`/`-`,
 * max 128 chars. This rejects `/`, `\`, absolute paths, leading-`.` (so `.`/`..`
 * and traversal), control characters, empty, and oversized keys.
 */
export const WORKSPACE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Workspace/execution fields recognised but DEFERRED in Gateway v1 (fail closed). */
const DEFERRED_WORKSPACE_FIELDS = ['path', 'repo_url', 'branch'] as const
const DEFERRED_EXECUTION_FIELDS = ['timeout_seconds'] as const

/**
 * True only for a real JSON object — rejects `null`, arrays, and primitives.
 * Used for every object-shaped field so an array (e.g. `metadata: []`) can never
 * be silently accepted.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pure request validation → the parsed request, or a neutral `invalid_request` ApiError. */
export function validateCreateTaskRequest(
  body: unknown,
  ts: string = new Date().toISOString(),
): { ok: true; value: CreateTaskRequest } | { ok: false; error: ApiError } {
  const fail = (message: string): { ok: false; error: ApiError } =>
    ({ ok: false, error: apiError('invalid_request', message, { ts }) })

  if (!isPlainObject(body)) return fail('request body must be a JSON object')
  const b = body

  if (typeof b.agent !== 'string' || b.agent.trim() === '') return fail('`agent` is required (non-empty string)')
  if (b.node_id !== undefined && typeof b.node_id !== 'string') return fail('`node_id` must be a string')

  if (!isPlainObject(b.input)) return fail('`input` must be an object')
  const input = b.input
  if (typeof input.text !== 'string' || input.text.trim() === '') return fail('`input.text` is required (non-empty string)')

  let exec: Record<string, unknown> | undefined
  if (b.execution !== undefined) {
    if (!isPlainObject(b.execution)) return fail('`execution` must be an object')
    exec = b.execution
    // Fail closed on deferred execution fields (no runtime implementation in v1).
    for (const f of DEFERRED_EXECUTION_FIELDS) {
      if (exec[f] !== undefined) return fail(`\`execution.${f}\` is not supported by Agent Gateway v1 (reserved/deferred)`)
    }
    if (exec.permission_mode !== undefined && exec.permission_mode !== 'default' && exec.permission_mode !== 'unsafe-skip') {
      return fail('`execution.permission_mode` must be "default" or "unsafe-skip"')
    }
  }

  let workspace: Record<string, unknown> | undefined
  if (b.workspace !== undefined) {
    if (!isPlainObject(b.workspace)) return fail('`workspace` must be an object')
    workspace = b.workspace
    // Fail closed on deferred workspace fields (not mapped to execution in v1).
    for (const f of DEFERRED_WORKSPACE_FIELDS) {
      if (workspace[f] !== undefined) return fail(`\`workspace.${f}\` is not supported by Agent Gateway v1 (reserved/deferred)`)
    }
    // workspace_key must be an opaque safe key — never a path. The submitted value
    // is NEVER echoed back in the error (defense in depth against traversal).
    if (workspace.workspace_key !== undefined) {
      if (typeof workspace.workspace_key !== 'string' || !WORKSPACE_KEY_RE.test(workspace.workspace_key)) {
        return fail('`workspace.workspace_key` must be an opaque key matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ (not a path)')
      }
    }
  }

  if (b.metadata !== undefined && !isPlainObject(b.metadata)) return fail('`metadata` must be an object')

  // Optional idempotency key — a FIRST-CLASS validated field (never hidden inside
  // metadata). Fail closed on a malformed/oversized key (invalid_request, not an
  // internal error). The submitted value is never echoed in the error.
  if (b.idempotency_key !== undefined) {
    if (typeof b.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(b.idempotency_key)) {
      return fail('`idempotency_key` must be a bounded safe identifier matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ (no whitespace, control characters, path separators, or arbitrary Unicode)')
    }
  }

  // Optional workspace lease id — a bounded safe opaque identifier, DISTINCT from
  // task_id/remote_run_id/idempotency_key/workflow_id. Same shape rule as the
  // idempotency key; the submitted value is never echoed. It reaches the Node for
  // authorization only and is NEVER forwarded to the provider.
  if (b.workspace_lease_id !== undefined) {
    if (typeof b.workspace_lease_id !== 'string' || !IDEMPOTENCY_KEY_RE.test(b.workspace_lease_id)) {
      return fail('`workspace_lease_id` must be a bounded safe identifier matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ (no whitespace, control characters, path separators, or arbitrary Unicode)')
    }
  }

  const value: CreateTaskRequest = { agent: b.agent, input: { text: input.text } }
  if (typeof b.node_id === 'string') value.node_id = b.node_id
  if (workspace && typeof workspace.workspace_key === 'string') value.workspace = { workspace_key: workspace.workspace_key }
  if (exec && exec.permission_mode) value.execution = { permission_mode: exec.permission_mode as PermissionMode }
  if (isPlainObject(b.metadata)) value.metadata = b.metadata
  if (typeof b.idempotency_key === 'string') value.idempotency_key = b.idempotency_key
  if (typeof b.workspace_lease_id === 'string') value.workspace_lease_id = b.workspace_lease_id
  return { ok: true, value }
}

// ── Event envelope ───────────────────────────────────────────────────────────
//
// Versionable, agent-neutral, monotonic `seq` per task. The taxonomy is kept
// minimal and mappable from existing RunEvent data. `task.created` and
// `agent.output.completed` are lifecycle bookends SYNTHESIZED by the emitter
// (the future gateway), not produced by the RunEvent mapper. Run events that
// have no reliable neutral mapping yet (tool_call, pr_created, approval_*, error)
// are dropped from this stream for now and will get dedicated event types when
// the underlying data model supports them; failure detail remains available on
// the Task resource (`error`).

export type TaskEventType =
  | 'task.created'
  | 'task.started'
  | 'agent.output.delta'
  | 'agent.output.completed'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'

export interface TaskEvent<P = Record<string, unknown>> {
  seq: number
  task_id: TaskId
  type: TaskEventType
  ts: string
  payload: P
  contract_version: number
}

/**
 * Project a single `RunEvent` to a `TaskEvent`, or `null` if it has no neutral
 * mapping yet. `seq` is supplied by the emitter (monotonic per task). Only
 * `status` and `log` run events map today.
 */
export function runEventToTaskEvent(event: RunEvent, seq: number): TaskEvent | null {
  const base = (type: TaskEventType, payload: Record<string, unknown>): TaskEvent => ({
    seq, task_id: taskIdForRun(event.run_id), type, ts: event.ts, payload, contract_version: TASK_CONTRACT_VERSION,
  })
  switch (event.type) {
    case 'status':
      switch (event.status) {
        case 'running': return base('task.started', {})
        case 'completed': return base('task.completed', {})
        case 'failed': return base('task.failed', {})
        case 'stopped':
        case 'cancelled': return base('task.cancelled', {})
        default: return null // queued / blocked: no dedicated stream event
      }
    case 'log':
      return base('agent.output.delta', { stream: event.stream, text: event.message })
    default:
      return null // tool_call / pr_created / approval_* / error: deferred
  }
}

// ── Agent discovery ──────────────────────────────────────────────────────────
//
// Conservative: id + optional node + availability, and `streaming` only for
// agents we KNOW stream. No invented rich capabilities (tools/workspace/etc.).

/** Agent ids known to stream events over the run event log. */
const STREAMING_AGENTS = new Set<string>(['mock', 'claude-code', 'codex', 'opencode'])

export interface AgentDescriptor {
  id: string
  node_id?: string
  available: boolean
  streaming?: boolean
}

/**
 * Build descriptors from a node's advertised agent id list (from `resolveAgents`
 * locally, or `VibeNode.agents` over the relay). `streaming` is set only when
 * known; unknown ids omit it rather than guessing.
 */
export function buildAgentDescriptors(agentIds: string[], opts: { node_id?: string } = {}): AgentDescriptor[] {
  return agentIds.map((id) => {
    const d: AgentDescriptor = { id, available: true }
    if (opts.node_id) d.node_id = opts.node_id
    if (STREAMING_AGENTS.has(id)) d.streaming = true
    return d
  })
}

// ── Error contract (HTTP-neutral) ────────────────────────────────────────────

export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'agent_unavailable'
  | 'node_offline'
  | 'service_unavailable'
  | 'task_not_found'
  | 'invalid_state_transition'
  | 'cancellation_conflict'
  | 'idempotency_conflict'
  | 'workspace_lease_unsupported'
  | 'internal_error'

// Only the opaque `task_id` is exposed on the wire — the internal `run_id` is
// never surfaced in a public error (task_id == run_id internally, but callers
// see one identifier only).
export interface ApiError {
  error: true
  code: ApiErrorCode
  message: string
  retryable: boolean
  task_id?: TaskId
  details?: Record<string, unknown>
  ts: string
}

/** Whether each error class is worth a caller retry (default `retryable`). */
const RETRYABLE: Record<ApiErrorCode, boolean> = {
  invalid_request: false,
  unauthorized: false,
  agent_unavailable: false,
  node_offline: true,
  service_unavailable: true,
  task_not_found: false,
  invalid_state_transition: false,
  cancellation_conflict: false,
  idempotency_conflict: false,
  workspace_lease_unsupported: false,
  internal_error: true,
}

export interface ApiErrorOpts {
  retryable?: boolean
  task_id?: TaskId
  details?: Record<string, unknown>
  ts?: string
}

export function apiError(code: ApiErrorCode, message: string, opts: ApiErrorOpts = {}): ApiError {
  const err: ApiError = {
    error: true,
    code,
    message,
    retryable: opts.retryable ?? RETRYABLE[code],
    ts: opts.ts ?? new Date().toISOString(),
  }
  if (opts.task_id) err.task_id = opts.task_id
  if (opts.details) err.details = opts.details
  return err
}

/** Suggested HTTP status for a REST adapter. The `ApiError` schema itself is transport-neutral. */
export function apiErrorHttpStatus(code: ApiErrorCode): number {
  switch (code) {
    case 'invalid_request': return 400
    case 'unauthorized': return 401
    case 'task_not_found': return 404
    case 'cancellation_conflict': return 409
    case 'invalid_state_transition': return 409
    case 'idempotency_conflict': return 409
    case 'agent_unavailable': return 422
    case 'workspace_lease_unsupported': return 422
    case 'node_offline': return 503
    case 'service_unavailable': return 503
    case 'internal_error': return 500
  }
}

const VIBE_ERROR_MAP: Record<VibeError['code'], ApiErrorCode> = {
  user_error: 'invalid_request',
  not_found: 'task_not_found',
  backend_error: 'internal_error',
  read_only: 'invalid_request',
  node_not_found: 'node_offline',
  agent_not_supported: 'agent_unavailable',
  no_runner_available: 'agent_unavailable',
}

/**
 * Map a legacy `VibeError` (`src/types.ts`) into the neutral `ApiError`. A
 * `VibeError.run_id` is converted through `taskIdForRun` and exposed as
 * `task_id` — the internal `run_id` never reaches the wire.
 */
export function vibeErrorToApiError(err: VibeError): ApiError {
  return apiError(VIBE_ERROR_MAP[err.code], err.message, {
    ts: err.ts,
    ...(err.run_id ? { task_id: taskIdForRun(err.run_id) } : {}),
  })
}

const RUN_ERROR_MAP: Record<RunErrorCode, ApiErrorCode> = {
  // The public code never exposes "relay" — an unreachable relay is a generic
  // service outage (retryable), distinct from a specific node being offline.
  relay_unavailable: 'service_unavailable',
  node_offline: 'node_offline',
  unauthorized: 'unauthorized',
  run_not_found: 'task_not_found',
  agent_not_supported: 'agent_unavailable',
  already_terminal: 'cancellation_conflict',
  remote_error: 'internal_error',
  unknown_error: 'internal_error',
}

/** Map a remote `RunErrorCode` (`src/lib/run-error.ts`) into the neutral `ApiError`. */
export function runErrorToApiError(code: RunErrorCode, message: string, opts: ApiErrorOpts = {}): ApiError {
  return apiError(RUN_ERROR_MAP[code], message, opts)
}
