/**
 * The async `ControlStore` interface — the ONLY contract the rest of the system
 * should depend on. The SQLite driver is hidden behind this so it can be replaced
 * later. Methods are asynchronous even though the current backend is synchronous.
 *
 * NOTE: this PR builds the persistence foundation ONLY. Nothing here is wired into
 * the running Agent Gateway, workflow runtime, or any HTTP/MCP surface yet.
 */
import type {
  TaskRecord, CreateTaskInput, TaskPatch, TaskEventInput, TaskEventRecord,
  WorkflowRecord, CreateWorkflowInput, WorkflowPatch, StepExecutionRecord,
  CreateStepExecutionInput, StepExecutionPatch, WorkflowEventInput, WorkflowEventRecord,
  WorkflowSnapshot, WorkflowWorkspaceLeaseRecord, WorkflowHumanRequestRecord, CreateHumanRequestInput,
  WorkflowDraftRecord,
  WorkflowBuilderSessionRecord, WorkflowBuilderMessageRecord, WorkflowBuilderSessionSummary,
} from './records.js'

/** Durable persistence for the Conversational Workflow Builder. Sessions + an
 *  append-only message log; every conversational turn's assistant message + current-
 *  draft pointer + revision bump land ATOMICALLY (`completeBuilderTurn`), and a turn
 *  resubmitted with the same `turn_key` is deduplicated (idempotent). The builder
 *  NEVER reimplements the compiler — it only reads/writes these rows + drafts. */
export interface WorkflowBuilderStore {
  /** Create-or-return an ACTIVE session by its stable id (revision starts at 1). */
  createBuilderSession(input: { builder_session_id: string; title: string; source_workflow_id?: string | null; compiler_agent?: string | null; compiler_node_id?: string | null }): Promise<WorkflowBuilderSessionRecord>
  getBuilderSession(builderSessionId: string): Promise<WorkflowBuilderSessionRecord | null>
  listBuilderSessions(page?: { limit?: number; offset?: number }): Promise<WorkflowBuilderSessionSummary[]>
  /** Ordered (by sequence) full message history for a session. */
  listBuilderMessages(builderSessionId: string): Promise<WorkflowBuilderMessageRecord[]>
  /** Look up the messages a keyed turn already produced (for idempotent replay /
   *  crash recovery). Returns nulls when the turn has not (yet) written that role. */
  findBuilderTurn(builderSessionId: string, turnKey: string): Promise<{ user: WorkflowBuilderMessageRecord | null; assistant: WorkflowBuilderMessageRecord | null }>
  /** Append the user message durably BEFORE the compiler runs. Append-only (next
   *  sequence); does NOT change the session revision. Idempotent on a non-null turn_key
   *  (a resubmit returns the existing user message). Rejects a non-active session. */
  appendBuilderUserMessage(builderSessionId: string, input: { content: string; turn_key?: string | null }): Promise<{ message: WorkflowBuilderMessageRecord; replay: boolean }>
  /** ATOMICALLY finish a turn: append the assistant message (next sequence) and advance
   *  the session's current draft pointer + revision (+1) — one transaction, so there is
   *  never an assistant message without its draft-pointer update. Optimistic: fails
   *  `builder_revision_conflict` when `expectedRevision` != the session's current
   *  revision. Idempotent on a non-null turn_key (a completed turn replays with no
   *  writes and no second revision increment). Rejects a non-active session. */
  completeBuilderTurn(builderSessionId: string, expectedRevision: number, input: { assistant: { content: string; draft_id?: string | null; spec_hash?: string | null; metadata?: Record<string, unknown> | null; turn_key?: string | null }; current_draft_id: string | null; current_spec_hash: string | null }): Promise<{ session: WorkflowBuilderSessionRecord; message: WorkflowBuilderMessageRecord; replay: boolean }>
  /** Idempotently archive a session (already archived → returned unchanged). */
  archiveBuilderSession(builderSessionId: string): Promise<WorkflowBuilderSessionRecord>
}

