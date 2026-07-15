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
  WorkflowSnapshot,
} from './records.js'

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
  /** Append an accepted canonical event (idempotent/gap-checked) BEFORE publish. */
  appendTaskEventDurable(taskId: string, event: TaskEventInput): void
  updateTaskDurable(taskId: string, expectedRevision: number, patch: TaskPatch): TaskRecord
  /** Atomically persist terminal status + exactly one terminal event. */
  terminalizeTaskDurable(taskId: string, expectedRevision: number, patch: TaskPatch, terminalEvent: TaskEventInput): TaskRecord
  getTaskRecord(taskId: string): TaskRecord | null
  /** Non-terminal persisted tasks (for restart recovery). */
  listNonTerminalTasks(): TaskRecord[]
  loadTaskEvents(taskId: string): TaskEventRecord[]
  latestTaskEventSequence(taskId: string): number
  /** Mark event history incomplete at a persisted boundary (idempotent; earliest
   *  boundary wins). Never consumes an event sequence or changes next_event_id. */
  markTaskHistoryIncomplete(taskId: string, reason: string, boundarySequence: number): void
  /** Clear the marker — reserved for a future Node journal after a verified
   *  gap-free replay. */
  clearTaskHistoryIncomplete(taskId: string): void
  closeSync(): void
}

export interface Pagination { limit?: number; offset?: number }
export interface TaskFilters { status?: string; node_id?: string }
export interface WorkflowFilters { status?: string }

export interface HealthCheck { ok: boolean; schema_version: number; foreign_keys: boolean; journal_mode: string; busy_timeout: number }
export interface CleanupResult { removed: number }

export interface ControlStore {
  // lifecycle
  migrate(): Promise<number>
  healthCheck(): Promise<HealthCheck>
  close(): Promise<void>

  // tasks
  createTask(input: CreateTaskInput): Promise<TaskRecord>
  getTask(taskId: string): Promise<TaskRecord | null>
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

  // retention primitives (bounded; never touch active records; no scheduler)
  pruneTerminalTasks(olderThanIso: string): Promise<CleanupResult>
  pruneTerminalWorkflows(olderThanIso: string): Promise<CleanupResult>
  pruneTaskEvents(taskId: string, keepLast: number): Promise<CleanupResult>
  pruneWorkflowEvents(workflowId: string, keepLast: number): Promise<CleanupResult>
}
