/**
 * SQLite-backed `ControlStore` (better-sqlite3, hidden behind the interface).
 *
 * Durable, single-file, WAL-mode. Opens securely (rejects a symlinked DB path,
 * user-only perms where the platform permits), enforces optimistic concurrency
 * and the documented state-transition invariants, treats all persisted JSON as
 * untrusted, and provides store-level atomic composites. NOT wired into the
 * Gateway/runtime in this PR.
 */
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { vibeDir } from '../config.js'
import { runMigrations, LATEST_SCHEMA_VERSION } from './migrations.js'
import {
  ControlStoreError, isStepScopedEvent, isTaskEventType, isWorkflowEventType,
  TASK_TERMINAL_STATUSES, WORKFLOW_TERMINAL_STATUSES, STEP_TERMINAL_STATUSES,
  validateCreateTask, validateCreateWorkflow, validateCreateStepExecution,
  type TaskRecord, type CreateTaskInput, type TaskPatch, type TaskEventInput, type TaskEventRecord,
  type WorkflowRecord, type CreateWorkflowInput, type WorkflowPatch, type StepExecutionRecord,
  type CreateStepExecutionInput, type StepExecutionPatch, type WorkflowEventInput, type WorkflowEventRecord,
  type WorkflowSnapshot,
} from './records.js'
import {
  SIZE_LIMITS, nowIso, isIsoUtc, encodeJson, boundString, decodeJson, assertValidContext,
} from './serialization.js'
import type { ControlStore, Pagination, TaskFilters, WorkflowFilters, HealthCheck, CleanupResult } from './store.js'

export interface OpenControlStoreOptions {
  /** DB path; defaults to `<vibe_dir>/control.sqlite`. Configurable for tests. */
  path?: string
  /** Busy timeout (ms) for lock contention. Default 5000. */
  busyTimeoutMs?: number
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000

/** Open (creating if needed), migrate, and return a ready store. */
export function openControlStore(opts: OpenControlStoreOptions = {}): SqliteControlStore {
  const dbPath = opts.path ? path.resolve(opts.path) : path.join(vibeDir(), 'control.sqlite')
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    // Refuse to follow a symlink at the DB path (or its WAL/SHM sidecars).
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { if (fs.lstatSync(p).isSymbolicLink()) throw new ControlStoreError('invalid_record', `refusing to open a symlinked database path: ${p}`) } catch (e) { if (e instanceof ControlStoreError) throw e }
    }
  }
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma(`busy_timeout = ${Number.isInteger(opts.busyTimeoutMs) ? opts.busyTimeoutMs : DEFAULT_BUSY_TIMEOUT_MS}`)
  if (dbPath !== ':memory:' && process.platform !== 'win32') {
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.chmodSync(p, 0o600) } catch { /* sidecar may not exist yet */ } }
  }
  const store = new SqliteControlStore(db, dbPath)
  store.migrateSync()
  return store
}

export class SqliteControlStore implements ControlStore {
  private closed = false
  constructor(private readonly db: BetterSqlite3.Database, readonly dbPath: string) {}

  // ── lifecycle ──────────────────────────────────────────────────────────────
  migrateSync(): number { this.open(); return runMigrations(this.db) }
  async migrate(): Promise<number> { return this.migrateSync() }
  async close(): Promise<void> { if (!this.closed) { this.db.close(); this.closed = true } }
  async healthCheck(): Promise<HealthCheck> {
    this.open()
    const fk = this.db.pragma('foreign_keys', { simple: true })
    const jm = this.db.pragma('journal_mode', { simple: true })
    const bt = this.db.pragma('busy_timeout', { simple: true })
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
    return { ok: true, schema_version: row.v ?? 0, foreign_keys: fk === 1, journal_mode: String(jm), busy_timeout: Number(bt) }
  }

  private open(): void { if (this.closed) throw new ControlStoreError('closed', 'control store is closed') }