/** Durable IMMUTABLE compiler WorkflowDraft persistence — the ONLY store surface the
 *  Workflow Compiler depends on (it never touches the relay/Node/runtime). */
export interface WorkflowDraftStore {
  /** Create-or-return a draft by its stable draft_id. Captures ONE inventory snapshot
   *  + the request fingerprint at creation; a retry returns the existing draft (and
   *  never re-snapshots). `idempotency_key` is the caller's compile-operation key (null
   *  when unkeyed → a new operation each call). */
  createDraft(input: { draft_id: string; idempotency_key: string | null; request_fingerprint: string; constraints: unknown; inventory_snapshot: unknown; inventory_hash: string }): Promise<{ draft: WorkflowDraftRecord; created: boolean }>
  /** Bind the compiler Agent Task + safe capability summary once (immutable). */
  bindDraftCompilerTask(draftId: string, taskId: string, capability?: unknown): Promise<void>
  /** Finalize the draft content (first finalize wins; a finalized draft is immutable). */
  finalizeDraft(draftId: string, patch: { compiler_status: string; validation_status: string; spec?: unknown; input_values?: unknown; spec_hash?: string | null; policy_summary?: unknown; policy_summary_hash?: string | null; preview?: unknown; rationale?: unknown; warnings?: unknown; questions?: unknown }): Promise<WorkflowDraftRecord>
  getDraft(draftId: string): Promise<WorkflowDraftRecord | null>
  getDraftByIdempotencyKey(key: string): Promise<WorkflowDraftRecord | null>
  /** Bind approval + the materialized workflow id once (idempotent). */
  approveDraftWithWorkflow(draftId: string, workflowId: string): Promise<WorkflowDraftRecord>
}

/** A workflow event without a `sequence` — the store assigns the next contiguous
 *  sequence when it appends the event inside a runtime composite. */
export type WorkflowEventDraft = Omit<WorkflowEventInput, 'sequence'>

/**
 * SYNCHRONOUS task-persistence facade used by the Agent Gateway hot path, where
 * an event MUST be durably appended BEFORE it is published to SSE subscribers.
 * The concrete SQLite backend is synchronous, so these can't be lost to an
 * unresolved promise between "append" and "publish". Kept narrow so the gateway
 * depends only on what it needs (and it can be faked in tests).
 */
