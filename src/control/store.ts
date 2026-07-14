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