  // ── tasks ────────────────────────────────────────────────────────────────────
  async createTask(input: CreateTaskInput): Promise<TaskRecord> { this.open(); return this.createTaskSync(input) }
  async getTask(taskId: string): Promise<TaskRecord | null> { this.open(); const r = this.taskRow(taskId); return r ? this.toTask(r) : null }
  async updateTask(taskId: string, expectedRevision: number, patch: TaskPatch): Promise<TaskRecord> { this.open(); return this.updateTaskSync(taskId, expectedRevision, patch) }
  async listTasks(filters: TaskFilters = {}, page: Pagination = {}): Promise<TaskRecord[]> {
    this.open()
    const where: string[] = []; const args: unknown[] = []
    if (filters.status) { where.push('status = ?'); args.push(filters.status) }
    if (filters.node_id) { where.push('node_id = ?'); args.push(filters.node_id) }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC, task_id ASC LIMIT ? OFFSET ?`
    args.push(clampLimit(page.limit), clampOffset(page.offset))
    return (this.db.prepare(sql).all(...args) as TaskRow[]).map((r) => this.toTask(r))
  }
  async deleteTask(taskId: string): Promise<void> { this.open(); this.db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId) }
  async appendTaskEvent(taskId: string, event: TaskEventInput): Promise<void> { this.open(); this.appendTaskEventSync(taskId, event) }
  async listTaskEvents(taskId: string, afterSequence = -1, limit = 1000): Promise<TaskEventRecord[]> {
    this.open()
    const rows = this.db.prepare('SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?').all(taskId, afterSequence, clampLimit(limit)) as TaskEventRow[]
    return rows.map((r) => ({ task_id: r.task_id, sequence: r.sequence, event_type: r.event_type, ts: r.ts, payload: decodeJson(r.payload_json, SIZE_LIMITS.task_event_payload, 'task_event.payload'), created_at: r.created_at }))
  }
  async getLatestTaskEventSequence(taskId: string): Promise<number> {
    this.open(); const r = this.taskRow(taskId); if (!r) throw new ControlStoreError('not_found', `task not found: ${taskId}`); return r.last_event_sequence
  }

  // ── workflows ──────────────────────────────────────────────────────────────
  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord> { this.open(); return this.createWorkflowSync(input) }
  async getWorkflow(workflowId: string): Promise<WorkflowRecord | null> { this.open(); const r = this.workflowRow(workflowId); return r ? this.toWorkflow(r) : null }
  async updateWorkflow(workflowId: string, expectedRevision: number, patch: WorkflowPatch): Promise<WorkflowRecord> { this.open(); return this.updateWorkflowSync(workflowId, expectedRevision, patch) }
  async listWorkflows(filters: WorkflowFilters = {}, page: Pagination = {}): Promise<WorkflowRecord[]> {
    this.open()
    const where = filters.status ? 'WHERE status = ?' : ''
    const args: unknown[] = filters.status ? [filters.status] : []
    args.push(clampLimit(page.limit), clampOffset(page.offset))
    return (this.db.prepare(`SELECT * FROM workflows ${where} ORDER BY created_at ASC, workflow_id ASC LIMIT ? OFFSET ?`).all(...args) as WorkflowRow[]).map((r) => this.toWorkflow(r))
  }
  async createStepExecution(input: CreateStepExecutionInput): Promise<StepExecutionRecord> { this.open(); return this.createStepSync(input) }
  async getStepExecution(id: string): Promise<StepExecutionRecord | null> { this.open(); const r = this.stepRow(id); return r ? this.toStep(r) : null }
  async updateStepExecution(id: string, expectedRevision: number, patch: StepExecutionPatch): Promise<StepExecutionRecord> { this.open(); return this.updateStepSync(id, expectedRevision, patch) }
  async listStepExecutions(workflowId: string): Promise<StepExecutionRecord[]> {
    this.open()
    return (this.db.prepare('SELECT * FROM workflow_step_executions WHERE workflow_id = ? ORDER BY round ASC, created_at ASC').all(workflowId) as StepRow[]).map((r) => this.toStep(r))
  }
  async appendWorkflowEvent(workflowId: string, event: WorkflowEventInput): Promise<void> { this.open(); this.appendWorkflowEventSync(workflowId, event) }
  async listWorkflowEvents(workflowId: string, afterSequence = -1, limit = 1000): Promise<WorkflowEventRecord[]> {
    this.open()
    const rows = this.db.prepare('SELECT * FROM workflow_events WHERE workflow_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?').all(workflowId, afterSequence, clampLimit(limit)) as WorkflowEventRow[]
    return rows.map((r) => ({ workflow_id: r.workflow_id, sequence: r.sequence, event_type: r.event_type, ts: r.ts, step_execution_id: r.step_execution_id, payload: decodeJson(r.payload_json, SIZE_LIMITS.workflow_event_payload, 'workflow_event.payload'), created_at: r.created_at }))
  }
  async saveWorkflowContext(workflowId: string, expectedContextRevision: number, context: unknown): Promise<number> { this.open(); return this.saveContextSync(workflowId, expectedContextRevision, context) }
  async getWorkflowSnapshot(workflowId: string): Promise<WorkflowSnapshot | null> {
    this.open(); const r = this.workflowRow(workflowId); if (!r) return null
    return { workflow: this.toWorkflow(r), context: decodeJson(r.context_json, SIZE_LIMITS.context_json, 'workflow.context', false), context_revision: r.context_revision }
  }

  // ── atomic composites ────────────────────────────────────────────────────────
  async createTaskWithCreatedEvent(input: CreateTaskInput, event: TaskEventInput): Promise<TaskRecord> {
    this.open()
    return this.db.transaction(() => { this.createTaskSync(input); this.appendTaskEventSync(input.task_id, event); return this.toTask(this.taskRow(input.task_id)!) })()
  }
  async terminalizeTask(taskId: string, expectedRevision: number, patch: TaskPatch, terminalEvent: TaskEventInput): Promise<TaskRecord> {
    this.open()
    return this.db.transaction(() => {
      const cur = this.taskRow(taskId); if (!cur) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
      if (cur.terminal_event_recorded) throw new ControlStoreError('invalid_transition', 'terminal event already recorded')
      if (!patch.status || !TASK_TERMINAL_STATUSES.has(patch.status)) throw new ControlStoreError('invalid_transition', 'terminalizeTask requires a terminal status')
      const merged: TaskPatch = { ...patch, terminal_at: patch.terminal_at ?? nowIso() }
      this.updateTaskSync(taskId, expectedRevision, merged)
      this.appendTaskEventSync(taskId, terminalEvent)
      this.db.prepare('UPDATE tasks SET terminal_event_recorded = 1 WHERE task_id = ?').run(taskId)
      return this.toTask(this.taskRow(taskId)!)
    })()
  }
  async startWorkflowStep(step: CreateStepExecutionInput, wfExpectedRevision: number, wfPatch: WorkflowPatch, event: WorkflowEventInput): Promise<{ step: StepExecutionRecord; workflow: WorkflowRecord }> {
    this.open()
    return this.db.transaction(() => {
      const s = this.createStepSync(step)
      const w = this.updateWorkflowSync(step.workflow_id, wfExpectedRevision, wfPatch)
      this.appendWorkflowEventSync(step.workflow_id, event)
      return { step: s, workflow: this.toWorkflow(this.workflowRow(step.workflow_id)!) ?? w }
    })()
  }
  async bindStepTask(stepId: string, stepExpectedRevision: number, taskId: string, workflowId: string, wfExpectedRevision: number, event: WorkflowEventInput): Promise<{ step: StepExecutionRecord; workflow: WorkflowRecord }> {
    this.open()
    return this.db.transaction(() => {
      const s = this.updateStepSync(stepId, stepExpectedRevision, { task_id: taskId })
      const wf = this.workflowRow(workflowId); if (!wf) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
      const w = this.updateWorkflowSync(workflowId, wfExpectedRevision, { total_tasks: wf.total_tasks + 1 })
      this.appendWorkflowEventSync(workflowId, event)
      return { step: s, workflow: w }
    })()
  }
  async checkpointWorkflow(workflowId: string, wfExpectedRevision: number, patch: WorkflowPatch, ctxExpectedRevision: number | null, context: unknown | undefined, event: WorkflowEventInput): Promise<WorkflowRecord> {
    this.open()
    return this.db.transaction(() => {
      const w = this.updateWorkflowSync(workflowId, wfExpectedRevision, patch)
      if (ctxExpectedRevision !== null && context !== undefined) this.saveContextSync(workflowId, ctxExpectedRevision, context)
      this.appendWorkflowEventSync(workflowId, event)
      return this.toWorkflow(this.workflowRow(workflowId)!) ?? w
    })()
  }

  // ── retention (bounded; never touches active records; no scheduler) ──────────
  async pruneTerminalTasks(olderThanIso: string): Promise<CleanupResult> {
    this.open()
    const q = `DELETE FROM tasks WHERE status IN ('completed','failed','cancelled') AND terminal_at IS NOT NULL AND terminal_at < ?`
    return { removed: this.db.transaction(() => this.db.prepare(q).run(olderThanIso).changes)() }
  }
  async pruneTerminalWorkflows(olderThanIso: string): Promise<CleanupResult> {
    this.open()
    const q = `DELETE FROM workflows WHERE status IN ('completed','failed','cancelled') AND terminal_at IS NOT NULL AND terminal_at < ?`
    return { removed: this.db.transaction(() => this.db.prepare(q).run(olderThanIso).changes)() }
  }
  async pruneTaskEvents(taskId: string, keepLast: number): Promise<CleanupResult> {
    this.open()
    return { removed: this.db.transaction(() => this.pruneEventsSync('task_events', 'tasks', taskId, keepLast))() }
  }
  async pruneWorkflowEvents(workflowId: string, keepLast: number): Promise<CleanupResult> {
    this.open()
    return { removed: this.db.transaction(() => this.pruneEventsSync('workflow_events', 'workflows', workflowId, keepLast))() }
  }

  private pruneEventsSync(eventTable: string, parentTable: string, id: string, keepLast: number): number {
    if (!Number.isInteger(keepLast) || keepLast < 0) throw new ControlStoreError('invalid_record', 'keepLast must be a non-negative integer')
    const idCol = parentTable === 'tasks' ? 'task_id' : 'workflow_id'
    const seqs = this.db.prepare(`SELECT sequence FROM ${eventTable} WHERE ${idCol} = ? ORDER BY sequence DESC LIMIT 1 OFFSET ?`).get(id, keepLast) as { sequence: number } | undefined
    if (!seqs) return 0 // fewer than keepLast events retained
    const cutoff = seqs.sequence
    const removed = this.db.prepare(`DELETE FROM ${eventTable} WHERE ${idCol} = ? AND sequence <= ?`).run(id, cutoff).changes
    // preserve truncation metadata: earliest_retained_sequence = min remaining seq
    const min = this.db.prepare(`SELECT MIN(sequence) AS m FROM ${eventTable} WHERE ${idCol} = ?`).get(id) as { m: number | null }
    if (min.m !== null) this.db.prepare(`UPDATE ${parentTable} SET earliest_retained_sequence = ? WHERE ${idCol} = ?`).run(min.m, id)
    return removed
  }

  // ── sync internals ─────────────────────────────────────────────────────────
  private taskRow(id: string): TaskRow | undefined { return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id) as TaskRow | undefined }
  private workflowRow(id: string): WorkflowRow | undefined { return this.db.prepare('SELECT * FROM workflows WHERE workflow_id = ?').get(id) as WorkflowRow | undefined }
  private stepRow(id: string): StepRow | undefined { return this.db.prepare('SELECT * FROM workflow_step_executions WHERE step_execution_id = ?').get(id) as StepRow | undefined }

  private createTaskSync(input: CreateTaskInput): TaskRecord {
    validateCreateTask(input)
    if (this.taskRow(input.task_id)) throw new ControlStoreError('duplicate', `task already exists: ${input.task_id}`)
    const metadata_json = input.metadata != null ? encodeJson(input.metadata, SIZE_LIMITS.metadata_json, 'task.metadata') : null
    const input_text = input.input_text != null ? boundString(input.input_text, SIZE_LIMITS.input_text, 'task.input_text') : null
    const now = nowIso()
    this.db.prepare(`INSERT INTO tasks (task_id,revision,node_id,agent,workspace_key,permission_mode,status,remote_run_id,input_text,metadata_json,created_at,updated_at,terminal_at,last_event_sequence,earliest_retained_sequence,terminal_event_recorded,error_code,error_message)
      VALUES (@task_id,1,@node_id,@agent,@workspace_key,@permission_mode,@status,@remote_run_id,@input_text,@metadata_json,@now,@now,NULL,-1,0,0,NULL,NULL)`)
      .run({ task_id: input.task_id, node_id: input.node_id ?? null, agent: input.agent, workspace_key: input.workspace_key ?? null, permission_mode: input.permission_mode ?? null, status: input.status, remote_run_id: input.remote_run_id ?? null, input_text, metadata_json, now })
    return this.toTask(this.taskRow(input.task_id)!)
  }

  private updateTaskSync(taskId: string, expectedRevision: number, patch: TaskPatch): TaskRecord {
    const cur = this.taskRow(taskId); if (!cur) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
    if (cur.revision !== expectedRevision) throw new ControlStoreError('revision_conflict', `task revision conflict (have ${cur.revision}, expected ${expectedRevision})`)
    const curTerminal = TASK_TERMINAL_STATUSES.has(cur.status)
    if (patch.status !== undefined && curTerminal && patch.status !== cur.status) throw new ControlStoreError('invalid_transition', 'terminal task status cannot change')
    if (patch.terminal_at === null && cur.terminal_at !== null) throw new ControlStoreError('invalid_transition', 'terminal_at cannot be cleared')
    const metadata_json = patch.metadata !== undefined ? (patch.metadata != null ? encodeJson(patch.metadata, SIZE_LIMITS.metadata_json, 'task.metadata') : null) : cur.metadata_json
    const error_message = patch.error_message !== undefined ? (patch.error_message != null ? boundString(patch.error_message, SIZE_LIMITS.error_message, 'task.error_message') : null) : cur.error_message
    const next = {
      status: patch.status ?? cur.status,
      remote_run_id: patch.remote_run_id !== undefined ? patch.remote_run_id : cur.remote_run_id,
      workspace_key: patch.workspace_key !== undefined ? patch.workspace_key : cur.workspace_key,
      permission_mode: patch.permission_mode !== undefined ? patch.permission_mode : cur.permission_mode,
      terminal_at: patch.terminal_at !== undefined ? patch.terminal_at : cur.terminal_at,
      error_code: patch.error_code !== undefined ? patch.error_code : cur.error_code,
      metadata_json, error_message, now: nowIso(), rev: cur.revision + 1, task_id: taskId,
    }
    this.db.prepare(`UPDATE tasks SET revision=@rev,status=@status,remote_run_id=@remote_run_id,workspace_key=@workspace_key,permission_mode=@permission_mode,terminal_at=@terminal_at,error_code=@error_code,metadata_json=@metadata_json,error_message=@error_message,updated_at=@now WHERE task_id=@task_id`).run(next)
    return this.toTask(this.taskRow(taskId)!)
  }

  private appendTaskEventSync(taskId: string, ev: TaskEventInput): void {
    if (!Number.isInteger(ev.sequence) || ev.sequence < 0) throw new ControlStoreError('invalid_record', 'event.sequence must be a non-negative integer')
    if (!isTaskEventType(ev.event_type)) throw new ControlStoreError('invalid_record', 'event.event_type is invalid')
    if (!isIsoUtc(ev.ts)) throw new ControlStoreError('invalid_record', 'event.ts must be ISO-8601 UTC')
    const cur = this.taskRow(taskId); if (!cur) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
    const payload_json = encodeJson(ev.payload ?? null, SIZE_LIMITS.task_event_payload, 'task_event.payload')
    const last = cur.last_event_sequence
    if (ev.sequence <= last) {
      const existing = this.db.prepare('SELECT * FROM task_events WHERE task_id = ? AND sequence = ?').get(taskId, ev.sequence) as TaskEventRow | undefined
      if (!existing) throw new ControlStoreError('event_gap', `missing task event below high-water mark at sequence ${ev.sequence}`)
      if (existing.event_type !== ev.event_type || existing.ts !== ev.ts || existing.payload_json !== payload_json) throw new ControlStoreError('event_conflict', `conflicting task event at sequence ${ev.sequence}`)
      return // exact duplicate → idempotent no-op
    }
    if (ev.sequence !== last + 1) throw new ControlStoreError('event_gap', `task event gap: expected ${last + 1}, got ${ev.sequence}`)
    const now = nowIso()
    this.db.prepare('INSERT INTO task_events (task_id,sequence,event_type,ts,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(taskId, ev.sequence, ev.event_type, ev.ts, payload_json, now)
    this.db.prepare('UPDATE tasks SET last_event_sequence = ?, updated_at = ? WHERE task_id = ?').run(ev.sequence, now, taskId)
  }

  private createWorkflowSync(input: CreateWorkflowInput): WorkflowRecord {
    validateCreateWorkflow(input)
    if (this.workflowRow(input.workflow_id)) throw new ControlStoreError('duplicate', `workflow already exists: ${input.workflow_id}`)
    const spec_json = encodeJson(input.spec, SIZE_LIMITS.spec_json, 'workflow.spec')
    const now = nowIso()
    this.db.prepare(`INSERT INTO workflows (workflow_id,revision,spec_version,workflow_name,spec_json,status,current_step_id,current_round,total_tasks,total_failures,started_at,created_at,updated_at,terminal_at,last_event_sequence,context_revision,context_json,earliest_retained_sequence)
      VALUES (@workflow_id,1,@spec_version,@workflow_name,@spec_json,@status,@current_step_id,@current_round,0,0,NULL,@now,@now,NULL,-1,0,NULL,0)`)
      .run({ workflow_id: input.workflow_id, spec_version: input.spec_version, workflow_name: input.workflow_name, spec_json, status: input.status ?? 'draft', current_step_id: input.current_step_id ?? null, current_round: input.current_round ?? 1, now })
    return this.toWorkflow(this.workflowRow(input.workflow_id)!)
  }

  private updateWorkflowSync(workflowId: string, expectedRevision: number, patch: WorkflowPatch): WorkflowRecord {
    const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
    if (cur.revision !== expectedRevision) throw new ControlStoreError('revision_conflict', `workflow revision conflict (have ${cur.revision}, expected ${expectedRevision})`)
    if (patch.status !== undefined && WORKFLOW_TERMINAL_STATUSES.has(cur.status) && patch.status !== cur.status) throw new ControlStoreError('invalid_transition', 'terminal workflow status cannot regress')
    if (patch.current_round !== undefined && patch.current_round < cur.current_round) throw new ControlStoreError('invalid_transition', 'current_round cannot decrease')
    if (patch.total_tasks !== undefined && patch.total_tasks < cur.total_tasks) throw new ControlStoreError('invalid_transition', 'total_tasks cannot decrease')
    if (patch.total_failures !== undefined && patch.total_failures < cur.total_failures) throw new ControlStoreError('invalid_transition', 'total_failures cannot decrease')
    if (patch.terminal_at === null && cur.terminal_at !== null) throw new ControlStoreError('invalid_transition', 'terminal_at cannot be cleared')
    const next = {
      status: patch.status ?? cur.status,
      current_step_id: patch.current_step_id !== undefined ? patch.current_step_id : cur.current_step_id,
      current_round: patch.current_round ?? cur.current_round,
      total_tasks: patch.total_tasks ?? cur.total_tasks,
      total_failures: patch.total_failures ?? cur.total_failures,
      started_at: patch.started_at !== undefined ? patch.started_at : cur.started_at,
      terminal_at: patch.terminal_at !== undefined ? patch.terminal_at : cur.terminal_at,
      now: nowIso(), rev: cur.revision + 1, workflow_id: workflowId,
    }
    this.db.prepare(`UPDATE workflows SET revision=@rev,status=@status,current_step_id=@current_step_id,current_round=@current_round,total_tasks=@total_tasks,total_failures=@total_failures,started_at=@started_at,terminal_at=@terminal_at,updated_at=@now WHERE workflow_id=@workflow_id`).run(next)
    return this.toWorkflow(this.workflowRow(workflowId)!)
  }

  private createStepSync(input: CreateStepExecutionInput): StepExecutionRecord {
    validateCreateStepExecution(input)
    if (!this.workflowRow(input.workflow_id)) throw new ControlStoreError('not_found', `workflow not found: ${input.workflow_id}`)
    if (this.stepRow(input.step_execution_id)) throw new ControlStoreError('duplicate', `step execution already exists: ${input.step_execution_id}`)
    const dup = this.db.prepare('SELECT 1 FROM workflow_step_executions WHERE workflow_id=? AND step_id=? AND round=? AND attempt=?').get(input.workflow_id, input.step_id, input.round, input.attempt)
    if (dup) throw new ControlStoreError('duplicate', `step execution (step,round,attempt) already exists for ${input.step_id}`)
    const now = nowIso()
    this.db.prepare(`INSERT INTO workflow_step_executions (step_execution_id,workflow_id,step_id,round,attempt,task_id,revision,status,output_json,error_json,created_at,started_at,updated_at,terminal_at)
      VALUES (@id,@wf,@step_id,@round,@attempt,@task_id,1,@status,NULL,NULL,@now,NULL,@now,NULL)`)
      .run({ id: input.step_execution_id, wf: input.workflow_id, step_id: input.step_id, round: input.round, attempt: input.attempt, task_id: input.task_id ?? null, status: input.status ?? 'pending', now })
    return this.toStep(this.stepRow(input.step_execution_id)!)
  }

  private updateStepSync(id: string, expectedRevision: number, patch: StepExecutionPatch): StepExecutionRecord {
    const cur = this.stepRow(id); if (!cur) throw new ControlStoreError('not_found', `step execution not found: ${id}`)
    if (cur.revision !== expectedRevision) throw new ControlStoreError('revision_conflict', `step revision conflict (have ${cur.revision}, expected ${expectedRevision})`)
    const curTerminal = STEP_TERMINAL_STATUSES.has(cur.status)
    if (patch.status !== undefined && curTerminal && patch.status !== cur.status) throw new ControlStoreError('invalid_transition', 'terminal step status cannot change')
    if (patch.output !== undefined && curTerminal) throw new ControlStoreError('invalid_transition', 'terminal step output cannot be replaced')
    if (patch.task_id !== undefined && patch.task_id !== null && cur.task_id !== null && cur.task_id !== patch.task_id) throw new ControlStoreError('invalid_transition', 'step task binding is immutable once set')
    const output_json = patch.output !== undefined ? (patch.output != null ? encodeJson(patch.output, SIZE_LIMITS.step_output_json, 'step.output') : null) : cur.output_json
    const error_json = patch.error !== undefined ? (patch.error != null ? encodeJson(patch.error, SIZE_LIMITS.step_error_json, 'step.error') : null) : cur.error_json
    const next = {
      status: patch.status ?? cur.status,
      task_id: patch.task_id !== undefined ? patch.task_id : cur.task_id,
      started_at: patch.started_at !== undefined ? patch.started_at : cur.started_at,
      terminal_at: patch.terminal_at !== undefined ? patch.terminal_at : cur.terminal_at,
      output_json, error_json, now: nowIso(), rev: cur.revision + 1, id,
    }
    this.db.prepare(`UPDATE workflow_step_executions SET revision=@rev,status=@status,task_id=@task_id,output_json=@output_json,error_json=@error_json,started_at=@started_at,terminal_at=@terminal_at,updated_at=@now WHERE step_execution_id=@id`).run(next)
    return this.toStep(this.stepRow(id)!)
  }

  private appendWorkflowEventSync(workflowId: string, ev: WorkflowEventInput): void {
    if (!Number.isInteger(ev.sequence) || ev.sequence < 0) throw new ControlStoreError('invalid_record', 'event.sequence must be a non-negative integer')
    if (!isWorkflowEventType(ev.event_type)) throw new ControlStoreError('invalid_record', 'event.event_type is not a known workflow event')
    if (!isIsoUtc(ev.ts)) throw new ControlStoreError('invalid_record', 'event.ts must be ISO-8601 UTC')
    const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
    const stepScoped = isStepScopedEvent(ev.event_type)
    const stepRef = ev.step_execution_id ?? null
    if (stepScoped && !stepRef) throw new ControlStoreError('invalid_record', `step-scoped event ${ev.event_type} requires step_execution_id`)
    if (!stepScoped && stepRef) throw new ControlStoreError('invalid_record', `workflow-scoped event ${ev.event_type} must not carry step_execution_id`)
    if (stepRef) { const s = this.stepRow(stepRef); if (!s || s.workflow_id !== workflowId) throw new ControlStoreError('invalid_record', 'step_execution_id does not belong to this workflow') }
    const payload_json = encodeJson(ev.payload ?? null, SIZE_LIMITS.workflow_event_payload, 'workflow_event.payload')
    const last = cur.last_event_sequence
    if (ev.sequence <= last) {
      const existing = this.db.prepare('SELECT * FROM workflow_events WHERE workflow_id = ? AND sequence = ?').get(workflowId, ev.sequence) as WorkflowEventRow | undefined
      if (!existing) throw new ControlStoreError('event_gap', `missing workflow event below high-water mark at sequence ${ev.sequence}`)
      if (existing.event_type !== ev.event_type || existing.ts !== ev.ts || existing.payload_json !== payload_json || (existing.step_execution_id ?? null) !== stepRef) throw new ControlStoreError('event_conflict', `conflicting workflow event at sequence ${ev.sequence}`)
      return
    }
    if (ev.sequence !== last + 1) throw new ControlStoreError('event_gap', `workflow event gap: expected ${last + 1}, got ${ev.sequence}`)
    const now = nowIso()
    this.db.prepare('INSERT INTO workflow_events (workflow_id,sequence,event_type,ts,step_execution_id,payload_json,created_at) VALUES (?,?,?,?,?,?,?)').run(workflowId, ev.sequence, ev.event_type, ev.ts, stepRef, payload_json, now)
    this.db.prepare('UPDATE workflows SET last_event_sequence = ?, updated_at = ? WHERE workflow_id = ?').run(ev.sequence, now, workflowId)
  }

  private saveContextSync(workflowId: string, expectedContextRevision: number, context: unknown): number {
    const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
    if (cur.context_revision !== expectedContextRevision) throw new ControlStoreError('revision_conflict', `context revision conflict (have ${cur.context_revision}, expected ${expectedContextRevision})`)
    assertValidContext(context, 'workflow.context')
    const context_json = encodeJson(context, SIZE_LIMITS.context_json, 'workflow.context')
    const nextRev = cur.context_revision + 1
    this.db.prepare('UPDATE workflows SET context_json = ?, context_revision = ?, updated_at = ? WHERE workflow_id = ?').run(context_json, nextRev, nowIso(), workflowId)
    return nextRev
  }

  // ── row → record mappers (untrusted JSON decoded defensively) ────────────────
  private toTask(r: TaskRow): TaskRecord {
    return { task_id: r.task_id, revision: r.revision, node_id: r.node_id, agent: r.agent, workspace_key: r.workspace_key, permission_mode: r.permission_mode, status: r.status, remote_run_id: r.remote_run_id, input_text: r.input_text, metadata: decodeJson(r.metadata_json, SIZE_LIMITS.metadata_json, 'task.metadata', true) as Record<string, unknown> | null, created_at: r.created_at, updated_at: r.updated_at, terminal_at: r.terminal_at, last_event_sequence: r.last_event_sequence, earliest_retained_sequence: r.earliest_retained_sequence, terminal_event_recorded: r.terminal_event_recorded === 1, error_code: r.error_code, error_message: r.error_message }
  }
  private toWorkflow(r: WorkflowRow): WorkflowRecord {
    return { workflow_id: r.workflow_id, revision: r.revision, spec_version: r.spec_version, workflow_name: r.workflow_name, spec: decodeJson(r.spec_json, SIZE_LIMITS.spec_json, 'workflow.spec'), status: r.status, current_step_id: r.current_step_id, current_round: r.current_round, total_tasks: r.total_tasks, total_failures: r.total_failures, started_at: r.started_at, created_at: r.created_at, updated_at: r.updated_at, terminal_at: r.terminal_at, last_event_sequence: r.last_event_sequence, context_revision: r.context_revision, earliest_retained_sequence: r.earliest_retained_sequence }
  }
  private toStep(r: StepRow): StepExecutionRecord {
    return { step_execution_id: r.step_execution_id, workflow_id: r.workflow_id, step_id: r.step_id, round: r.round, attempt: r.attempt, task_id: r.task_id, revision: r.revision, status: r.status, output: decodeJson(r.output_json, SIZE_LIMITS.step_output_json, 'step.output'), error: decodeJson(r.error_json, SIZE_LIMITS.step_error_json, 'step.error'), created_at: r.created_at, started_at: r.started_at, updated_at: r.updated_at, terminal_at: r.terminal_at }
  }
}

// ── row shapes ─────────────────────────────────────────────────────────────────
interface TaskRow { task_id: string; revision: number; node_id: string | null; agent: string; workspace_key: string | null; permission_mode: string | null; status: string; remote_run_id: string | null; input_text: string | null; metadata_json: string | null; created_at: string; updated_at: string; terminal_at: string | null; last_event_sequence: number; earliest_retained_sequence: number; terminal_event_recorded: number; error_code: string | null; error_message: string | null }
interface TaskEventRow { task_id: string; sequence: number; event_type: string; ts: string; payload_json: string; created_at: string }
interface WorkflowRow { workflow_id: string; revision: number; spec_version: string; workflow_name: string; spec_json: string; status: string; current_step_id: string | null; current_round: number; total_tasks: number; total_failures: number; started_at: string | null; created_at: string; updated_at: string; terminal_at: string | null; last_event_sequence: number; context_revision: number; context_json: string | null; earliest_retained_sequence: number }
interface StepRow { step_execution_id: string; workflow_id: string; step_id: string; round: number; attempt: number; task_id: string | null; revision: number; status: string; output_json: string | null; error_json: string | null; created_at: string; started_at: string | null; updated_at: string; terminal_at: string | null }
interface WorkflowEventRow { workflow_id: string; sequence: number; event_type: string; ts: string; step_execution_id: string | null; payload_json: string; created_at: string }

function clampLimit(n?: number): number { return Number.isInteger(n) && (n as number) > 0 ? Math.min(n as number, 10000) : 1000 }
function clampOffset(n?: number): number { return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 0 }