export interface GatewayTaskStore {
  /** Atomically persist a new task record + its `task.created` event. */
  createTaskDurable(input: CreateTaskInput, createdEvent: TaskEventInput): TaskRecord
  /** Look up a durable task by its client-supplied idempotency key (null if none).
   *  A read-only pre-check so an idempotent REPLAY can be served WITHOUT reserving
   *  an active slot. */
  getTaskByIdempotencyKey(key: string): TaskRecord | null
  /**
   * Atomic create-or-return keyed by `input.idempotency_key` (which MUST be set).
   * In ONE transaction: look up the key; if absent, create the durable task +
   * `task.created` and return `{ created: true }`; if present with the SAME
   * `request_fingerprint`, return the existing task `{ created: false }` WITHOUT a
   * second task or event. A present key with a DIFFERENT fingerprint throws
   * `idempotency_conflict`. SQLite's partial unique index is the FINAL authority —
   * a concurrent cross-connection insert of the same key resolves to `created:false`
   * (or a conflict), never two durable tasks. Only the `created:true` caller may
   * start execution.
   */
  createTaskIdempotently(input: CreateTaskInput, createdEvent: TaskEventInput): { record: TaskRecord; created: boolean }
  /** Append an accepted canonical event (idempotent/gap-checked) BEFORE publish. */
  appendTaskEventDurable(taskId: string, event: TaskEventInput): void
  updateTaskDurable(taskId: string, expectedRevision: number, patch: TaskPatch): TaskRecord
  /** Atomically persist terminal status + exactly one terminal event. */
  terminalizeTaskDurable(taskId: string, expectedRevision: number, patch: TaskPatch, terminalEvent: TaskEventInput): TaskRecord
  /**
   * Atomically persist the durable AgentTaskResult, the terminal task status, and
   * exactly one terminal event — the ordering guarantee that a terminal task never
   * loses its final output. Idempotent: a re-run with the same result is a no-op;
   * a CONFLICTING result content is `result_conflict`. The result is NEVER derived
   * from event history. `result` is null when `resultStatus` is 'missing'/'invalid'.
   */
  terminalizeTaskWithResultDurable(taskId: string, expectedRevision: number, patch: TaskPatch, terminalEvent: TaskEventInput, resultStatus: string, result: import('../lib/agent-task-result.js').AgentTaskResultV1 | null): TaskRecord
  /** Persist/overwrite the durable task result idempotently (create-or-return by
   *  content). Exact duplicate → applied:false; conflicting content → result_conflict.
   *  Also updates the `tasks.result_status` projection. */
  persistTaskResultDurable(taskId: string, resultStatus: string, result: import('../lib/agent-task-result.js').AgentTaskResultV1 | null): { applied: boolean }
  /** Read the durable task result (revalidated on read; malformed → corruption). */
  getTaskResultDurable(taskId: string): import('./records.js').TaskResultRecord | null
  getTaskRecord(taskId: string): TaskRecord | null
  /** Non-terminal persisted tasks (for restart recovery). */
  listNonTerminalTasks(): TaskRecord[]
  loadTaskEvents(taskId: string): TaskEventRecord[]
  latestTaskEventSequence(taskId: string): number
  /** Mark event history incomplete at a persisted boundary (idempotent; earliest
   *  boundary wins). Never consumes an event sequence or changes next_event_id. */
  markTaskHistoryIncomplete(taskId: string, reason: string, boundarySequence: number): void
  /** Clear the incomplete marker after a VERIFIED gap-free catch-up (or a future
   *  Node journal). */
  clearTaskHistoryIncomplete(taskId: string): void
  /** Initialize the NODE source cursor to -1 (known, nothing consumed) for a
   *  replay-capable remote task — only if it is currently NULL (unknown). */
  initReplayCursor(taskId: string): void
  /**
   * Atomically ingest ONE Node source event: map it to a canonical TaskEvent at
   * the next Gateway sequence, record its `source_sequence`, advance the source
   * cursor, and (if terminal) set terminal state — all in one transaction. The
   * NODE source sequence is NEVER used as the Gateway TaskEvent sequence. Returns
   * `applied: false` for an exact idempotent duplicate (nothing published). A
   * source sequence beyond next-expected is `event_gap`; a conflicting re-map is
   * `event_conflict` — neither is normalized.
   */
  ingestSourceEventDurable(taskId: string, sourceSequence: number, event: IngestSourceEvent): { record: TaskRecord; applied: boolean; canonicalSequence: number | null }
  /** Advance the source cursor for a source event that maps to NO canonical
   *  TaskEvent (so the next source event is not a false gap). Same next-expected /
   *  gap rules; no canonical event is appended and nothing is published. */
  advanceSourceCursor(taskId: string, sourceSequence: number): { applied: boolean }
  closeSync(): void
}

/** A Node source event offered for canonical ingestion. The store assigns the
 *  Gateway sequence; the caller declares terminality/status/error. */
export interface IngestSourceEvent {
  event_type: string
  ts: string
  payload: unknown
  terminal?: boolean
  status?: string
  error_code?: string | null
  error_message?: string | null
}

export interface Pagination { limit?: number; offset?: number }
export interface TaskFilters { status?: string; node_id?: string }
export interface WorkflowFilters { status?: string }

export interface HealthCheck { ok: boolean; schema_version: number; foreign_keys: boolean; journal_mode: string; busy_timeout: number }
export interface CleanupResult { removed: number }

export interface ControlStore extends WorkflowDraftStore, WorkflowBuilderStore {
  // lifecycle
  migrate(): Promise<number>
  healthCheck(): Promise<HealthCheck>
  close(): Promise<void>

  // tasks
  createTask(input: CreateTaskInput): Promise<TaskRecord>
  getTask(taskId: string): Promise<TaskRecord | null>
  /** Read the durable AgentTaskResult for a task (revalidated on read; null if none). */
  getTaskResult(taskId: string): Promise<import('./records.js').TaskResultRecord | null>
  updateTask(taskId: string, expectedRevision: number, patch: TaskPatch): Promise<TaskRecord>
  listTasks(filters?: TaskFilters, page?: Pagination): Promise<TaskRecord[]>
  deleteTask(taskId: string): Promise<void> // retention/cleanup only
  appendTaskEvent(taskId: string, event: TaskEventInput): Promise<void>
  listTaskEvents(taskId: string, afterSequence?: number, limit?: number): Promise<TaskEventRecord[]>
  getLatestTaskEventSequence(taskId: string): Promise<number>

  // workflows
  createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord>
  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>
  updateWorkflow(workflowId: string, expectedRevision: number, patch: WorkflowPatch): Promise<WorkflowRecord>
  listWorkflows(filters?: WorkflowFilters, page?: Pagination): Promise<WorkflowRecord[]>
  createStepExecution(input: CreateStepExecutionInput): Promise<StepExecutionRecord>
  getStepExecution(stepExecutionId: string): Promise<StepExecutionRecord | null>
  /** Record (idempotently, once) when the runtime began awaiting a terminal step task's
   *  durable result ingestion — a restart-safe deadline for `task_result_timeout`. */
  markStepAwaitingResult(stepExecutionId: string, ts: string): Promise<StepExecutionRecord>
  updateStepExecution(stepExecutionId: string, expectedRevision: number, patch: StepExecutionPatch): Promise<StepExecutionRecord>
  listStepExecutions(workflowId: string): Promise<StepExecutionRecord[]>
  appendWorkflowEvent(workflowId: string, event: WorkflowEventInput): Promise<void>
  listWorkflowEvents(workflowId: string, afterSequence?: number, limit?: number): Promise<WorkflowEventRecord[]>
  saveWorkflowContext(workflowId: string, expectedContextRevision: number, context: unknown): Promise<number>
  getWorkflowSnapshot(workflowId: string): Promise<WorkflowSnapshot | null>

  // atomic composites (store-level transactions; NOT runtime orchestration)
  createTaskWithCreatedEvent(input: CreateTaskInput, event: TaskEventInput): Promise<TaskRecord>
  terminalizeTask(taskId: string, expectedRevision: number, patch: TaskPatch, terminalEvent: TaskEventInput): Promise<TaskRecord>
  startWorkflowStep(step: CreateStepExecutionInput, workflowExpectedRevision: number, workflowPatch: WorkflowPatch, event: WorkflowEventInput): Promise<{ step: StepExecutionRecord; workflow: WorkflowRecord }>
  bindStepTask(stepExecutionId: string, stepExpectedRevision: number, taskId: string, workflowId: string, workflowExpectedRevision: number, event: WorkflowEventInput): Promise<{ step: StepExecutionRecord; workflow: WorkflowRecord }>
  checkpointWorkflow(workflowId: string, workflowExpectedRevision: number, patch: WorkflowPatch, contextExpectedRevision: number | null, context: unknown | undefined, event: WorkflowEventInput): Promise<WorkflowRecord>

  // ── workflow-runtime composites (atomic; idempotent for crash recovery) ──────
  // These auto-assign the next contiguous workflow event sequence, so callers pass
  // event DRAFTS (no `sequence`). Each is a single transaction; the idempotency
  // guards make a re-run after a crash a safe no-op.
  createWorkflowWithLifecycleEvents(input: CreateWorkflowInput, context: unknown, createdEvent: WorkflowEventDraft, validatedEvent: WorkflowEventDraft): Promise<WorkflowRecord>
  startWorkflowDurably(workflowId: string, startedEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; started: boolean }>
  getStepExecutionByKey(workflowId: string, stepId: string, round: number, attempt: number): Promise<StepExecutionRecord | null>
  ensureStepStarted(step: CreateStepExecutionInput, currentStepId: string, startedEvent: WorkflowEventDraft): Promise<{ step: StepExecutionRecord; workflow: WorkflowRecord; created: boolean }>
  bindStepTaskOnce(stepExecutionId: string, taskId: string, workflowId: string, event: WorkflowEventDraft): Promise<{ step: StepExecutionRecord; bound: boolean }>
  completeStepAndCheckpoint(stepExecutionId: string, output: unknown, workflowId: string, contextExpectedRevision: number | null, context: unknown | undefined, event: WorkflowEventDraft): Promise<{ step: StepExecutionRecord; completed: boolean }>
  advanceWorkflow(workflowId: string, edgeSelectedEvent: WorkflowEventDraft, roundAdvancedEvent: WorkflowEventDraft | null, nextStep: CreateStepExecutionInput, currentStepId: string, stepStartedEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; step: StepExecutionRecord; advanced: boolean }>
  terminalizeWorkflow(workflowId: string, status: string, edgeSelectedEvent: WorkflowEventDraft | null, terminalEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; terminalized: boolean }>
  failStepAndWorkflow(stepExecutionId: string, workflowId: string, stepFailedEvent: WorkflowEventDraft, terminalEvent: WorkflowEventDraft, stepError: unknown): Promise<WorkflowRecord>
  recordCancellationIntent(workflowId: string): Promise<WorkflowRecord>
  cancelStepAndWorkflow(stepExecutionId: string | null, workflowId: string, terminalEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; cancelled: boolean }>

  // ── workspace-lease PROJECTION + per-step revision evidence (workspace_lease_v1) ──
  // The Node stays authoritative; these persist a durable projection so the runtime
  // recovers acquisition/revision/release idempotently. Revisions are bounded and
  // revalidated on read; no paths/tokens/keys are ever stored.
  /** Record a durable acquisition INTENT (status `acquiring`) BEFORE contacting the
   *  Node. Idempotent on the deterministic lease id — a re-run returns the same row. */
  recordWorkspaceLeaseIntent(input: { workspace_lease_id: string; workflow_id: string; node_id: string; workspace_key: string }): Promise<WorkflowWorkspaceLeaseRecord>
  /** Promote an intent to `active` with the observed base + current revision. Idempotent. */
  markWorkspaceLeaseActive(leaseId: string, baseRevision: unknown, currentRevision: unknown, acquiredAt: string): Promise<WorkflowWorkspaceLeaseRecord>
  /** Set/clear the sanitized reason an acquire is unresolved/failed (cleared on activate). */
  setWorkspaceLeaseAcquireReason(leaseId: string, reason: string | null): Promise<WorkflowWorkspaceLeaseRecord>
  /** Update the expected current revision after a step terminalizes. */
  setWorkspaceLeaseRevision(leaseId: string, currentRevision: unknown): Promise<WorkflowWorkspaceLeaseRecord>
  /** Persist release INTENT (status `release_requested`). Idempotent; terminal-safe. */
  requestWorkspaceLeaseRelease(leaseId: string, ts: string): Promise<WorkflowWorkspaceLeaseRecord>
  /** Mark the lease `released` after the Node confirms. Idempotent. */
  markWorkspaceLeaseReleased(leaseId: string, ts: string): Promise<WorkflowWorkspaceLeaseRecord>
  getWorkspaceLeaseProjection(leaseId: string): Promise<WorkflowWorkspaceLeaseRecord | null>
  listWorkspaceLeaseProjections(workflowId: string): Promise<WorkflowWorkspaceLeaseRecord[]>
  /** Non-released lease projections whose workflow is terminal (completed/failed/
   *  cancelled) — the recovery worklist for pending releases. Never blocked/running. */
  listReleasableWorkspaceLeases(): Promise<WorkflowWorkspaceLeaseRecord[]>
  /** Persist the revision observed BEFORE / AFTER a step's task. Idempotent. */
  setStepRevisionBefore(stepExecutionId: string, revision: unknown): Promise<void>
  setStepRevisionAfter(stepExecutionId: string, revision: unknown): Promise<void>

  // ── completion-policy verified evidence (workflow_completion_evidence) ────────
  /** Persist the SYSTEM-OBSERVED evidence + decision used to gate `$complete` for a
   *  completing step. Idempotent on step_execution_id (first write wins) so a restart
   *  never re-derives or re-completes. */
  recordCompletionEvidence(input: { step_execution_id: string; workflow_id: string; evidence: unknown; decision: string }): Promise<void>
  getCompletionEvidence(stepExecutionId: string): Promise<{ step_execution_id: string; workflow_id: string; evidence: unknown; decision: string; created_at: string } | null>

  // ── no-progress (stall) signal fingerprints (workflow_stall_rounds) ──────────
  /** Persist a loop round's stall fingerprint. First-write-wins per (workflow, round)
   *  so a restart never double-counts a round. */
  recordStallRound(workflowId: string, round: number, fingerprint: string, signals: unknown): Promise<void>
  /** All recorded stall fingerprints for a workflow, ordered by round ascending. */
  listStallRounds(workflowId: string): Promise<Array<{ round: number; fingerprint: string }>>

  // ── human pause / approval gates (workflow_human_requests) ───────────────────
  // Durable input/approval pauses. No Agent Task runs while a workflow waits; the
  // request survives restart; a response is idempotent and a conflicting second
  // response fails closed. Transitions are atomic with the workflow status change.
  /** Atomically create the pause request (idempotent on request_id) AND transition
   *  the workflow running → `waiting_input`/`waiting_approval` with a pause event. */
  createHumanRequestAndPause(input: CreateHumanRequestInput, waitingStatus: string, pausedEvent: WorkflowEventDraft): Promise<WorkflowHumanRequestRecord>
  getHumanRequest(requestId: string): Promise<WorkflowHumanRequestRecord | null>
  /** The request currently AWAITING a human (status `pending`) for this workflow. */
  getPendingHumanRequest(workflowId: string): Promise<WorkflowHumanRequestRecord | null>
  /** The active request for this workflow (pending/answered/approved) — for resume. */
  getActiveHumanRequest(workflowId: string): Promise<WorkflowHumanRequestRecord | null>
  /** Record an input answer. Idempotent (same value); a DIFFERENT value fails closed. */
  answerHumanRequestInput(requestId: string, value: string): Promise<WorkflowHumanRequestRecord>
  /** Record an approval. Idempotent; a conflicting later decision fails closed. */
  approveHumanRequest(requestId: string): Promise<WorkflowHumanRequestRecord>
  /** Atomically record a rejection AND terminalize the workflow `failed`. Idempotent;
   *  a prior approval fails closed. Documents the approval-rejection → failed policy. */
  rejectHumanRequestAndFailWorkflow(requestId: string, workflowFailedEvent: WorkflowEventDraft): Promise<{ request: WorkflowHumanRequestRecord; workflow: WorkflowRecord }>
  /** Transition `waiting_input`/`waiting_approval` → running with a resume event.
   *  Idempotent (already running → no-op). */
  resumeWorkflowRunning(workflowId: string, resumedEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; resumed: boolean }>

  // retention primitives (bounded; never touch active records; no scheduler)
  pruneTerminalTasks(olderThanIso: string): Promise<CleanupResult>
  pruneTerminalWorkflows(olderThanIso: string): Promise<CleanupResult>
  pruneTaskEvents(taskId: string, keepLast: number): Promise<CleanupResult>
  pruneWorkflowEvents(workflowId: string, keepLast: number): Promise<CleanupResult>
}
