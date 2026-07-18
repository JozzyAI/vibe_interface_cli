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
import crypto from 'crypto'
import { vibeDir } from '../config.js'
import { runMigrations, LATEST_SCHEMA_VERSION } from './migrations.js'
import {
  ControlStoreError, isSafeId, isStepScopedEvent, isTaskEventType, isWorkflowEventType,
  TASK_TERMINAL_STATUSES, WORKFLOW_TERMINAL_STATUSES, STEP_TERMINAL_STATUSES,
  validateCreateTask, validateCreateWorkflow, validateCreateStepExecution,
  type TaskRecord, type CreateTaskInput, type TaskPatch, type TaskEventInput, type TaskEventRecord,
  type WorkflowRecord, type CreateWorkflowInput, type WorkflowPatch, type StepExecutionRecord,
  type CreateStepExecutionInput, type StepExecutionPatch, type WorkflowEventInput, type WorkflowEventRecord,
  type WorkflowSnapshot, type TaskResultRecord, type WorkflowWorkspaceLeaseRecord,
  type WorkflowHumanRequestRecord, type CreateHumanRequestInput, type WorkflowDraftRecord,
  type WorkflowBuilderSessionRecord, type WorkflowBuilderMessageRecord, type WorkflowBuilderSessionSummary,
  BUILDER_MESSAGE_ROLES,
} from './records.js'
import { isValidRevision } from '../lib/workspace-lease.js'
import {
  SIZE_LIMITS, nowIso, isIsoUtc, encodeJson, boundString, decodeJson, assertValidContext, assertNoForbiddenFields,
} from './serialization.js'
import { validateTaskResult, MAX_FINAL_OUTPUT_BYTES, type AgentTaskResultV1 } from '../lib/agent-task-result.js'
import type { ControlStore, GatewayTaskStore, IngestSourceEvent, WorkflowEventDraft, Pagination, TaskFilters, WorkflowFilters, HealthCheck, CleanupResult } from './store.js'

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

export class SqliteControlStore implements ControlStore, GatewayTaskStore {
  private closed = false
  constructor(private readonly db: BetterSqlite3.Database, readonly dbPath: string) {}

  // ── synchronous GatewayTaskStore facade (persist-before-publish hot path) ────
  createTaskDurable(input: CreateTaskInput, createdEvent: TaskEventInput): TaskRecord {
    this.open()
    return this.db.transaction(() => { this.createTaskSync(input); this.appendTaskEventSync(input.task_id, createdEvent); return this.toTask(this.taskRow(input.task_id)!) })()
  }
  getTaskByIdempotencyKey(key: string): TaskRecord | null {
    this.open()
    const r = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(key) as TaskRow | undefined
    return r ? this.toTask(r) : null
  }
  createTaskIdempotently(input: CreateTaskInput, createdEvent: TaskEventInput): { record: TaskRecord; created: boolean } {
    this.open()
    const key = input.idempotency_key
    if (typeof key !== 'string' || !isSafeId(key)) throw new ControlStoreError('invalid_record', 'createTaskIdempotently requires a safe idempotency_key')
    if (typeof input.request_fingerprint !== 'string' || input.request_fingerprint === '') throw new ControlStoreError('invalid_record', 'createTaskIdempotently requires a request_fingerprint')
    const fp = input.request_fingerprint
    // Resolve an already-present key: same fingerprint → idempotent replay; a
    // different fingerprint is a conflict (the request's MEANING changed). The
    // message never echoes either request.
    const resolveExisting = (row: TaskRow): { record: TaskRecord; created: boolean } => {
      if (row.request_fingerprint !== fp) throw new ControlStoreError('idempotency_conflict', 'a task already exists for this idempotency_key with a different request')
      return { record: this.toTask(row), created: false }
    }
    try {
      return this.db.transaction(() => {
        const existing = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(key) as TaskRow | undefined
        if (existing) return resolveExisting(existing)
        this.createTaskSync(input)
        this.appendTaskEventSync(input.task_id, createdEvent)
        return { record: this.toTask(this.taskRow(input.task_id)!), created: true }
      })()
    } catch (e) {
      if (e instanceof ControlStoreError) throw e // conflict / validation propagate unchanged
      // A concurrent cross-connection insert won the race: the partial unique index
      // rejected ours. Re-read outside the rolled-back txn and resolve to the winner.
      if (isUniqueConstraintError(e)) {
        const existing = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(key) as TaskRow | undefined
        if (existing) return resolveExisting(existing)
      }
      throw e
    }
  }
  appendTaskEventDurable(taskId: string, event: TaskEventInput): void { this.open(); this.appendTaskEventSync(taskId, event) }
  updateTaskDurable(taskId: string, expectedRevision: number, patch: TaskPatch): TaskRecord { this.open(); return this.updateTaskSync(taskId, expectedRevision, patch) }
  terminalizeTaskDurable(taskId: string, expectedRevision: number, patch: TaskPatch, terminalEvent: TaskEventInput): TaskRecord {
    this.open()
    return this.db.transaction(() => {
      const cur = this.taskRow(taskId); if (!cur) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
      if (cur.terminal_event_recorded) throw new ControlStoreError('invalid_transition', 'terminal event already recorded')
      if (!patch.status || !TASK_TERMINAL_STATUSES.has(patch.status)) throw new ControlStoreError('invalid_transition', 'terminalizeTask requires a terminal status')
      this.updateTaskSync(taskId, expectedRevision, { ...patch, terminal_at: patch.terminal_at ?? nowIso() })
      this.appendTaskEventSync(taskId, terminalEvent)
      this.db.prepare('UPDATE tasks SET terminal_event_recorded = 1 WHERE task_id = ?').run(taskId)
      return this.toTask(this.taskRow(taskId)!)
    })()
  }
  // ── durable AgentTaskResult (authoritative control result; never event-derived) ──
  private taskResultRow(taskId: string): TaskResultRow | undefined { return this.db.prepare('SELECT * FROM task_results WHERE task_id = ?').get(taskId) as TaskResultRow | undefined }
  /** Idempotent-duplicate check over the COMPLETE normalized immutable envelope
   *  (schema_version, final_output, process_exit_code, content_hash, evidence_refs,
   *  artifact_refs) — NOT merely content_hash. finalized_at is excluded from equality
   *  (the first durable finalization's timestamp is preserved), so a re-finalization
   *  of identical content never conflicts on the timestamp alone. */
  private resultRowMatches(row: TaskResultRow, resultStatus: string, result: AgentTaskResultV1 | null): boolean {
    if (row.result_status !== resultStatus) return false
    if (result === null) return row.content_hash === null
    return row.schema_version === result.schema_version
      && row.content_hash === result.content_hash
      && (row.final_output_text ?? '') === result.final_output.text
      && (row.process_exit_code ?? null) === (result.process_exit_code ?? null)
      && row.evidence_refs_json === encodeJson(result.evidence_refs ?? [], 256 * 1024, 'task_result.evidence_refs')
      && row.artifact_refs_json === encodeJson(result.artifact_refs ?? [], 256 * 1024, 'task_result.artifact_refs')
      && (row.verification_json ?? null) === (result.verification ? encodeJson(result.verification, 256 * 1024, 'task_result.verification') : null)
  }
  private writeResultRow(taskId: string, resultStatus: string, result: AgentTaskResultV1 | null): void {
    const now = nowIso()
    this.db.prepare(`INSERT INTO task_results (task_id,schema_version,result_status,final_output_text,process_exit_code,finalized_at,content_hash,evidence_refs_json,artifact_refs_json,verification_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      taskId, result?.schema_version ?? '1', resultStatus,
      result ? boundString(result.final_output.text, MAX_FINAL_OUTPUT_BYTES, 'task_result.final_output') : null,
      result?.process_exit_code ?? null, result?.finalized_at ?? null, result?.content_hash ?? null,
      encodeJson(result?.evidence_refs ?? [], 256 * 1024, 'task_result.evidence_refs'),
      encodeJson(result?.artifact_refs ?? [], 256 * 1024, 'task_result.artifact_refs'),
      result?.verification ? encodeJson(result.verification, 256 * 1024, 'task_result.verification') : null, now,
    )
    this.db.prepare('UPDATE tasks SET result_status = ? WHERE task_id = ?').run(resultStatus, taskId)
  }
  persistTaskResultDurable(taskId: string, resultStatus: string, result: AgentTaskResultV1 | null): { applied: boolean } {
    this.open()
    return this.db.transaction(() => {
      if (!this.taskRow(taskId)) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
      const existing = this.taskResultRow(taskId)
      if (existing) { if (this.resultRowMatches(existing, resultStatus, result)) return { applied: false }; throw new ControlStoreError('result_conflict', 'a different task result already exists (content mismatch)') }
      this.writeResultRow(taskId, resultStatus, result)
      return { applied: true }
    })()
  }
  getTaskResultDurable(taskId: string): TaskResultRecord | null {
    this.open()
    const row = this.taskResultRow(taskId); if (!row) return null
    if (row.result_status !== 'available') return { task_id: taskId, result_status: row.result_status, result: null }
    // Revalidate the persisted envelope on read (untrusted JSON; corruption fails closed).
    const v = validateTaskResult({ schema_version: row.schema_version, final_output: { kind: 'text', text: row.final_output_text ?? '' }, process_exit_code: row.process_exit_code, finalized_at: row.finalized_at ?? '', content_hash: row.content_hash ?? '', evidence_refs: decodeJson(row.evidence_refs_json, 256 * 1024, 'task_result.evidence_refs') ?? [], artifact_refs: decodeJson(row.artifact_refs_json, 256 * 1024, 'task_result.artifact_refs') ?? [], ...(row.verification_json != null ? { verification: decodeJson(row.verification_json, 256 * 1024, 'task_result.verification') } : {}) })
    if (!v.ok) throw new ControlStoreError('corruption', `persisted task result is invalid (${v.code})`)
    return { task_id: taskId, result_status: 'available', result: v.value }
  }
  terminalizeTaskWithResultDurable(taskId: string, expectedRevision: number, patch: TaskPatch, terminalEvent: TaskEventInput, resultStatus: string, result: AgentTaskResultV1 | null): TaskRecord {
    this.open()
    return this.db.transaction(() => {
      const cur = this.taskRow(taskId); if (!cur) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
      // Persist the result FIRST (idempotent; conflict fails closed), so a terminal
      // task can never lose its final output.
      const existing = this.taskResultRow(taskId)
      if (existing) { if (!this.resultRowMatches(existing, resultStatus, result)) throw new ControlStoreError('result_conflict', 'conflicting task result on terminalization') }
      else this.writeResultRow(taskId, resultStatus, result)
      // Then terminalize + append the terminal event exactly once (idempotent).
      if (!cur.terminal_event_recorded) {
        if (!patch.status || !TASK_TERMINAL_STATUSES.has(patch.status)) throw new ControlStoreError('invalid_transition', 'terminalize requires a terminal status')
        this.updateTaskSync(taskId, expectedRevision, { ...patch, terminal_at: patch.terminal_at ?? nowIso() })
        this.appendTaskEventSync(taskId, terminalEvent)
        this.db.prepare('UPDATE tasks SET terminal_event_recorded = 1 WHERE task_id = ?').run(taskId)
      }
      return this.toTask(this.taskRow(taskId)!)
    })()
  }

  getTaskRecord(taskId: string): TaskRecord | null { this.open(); const r = this.taskRow(taskId); return r ? this.toTask(r) : null }
  listNonTerminalTasks(): TaskRecord[] {
    this.open()
    return (this.db.prepare("SELECT * FROM tasks WHERE status NOT IN ('completed','failed','cancelled') ORDER BY created_at ASC").all() as TaskRow[]).map((r) => this.toTask(r))
  }
  loadTaskEvents(taskId: string): TaskEventRecord[] {
    this.open()
    return (this.db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence ASC').all(taskId) as TaskEventRow[]).map((r) => ({ task_id: r.task_id, sequence: r.sequence, event_type: r.event_type, ts: r.ts, payload: decodeJson(r.payload_json, SIZE_LIMITS.task_event_payload, 'task_event.payload'), created_at: r.created_at }))
  }
  latestTaskEventSequence(taskId: string): number { this.open(); const r = this.taskRow(taskId); if (!r) throw new ControlStoreError('not_found', `task not found: ${taskId}`); return r.last_event_sequence }
  /** Mark event history incomplete at a persisted cursor boundary (first marking
   *  wins, preserving the earliest boundary). Does not consume an event sequence
   *  or alter next_event_id. */
  markTaskHistoryIncomplete(taskId: string, reason: string, boundarySequence: number): void {
    this.open(); const r = this.taskRow(taskId); if (!r) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
    if (r.history_incomplete === 1) return
    this.db.prepare('UPDATE tasks SET history_incomplete = 1, history_reason = ?, history_boundary_sequence = ? WHERE task_id = ?').run(reason, boundarySequence, taskId)
  }
  /** Clear the incomplete marker — reserved for a FUTURE Node journal that has
   *  verified a gap-free replay past the boundary. Unused today. */
  clearTaskHistoryIncomplete(taskId: string): void {
    this.open(); this.db.prepare('UPDATE tasks SET history_incomplete = 0, history_reason = NULL, history_boundary_sequence = NULL WHERE task_id = ?').run(taskId)
  }
  initReplayCursor(taskId: string): void {
    this.open(); this.db.prepare('UPDATE tasks SET last_remote_event_sequence = -1 WHERE task_id = ? AND last_remote_event_sequence IS NULL').run(taskId)
  }
  ingestSourceEventDurable(taskId: string, sourceSequence: number, event: IngestSourceEvent): { record: TaskRecord; applied: boolean; canonicalSequence: number | null } {
    this.open()
    if (!Number.isInteger(sourceSequence) || sourceSequence < 0) throw new ControlStoreError('invalid_record', 'source_sequence must be a non-negative integer')
    if (!isTaskEventType(event.event_type)) throw new ControlStoreError('invalid_record', 'event_type is invalid')
    if (!isIsoUtc(event.ts)) throw new ControlStoreError('invalid_record', 'ts must be ISO-8601 UTC')
    return this.db.transaction(() => {
      const cur = this.taskRow(taskId); if (!cur) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
      const payload_json = encodeJson(event.payload ?? null, SIZE_LIMITS.task_event_payload, 'task_event.payload')
      const expected = (cur.last_remote_event_sequence ?? -1) + 1
      if (sourceSequence < expected) {
        // Below the cursor: must EXACTLY match an existing durable mapping (idempotent),
        // else it is a conflict/corruption — never silently ignored.
        const existing = this.db.prepare('SELECT * FROM task_events WHERE task_id = ? AND source_sequence = ?').get(taskId, sourceSequence) as TaskEventRow | undefined
        if (!existing) throw new ControlStoreError('event_conflict', `source_sequence ${sourceSequence} below cursor with no durable mapping`)
        if (existing.event_type !== event.event_type || existing.ts !== event.ts || existing.payload_json !== payload_json) throw new ControlStoreError('event_conflict', `conflicting canonical mapping for source_sequence ${sourceSequence}`)
        return { record: this.toTask(cur), applied: false, canonicalSequence: existing.sequence } // idempotent
      }
      if (sourceSequence > expected) throw new ControlStoreError('event_gap', `source gap: expected ${expected}, got ${sourceSequence}`)
      // sourceSequence === expected → map to the next Gateway sequence + advance cursor.
      const gatewaySeq = cur.last_event_sequence + 1
      this.appendTaskEventSync(taskId, { sequence: gatewaySeq, event_type: event.event_type, ts: event.ts, payload: event.payload, source_sequence: sourceSequence })
      this.db.prepare('UPDATE tasks SET last_remote_event_sequence = ?, updated_at = ? WHERE task_id = ?').run(sourceSequence, nowIso(), taskId)
      if (event.terminal && !this.taskRow(taskId)!.terminal_event_recorded) {
        this.db.prepare('UPDATE tasks SET status = COALESCE(?, status), terminal_at = ?, terminal_event_recorded = 1, error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message) WHERE task_id = ?').run(event.status ?? null, nowIso(), event.error_code ?? null, event.error_message ?? null, taskId)
      } else if (event.status) {
        this.db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run(event.status, taskId)
      }
      return { record: this.toTask(this.taskRow(taskId)!), applied: true, canonicalSequence: gatewaySeq }
    })()
  }
  advanceSourceCursor(taskId: string, sourceSequence: number): { applied: boolean } {
    this.open()
    if (!Number.isInteger(sourceSequence) || sourceSequence < 0) throw new ControlStoreError('invalid_record', 'source_sequence must be a non-negative integer')
    return this.db.transaction(() => {
      const cur = this.taskRow(taskId); if (!cur) throw new ControlStoreError('not_found', `task not found: ${taskId}`)
      const expected = (cur.last_remote_event_sequence ?? -1) + 1
      if (sourceSequence < expected) return { applied: false } // already consumed → idempotent
      if (sourceSequence > expected) throw new ControlStoreError('event_gap', `source gap: expected ${expected}, got ${sourceSequence}`)
      this.db.prepare('UPDATE tasks SET last_remote_event_sequence = ?, updated_at = ? WHERE task_id = ?').run(sourceSequence, nowIso(), taskId)
      return { applied: false }
    })()
  }
  closeSync(): void { if (!this.closed) { this.db.close(); this.closed = true } }

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
  async getTaskResult(taskId: string): Promise<TaskResultRecord | null> { this.open(); return this.getTaskResultDurable(taskId) }
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
  /** Record (once) when the runtime began awaiting this step's terminal task's durable
   *  result. Idempotent via COALESCE — the FIRST timestamp is preserved so the bounded
   *  deadline survives a Gateway restart. Does not touch status/revision routing. */
  async markStepAwaitingResult(id: string, ts: string): Promise<StepExecutionRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.stepRow(id); if (!r) throw new ControlStoreError('not_found', `step execution not found: ${id}`)
      this.db.prepare(`UPDATE workflow_step_executions SET result_awaited_since = COALESCE(result_awaited_since, @ts), updated_at=@now WHERE step_execution_id=@id`)
        .run({ id, ts: isIsoUtc(ts) ? ts : nowIso(), now: nowIso() })
      return this.toStep(this.stepRow(id)!)
    })()
  }
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

  // ── workflow-runtime composites (atomic; idempotent for crash recovery) ──────
  // Each runs in ONE transaction and auto-assigns the next contiguous workflow
  // event sequence. Idempotency guards (status / step-existence) make a re-run
  // after a crash a safe no-op, so recovery never duplicates a step, task, edge,
  // terminal event, or counter increment.

  private appendWorkflowEventAuto(workflowId: string, draft: WorkflowEventDraft): void {
    const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
    this.appendWorkflowEventSync(workflowId, { ...draft, sequence: cur.last_event_sequence + 1 })
  }
  private stepExecByKey(workflowId: string, stepId: string, round: number, attempt: number): StepRow | undefined {
    return this.db.prepare('SELECT * FROM workflow_step_executions WHERE workflow_id=? AND step_id=? AND round=? AND attempt=?').get(workflowId, stepId, round, attempt) as StepRow | undefined
  }

  async createWorkflowWithLifecycleEvents(input: CreateWorkflowInput, context: unknown, createdEvent: WorkflowEventDraft, validatedEvent: WorkflowEventDraft): Promise<WorkflowRecord> {
    this.open()
    return this.db.transaction(() => {
      this.createWorkflowSync({ ...input, status: 'ready', current_round: input.current_round ?? 1 })
      if (context !== undefined) this.saveContextSync(input.workflow_id, 0, context)
      this.appendWorkflowEventAuto(input.workflow_id, createdEvent)
      this.appendWorkflowEventAuto(input.workflow_id, validatedEvent)
      return this.toWorkflow(this.workflowRow(input.workflow_id)!)
    })()
  }

  async startWorkflowDurably(workflowId: string, startedEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; started: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
      if (cur.status === 'running') return { workflow: this.toWorkflow(cur), started: false } // coalesce a duplicate start
      if (cur.status !== 'ready') throw new ControlStoreError('invalid_transition', `workflow cannot start from status ${cur.status}`)
      this.updateWorkflowSync(workflowId, cur.revision, { status: 'running', started_at: cur.started_at ?? nowIso() })
      this.appendWorkflowEventAuto(workflowId, startedEvent)
      return { workflow: this.toWorkflow(this.workflowRow(workflowId)!), started: true }
    })()
  }

  async getStepExecutionByKey(workflowId: string, stepId: string, round: number, attempt: number): Promise<StepExecutionRecord | null> {
    this.open(); const r = this.stepExecByKey(workflowId, stepId, round, attempt); return r ? this.toStep(r) : null
  }

  async ensureStepStarted(step: CreateStepExecutionInput, currentStepId: string, startedEvent: WorkflowEventDraft): Promise<{ step: StepExecutionRecord; workflow: WorkflowRecord; created: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const existing = this.stepExecByKey(step.workflow_id, step.step_id, step.round, step.attempt)
      const wf0 = this.workflowRow(step.workflow_id); if (!wf0) throw new ControlStoreError('not_found', `workflow not found: ${step.workflow_id}`)
      if (existing) return { step: this.toStep(existing), workflow: this.toWorkflow(wf0), created: false } // idempotent
      this.createStepSync(step)
      if (wf0.current_step_id !== currentStepId) this.updateWorkflowSync(step.workflow_id, wf0.revision, { current_step_id: currentStepId })
      this.appendWorkflowEventAuto(step.workflow_id, startedEvent)
      return { step: this.toStep(this.stepRow(step.step_execution_id)!), workflow: this.toWorkflow(this.workflowRow(step.workflow_id)!), created: true }
    })()
  }

  async bindStepTaskOnce(stepExecutionId: string, taskId: string, workflowId: string, event: WorkflowEventDraft): Promise<{ step: StepExecutionRecord; bound: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const step = this.stepRow(stepExecutionId); if (!step) throw new ControlStoreError('not_found', `step execution not found: ${stepExecutionId}`)
      if (step.task_id === taskId) return { step: this.toStep(step), bound: false } // idempotent recovery re-bind
      if (step.task_id !== null) throw new ControlStoreError('invalid_transition', 'step is already bound to a different task')
      this.updateStepSync(stepExecutionId, step.revision, { task_id: taskId })
      const wf = this.workflowRow(workflowId); if (!wf) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
      this.updateWorkflowSync(workflowId, wf.revision, { total_tasks: wf.total_tasks + 1 })
      this.appendWorkflowEventAuto(workflowId, event)
      return { step: this.toStep(this.stepRow(stepExecutionId)!), bound: true }
    })()
  }

  async completeStepAndCheckpoint(stepExecutionId: string, output: unknown, workflowId: string, contextExpectedRevision: number | null, context: unknown | undefined, event: WorkflowEventDraft): Promise<{ step: StepExecutionRecord; completed: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const step = this.stepRow(stepExecutionId); if (!step) throw new ControlStoreError('not_found', `step execution not found: ${stepExecutionId}`)
      if (step.status === 'completed') return { step: this.toStep(step), completed: false } // idempotent
      this.updateStepSync(stepExecutionId, step.revision, { status: 'completed', output, terminal_at: nowIso() })
      if (contextExpectedRevision !== null && context !== undefined) this.saveContextSync(workflowId, contextExpectedRevision, context)
      this.appendWorkflowEventAuto(workflowId, event)
      return { step: this.toStep(this.stepRow(stepExecutionId)!), completed: true }
    })()
  }

  async advanceWorkflow(workflowId: string, edgeSelectedEvent: WorkflowEventDraft, roundAdvancedEvent: WorkflowEventDraft | null, nextStep: CreateStepExecutionInput, currentStepId: string, stepStartedEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; step: StepExecutionRecord; advanced: boolean }> {
    this.open()
    return this.db.transaction(() => {
      // The destination round is derived from the SOURCE step's IMMUTABLE round, so
      // this guard is stable across recovery even after current_round advanced.
      const existing = this.stepExecByKey(nextStep.workflow_id, nextStep.step_id, nextStep.round, nextStep.attempt)
      if (existing) return { workflow: this.toWorkflow(this.workflowRow(workflowId)!), step: this.toStep(existing), advanced: false } // idempotent
      this.appendWorkflowEventAuto(workflowId, edgeSelectedEvent)
      if (roundAdvancedEvent) {
        const wf = this.workflowRow(workflowId)!
        this.updateWorkflowSync(workflowId, wf.revision, { current_round: nextStep.round })
        this.appendWorkflowEventAuto(workflowId, roundAdvancedEvent)
      }
      this.createStepSync(nextStep)
      const wf2 = this.workflowRow(workflowId)!
      if (wf2.current_step_id !== currentStepId) this.updateWorkflowSync(workflowId, wf2.revision, { current_step_id: currentStepId })
      this.appendWorkflowEventAuto(workflowId, stepStartedEvent)
      return { workflow: this.toWorkflow(this.workflowRow(workflowId)!), step: this.toStep(this.stepRow(nextStep.step_execution_id)!), advanced: true }
    })()
  }

  async terminalizeWorkflow(workflowId: string, status: string, edgeSelectedEvent: WorkflowEventDraft | null, terminalEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; terminalized: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
      if (cur.status === status || WORKFLOW_TERMINAL_STATUSES.has(cur.status)) return { workflow: this.toWorkflow(cur), terminalized: false } // idempotent
      if (edgeSelectedEvent) this.appendWorkflowEventAuto(workflowId, edgeSelectedEvent)
      const terminal = WORKFLOW_TERMINAL_STATUSES.has(status)
      this.updateWorkflowSync(workflowId, cur.revision, { status, ...(terminal ? { terminal_at: nowIso() } : {}) })
      this.appendWorkflowEventAuto(workflowId, terminalEvent)
      return { workflow: this.toWorkflow(this.workflowRow(workflowId)!), terminalized: true }
    })()
  }

  async failStepAndWorkflow(stepExecutionId: string, workflowId: string, stepFailedEvent: WorkflowEventDraft, terminalEvent: WorkflowEventDraft, stepError: unknown): Promise<WorkflowRecord> {
    this.open()
    return this.db.transaction(() => {
      const step = this.stepRow(stepExecutionId); if (!step) throw new ControlStoreError('not_found', `step execution not found: ${stepExecutionId}`)
      if (step.status !== 'failed' && !STEP_TERMINAL_STATUSES.has(step.status)) {
        this.updateStepSync(stepExecutionId, step.revision, { status: 'failed', error: stepError, terminal_at: nowIso() })
        const wf = this.workflowRow(workflowId)!
        this.updateWorkflowSync(workflowId, wf.revision, { total_failures: wf.total_failures + 1 }) // increment exactly once
        this.appendWorkflowEventAuto(workflowId, stepFailedEvent)
      }
      const wf2 = this.workflowRow(workflowId)!
      if (!WORKFLOW_TERMINAL_STATUSES.has(wf2.status)) {
        this.updateWorkflowSync(workflowId, wf2.revision, { status: 'failed', terminal_at: nowIso() })
        this.appendWorkflowEventAuto(workflowId, terminalEvent)
      }
      return this.toWorkflow(this.workflowRow(workflowId)!)
    })()
  }

  async recordCancellationIntent(workflowId: string): Promise<WorkflowRecord> {
    this.open()
    return this.db.transaction(() => {
      const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
      if (cur.cancel_requested === 1 || WORKFLOW_TERMINAL_STATUSES.has(cur.status)) return this.toWorkflow(cur)
      this.updateWorkflowSync(workflowId, cur.revision, { cancel_requested: true })
      return this.toWorkflow(this.workflowRow(workflowId)!)
    })()
  }

  async cancelStepAndWorkflow(stepExecutionId: string | null, workflowId: string, terminalEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; cancelled: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
      if (WORKFLOW_TERMINAL_STATUSES.has(cur.status)) return { workflow: this.toWorkflow(cur), cancelled: false } // already terminal wins
      if (stepExecutionId) {
        const step = this.stepRow(stepExecutionId)
        if (step && !STEP_TERMINAL_STATUSES.has(step.status)) this.updateStepSync(stepExecutionId, step.revision, { status: 'cancelled', terminal_at: nowIso() })
      }
      this.updateWorkflowSync(workflowId, cur.revision, { status: 'cancelled', terminal_at: nowIso() })
      this.appendWorkflowEventAuto(workflowId, terminalEvent)
      return { workflow: this.toWorkflow(this.workflowRow(workflowId)!), cancelled: true }
    })()
  }

  // ── workspace-lease projection + per-step revision evidence (workspace_lease_v1) ──
  // The Node stays authoritative; these persist a durable projection so the runtime
  // recovers acquire/revision/release idempotently. Revisions are bounded + revalidated.

  private decodeRevision(json: string | null, label: string): unknown {
    const v = decodeJson(json, SIZE_LIMITS.metadata_json, label, true)
    if (v == null) return null
    if (!isValidRevision(v)) throw new ControlStoreError('invalid_record', `${label} is not a valid workspace revision`)
    return v
  }
  private encodeRevision(rev: unknown, label: string): string | null {
    if (rev == null) return null
    if (!isValidRevision(rev)) throw new ControlStoreError('invalid_record', `${label} is not a valid workspace revision`)
    return encodeJson(rev, SIZE_LIMITS.metadata_json, label)
  }
  private leaseRow(id: string): WorkspaceLeaseRow | undefined { return this.db.prepare('SELECT * FROM workflow_workspace_leases WHERE workspace_lease_id = ?').get(id) as WorkspaceLeaseRow | undefined }
  private toLease(r: WorkspaceLeaseRow): WorkflowWorkspaceLeaseRecord {
    return { workspace_lease_id: r.workspace_lease_id, workflow_id: r.workflow_id, node_id: r.node_id, workspace_key: r.workspace_key, mode: r.mode, status: r.status, revision: r.revision, base_revision: this.decodeRevision(r.base_revision_json, 'lease.base_revision'), current_revision: this.decodeRevision(r.current_revision_json, 'lease.current_revision'), acquired_at: r.acquired_at, release_requested_at: r.release_requested_at, released_at: r.released_at, acquire_reason: r.acquire_reason ?? null, created_at: r.created_at, updated_at: r.updated_at }
  }

  async recordWorkspaceLeaseIntent(input: { workspace_lease_id: string; workflow_id: string; node_id: string; workspace_key: string }): Promise<WorkflowWorkspaceLeaseRecord> {
    this.open()
    if (!isSafeId(input.workspace_lease_id)) throw new ControlStoreError('invalid_record', 'workspace_lease_id is not a safe identifier')
    return this.db.transaction(() => {
      const existing = this.leaseRow(input.workspace_lease_id)
      if (existing) return this.toLease(existing) // idempotent on the deterministic id
      if (!this.workflowRow(input.workflow_id)) throw new ControlStoreError('not_found', `workflow not found: ${input.workflow_id}`)
      const now = nowIso()
      this.db.prepare(`INSERT INTO workflow_workspace_leases (workspace_lease_id,workflow_id,node_id,workspace_key,mode,status,revision,created_at,updated_at)
        VALUES (@id,@wf,@node,@ws,'exclusive','acquiring',1,@now,@now)`)
        .run({ id: input.workspace_lease_id, wf: input.workflow_id, node: boundString(input.node_id, 256, 'lease.node_id'), ws: boundString(input.workspace_key, 256, 'lease.workspace_key'), now })
      return this.toLease(this.leaseRow(input.workspace_lease_id)!)
    })()
  }
  async markWorkspaceLeaseActive(leaseId: string, baseRevision: unknown, currentRevision: unknown, acquiredAt: string): Promise<WorkflowWorkspaceLeaseRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.leaseRow(leaseId); if (!r) throw new ControlStoreError('not_found', `lease not found: ${leaseId}`)
      // Re-acquisition after a rollback-release RE-ACTIVATES the same deterministic
      // lease (mirrors the Node), taking a fresh base; a plain idempotent re-activate
      // keeps the immutable base. Either way clears any release marks.
      const reactivating = r.status === 'released' || r.status === 'release_requested'
      const acq = isIsoUtc(acquiredAt) ? acquiredAt : nowIso()
      const baseJson = reactivating ? this.encodeRevision(baseRevision, 'lease.base_revision') : (r.base_revision_json ?? this.encodeRevision(baseRevision, 'lease.base_revision'))
      const curJson = this.encodeRevision(currentRevision ?? baseRevision, 'lease.current_revision')
      this.db.prepare(`UPDATE workflow_workspace_leases SET status='active', base_revision_json=@base, current_revision_json=@cur, acquired_at=@acq2, release_requested_at=NULL, released_at=NULL, acquire_reason=NULL, revision=revision+1, updated_at=@now WHERE workspace_lease_id=@id`)
        .run({ id: leaseId, base: baseJson, cur: curJson, acq2: reactivating ? acq : (r.acquired_at ?? acq), now: nowIso() })
      return this.toLease(this.leaseRow(leaseId)!)
    })()
  }
  /** Set (or clear, with null) the SANITIZED reason a lease acquisition is unresolved
   *  or failed. Only meaningful while `status='acquiring'`; cleared automatically on
   *  activate/release. Idempotent. */
  async setWorkspaceLeaseAcquireReason(leaseId: string, reason: string | null): Promise<WorkflowWorkspaceLeaseRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.leaseRow(leaseId); if (!r) throw new ControlStoreError('not_found', `lease not found: ${leaseId}`)
      this.db.prepare(`UPDATE workflow_workspace_leases SET acquire_reason=@reason, revision=revision+1, updated_at=@now WHERE workspace_lease_id=@id`)
        .run({ id: leaseId, reason: reason === null ? null : boundString(reason, 256, 'lease.acquire_reason'), now: nowIso() })
      return this.toLease(this.leaseRow(leaseId)!)
    })()
  }
  async setWorkspaceLeaseRevision(leaseId: string, currentRevision: unknown): Promise<WorkflowWorkspaceLeaseRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.leaseRow(leaseId); if (!r) throw new ControlStoreError('not_found', `lease not found: ${leaseId}`)
      this.db.prepare(`UPDATE workflow_workspace_leases SET current_revision_json=@cur, revision=revision+1, updated_at=@now WHERE workspace_lease_id=@id`)
        .run({ id: leaseId, cur: this.encodeRevision(currentRevision, 'lease.current_revision'), now: nowIso() })
      return this.toLease(this.leaseRow(leaseId)!)
    })()
  }
  async requestWorkspaceLeaseRelease(leaseId: string, ts: string): Promise<WorkflowWorkspaceLeaseRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.leaseRow(leaseId); if (!r) throw new ControlStoreError('not_found', `lease not found: ${leaseId}`)
      if (r.status === 'released') return this.toLease(r) // idempotent
      this.db.prepare(`UPDATE workflow_workspace_leases SET status='release_requested', release_requested_at=COALESCE(release_requested_at,@ts), revision=revision+1, updated_at=@now WHERE workspace_lease_id=@id`)
        .run({ id: leaseId, ts: isIsoUtc(ts) ? ts : nowIso(), now: nowIso() })
      return this.toLease(this.leaseRow(leaseId)!)
    })()
  }
  async markWorkspaceLeaseReleased(leaseId: string, ts: string): Promise<WorkflowWorkspaceLeaseRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.leaseRow(leaseId); if (!r) throw new ControlStoreError('not_found', `lease not found: ${leaseId}`)
      if (r.status === 'released') return this.toLease(r) // idempotent
      this.db.prepare(`UPDATE workflow_workspace_leases SET status='released', released_at=COALESCE(released_at,@ts), revision=revision+1, updated_at=@now WHERE workspace_lease_id=@id`)
        .run({ id: leaseId, ts: isIsoUtc(ts) ? ts : nowIso(), now: nowIso() })
      return this.toLease(this.leaseRow(leaseId)!)
    })()
  }
  async getWorkspaceLeaseProjection(leaseId: string): Promise<WorkflowWorkspaceLeaseRecord | null> {
    this.open(); const r = this.leaseRow(leaseId); return r ? this.toLease(r) : null
  }
  async listWorkspaceLeaseProjections(workflowId: string): Promise<WorkflowWorkspaceLeaseRecord[]> {
    this.open()
    return (this.db.prepare('SELECT * FROM workflow_workspace_leases WHERE workflow_id = ? ORDER BY node_id ASC, workspace_key ASC').all(workflowId) as WorkspaceLeaseRow[]).map((r) => this.toLease(r))
  }
  async listReleasableWorkspaceLeases(): Promise<WorkflowWorkspaceLeaseRecord[]> {
    this.open()
    const q = `SELECT l.* FROM workflow_workspace_leases l JOIN workflows w ON l.workflow_id = w.workflow_id
      WHERE l.status IN ('acquiring','active','release_requested') AND w.status IN ('completed','failed','cancelled')
      ORDER BY l.node_id ASC, l.workspace_key ASC`
    return (this.db.prepare(q).all() as WorkspaceLeaseRow[]).map((r) => this.toLease(r))
  }
  async setStepRevisionBefore(stepExecutionId: string, revision: unknown): Promise<void> {
    this.open()
    this.db.transaction(() => {
      if (!this.stepRow(stepExecutionId)) throw new ControlStoreError('not_found', `step execution not found: ${stepExecutionId}`)
      this.db.prepare('UPDATE workflow_step_executions SET revision_before_json=@rev, updated_at=@now WHERE step_execution_id=@id')
        .run({ id: stepExecutionId, rev: this.encodeRevision(revision, 'step.revision_before'), now: nowIso() })
    })()
  }
  async setStepRevisionAfter(stepExecutionId: string, revision: unknown): Promise<void> {
    this.open()
    this.db.transaction(() => {
      if (!this.stepRow(stepExecutionId)) throw new ControlStoreError('not_found', `step execution not found: ${stepExecutionId}`)
      this.db.prepare('UPDATE workflow_step_executions SET revision_after_json=@rev, updated_at=@now WHERE step_execution_id=@id')
        .run({ id: stepExecutionId, rev: this.encodeRevision(revision, 'step.revision_after'), now: nowIso() })
    })()
  }

  // ── human pause / approval gates (workflow_human_requests) ───────────────────
  private humanRow(id: string): HumanRequestRow | undefined { return this.db.prepare('SELECT * FROM workflow_human_requests WHERE request_id = ?').get(id) as HumanRequestRow | undefined }
  private toHumanRequest(r: HumanRequestRow): WorkflowHumanRequestRecord {
    return { request_id: r.request_id, workflow_id: r.workflow_id, step_execution_id: r.step_execution_id, kind: r.kind, prompt: r.prompt, choices: decodeJson(r.choices_json, SIZE_LIMITS.metadata_json, 'human_request.choices') as string[] | null, status: r.status, response_value: r.response_value, created_at: r.created_at, responded_at: r.responded_at, updated_at: r.updated_at, revision: r.revision }
  }

  async createHumanRequestAndPause(input: CreateHumanRequestInput, waitingStatus: string, pausedEvent: WorkflowEventDraft): Promise<WorkflowHumanRequestRecord> {
    this.open()
    if (!isSafeId(input.request_id)) throw new ControlStoreError('invalid_record', 'request_id is not a safe identifier')
    if (input.kind !== 'input' && input.kind !== 'approval') throw new ControlStoreError('invalid_record', 'human request kind must be input|approval')
    if (waitingStatus !== 'waiting_input' && waitingStatus !== 'waiting_approval') throw new ControlStoreError('invalid_record', 'waitingStatus must be waiting_input|waiting_approval')
    return this.db.transaction(() => {
      const wf = this.workflowRow(input.workflow_id); if (!wf) throw new ControlStoreError('not_found', `workflow not found: ${input.workflow_id}`)
      let row = this.humanRow(input.request_id)
      if (!row) {
        if (!this.stepRow(input.step_execution_id)) throw new ControlStoreError('not_found', `step execution not found: ${input.step_execution_id}`)
        const now = nowIso()
        this.db.prepare(`INSERT INTO workflow_human_requests (request_id,workflow_id,step_execution_id,kind,prompt,choices_json,status,response_value,created_at,responded_at,updated_at,revision)
          VALUES (@id,@wf,@sec,@kind,@prompt,@choices,'pending',NULL,@now,NULL,@now,1)`)
          .run({ id: input.request_id, wf: input.workflow_id, sec: input.step_execution_id, kind: input.kind, prompt: boundString(input.prompt, 8192, 'human.prompt'), choices: input.choices ? encodeJson(input.choices.slice(0, 200), SIZE_LIMITS.metadata_json, 'human.choices') : null, now })
        row = this.humanRow(input.request_id)!
      }
      // Transition running → waiting_* (idempotent: already waiting on this request → no-op).
      if (wf.status === 'running') { this.updateWorkflowSync(input.workflow_id, wf.revision, { status: waitingStatus }); this.appendWorkflowEventAuto(input.workflow_id, pausedEvent) }
      return this.toHumanRequest(this.humanRow(input.request_id)!)
    })()
  }
  async getHumanRequest(requestId: string): Promise<WorkflowHumanRequestRecord | null> { this.open(); const r = this.humanRow(requestId); return r ? this.toHumanRequest(r) : null }
  async getPendingHumanRequest(workflowId: string): Promise<WorkflowHumanRequestRecord | null> {
    this.open(); const r = this.db.prepare("SELECT * FROM workflow_human_requests WHERE workflow_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(workflowId) as HumanRequestRow | undefined
    return r ? this.toHumanRequest(r) : null
  }
  async getActiveHumanRequest(workflowId: string): Promise<WorkflowHumanRequestRecord | null> {
    this.open(); const r = this.db.prepare("SELECT * FROM workflow_human_requests WHERE workflow_id=? AND status IN ('pending','answered','approved') ORDER BY created_at DESC LIMIT 1").get(workflowId) as HumanRequestRow | undefined
    return r ? this.toHumanRequest(r) : null
  }
  async answerHumanRequestInput(requestId: string, value: string): Promise<WorkflowHumanRequestRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.humanRow(requestId); if (!r) throw new ControlStoreError('not_found', `human request not found: ${requestId}`)
      if (r.kind !== 'input') throw new ControlStoreError('invalid_transition', 'request is not an input request')
      const v = boundString(value, 8192, 'human.response_value')
      if (r.status === 'answered') { if (r.response_value !== v) throw new ControlStoreError('invalid_transition', 'conflicting input response'); return this.toHumanRequest(r) } // idempotent
      if (r.status !== 'pending') throw new ControlStoreError('invalid_transition', `cannot answer a ${r.status} request`)
      this.db.prepare(`UPDATE workflow_human_requests SET status='answered', response_value=@v, responded_at=@now, revision=revision+1, updated_at=@now WHERE request_id=@id`).run({ id: requestId, v, now: nowIso() })
      return this.toHumanRequest(this.humanRow(requestId)!)
    })()
  }
  async approveHumanRequest(requestId: string): Promise<WorkflowHumanRequestRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.humanRow(requestId); if (!r) throw new ControlStoreError('not_found', `human request not found: ${requestId}`)
      if (r.kind !== 'approval') throw new ControlStoreError('invalid_transition', 'request is not an approval request')
      if (r.status === 'approved') return this.toHumanRequest(r) // idempotent
      if (r.status === 'rejected') throw new ControlStoreError('invalid_transition', 'request was already rejected')
      if (r.status !== 'pending') throw new ControlStoreError('invalid_transition', `cannot approve a ${r.status} request`)
      this.db.prepare(`UPDATE workflow_human_requests SET status='approved', responded_at=@now, revision=revision+1, updated_at=@now WHERE request_id=@id`).run({ id: requestId, now: nowIso() })
      return this.toHumanRequest(this.humanRow(requestId)!)
    })()
  }
  async rejectHumanRequestAndFailWorkflow(requestId: string, workflowFailedEvent: WorkflowEventDraft): Promise<{ request: WorkflowHumanRequestRecord; workflow: WorkflowRecord }> {
    this.open()
    return this.db.transaction(() => {
      const r = this.humanRow(requestId); if (!r) throw new ControlStoreError('not_found', `human request not found: ${requestId}`)
      if (r.kind !== 'approval') throw new ControlStoreError('invalid_transition', 'request is not an approval request')
      if (r.status === 'approved') throw new ControlStoreError('invalid_transition', 'request was already approved')
      if (r.status !== 'rejected') {
        if (r.status !== 'pending') throw new ControlStoreError('invalid_transition', `cannot reject a ${r.status} request`)
        this.db.prepare(`UPDATE workflow_human_requests SET status='rejected', responded_at=@now, revision=revision+1, updated_at=@now WHERE request_id=@id`).run({ id: requestId, now: nowIso() })
      }
      const wf = this.workflowRow(r.workflow_id)!
      if (!WORKFLOW_TERMINAL_STATUSES.has(wf.status)) { this.updateWorkflowSync(r.workflow_id, wf.revision, { status: 'failed', terminal_at: nowIso() }); this.appendWorkflowEventAuto(r.workflow_id, workflowFailedEvent) }
      return { request: this.toHumanRequest(this.humanRow(requestId)!), workflow: this.toWorkflow(this.workflowRow(r.workflow_id)!) }
    })()
  }
  async resumeWorkflowRunning(workflowId: string, resumedEvent: WorkflowEventDraft): Promise<{ workflow: WorkflowRecord; resumed: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const cur = this.workflowRow(workflowId); if (!cur) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
      if (cur.status === 'running') return { workflow: this.toWorkflow(cur), resumed: false } // idempotent
      if (cur.status !== 'waiting_input' && cur.status !== 'waiting_approval') throw new ControlStoreError('invalid_transition', `cannot resume from status ${cur.status}`)
      this.updateWorkflowSync(workflowId, cur.revision, { status: 'running' })
      this.appendWorkflowEventAuto(workflowId, resumedEvent)
      return { workflow: this.toWorkflow(this.workflowRow(workflowId)!), resumed: true }
    })()
  }

  // ── completion-policy verified evidence (workflow_completion_evidence) ────────
  async recordCompletionEvidence(input: { step_execution_id: string; workflow_id: string; evidence: unknown; decision: string }): Promise<void> {
    this.open()
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM workflow_completion_evidence WHERE step_execution_id = ?').get(input.step_execution_id)) return // first write wins (idempotent)
      if (!this.stepRow(input.step_execution_id)) throw new ControlStoreError('not_found', `step execution not found: ${input.step_execution_id}`)
      this.db.prepare('INSERT INTO workflow_completion_evidence (step_execution_id,workflow_id,evidence_json,decision,created_at) VALUES (@sec,@wf,@ev,@dec,@now)')
        .run({ sec: input.step_execution_id, wf: input.workflow_id, ev: encodeJson(input.evidence, SIZE_LIMITS.metadata_json, 'completion.evidence'), dec: boundString(input.decision, 64, 'completion.decision'), now: nowIso() })
    })()
  }
  async getCompletionEvidence(stepExecutionId: string): Promise<{ step_execution_id: string; workflow_id: string; evidence: unknown; decision: string; created_at: string } | null> {
    this.open()
    const r = this.db.prepare('SELECT * FROM workflow_completion_evidence WHERE step_execution_id = ?').get(stepExecutionId) as { step_execution_id: string; workflow_id: string; evidence_json: string; decision: string; created_at: string } | undefined
    if (!r) return null
    return { step_execution_id: r.step_execution_id, workflow_id: r.workflow_id, evidence: decodeJson(r.evidence_json, SIZE_LIMITS.metadata_json, 'completion.evidence'), decision: r.decision, created_at: r.created_at }
  }

  // ── no-progress (stall) signal fingerprints (workflow_stall_rounds) ──────────
  async recordStallRound(workflowId: string, round: number, fingerprint: string, signals: unknown): Promise<void> {
    this.open()
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM workflow_stall_rounds WHERE workflow_id=? AND round=?').get(workflowId, round)) return // first-write-wins (no double-count)
      if (!this.workflowRow(workflowId)) throw new ControlStoreError('not_found', `workflow not found: ${workflowId}`)
      this.db.prepare('INSERT INTO workflow_stall_rounds (workflow_id,round,fingerprint,signals_json,created_at) VALUES (@wf,@r,@fp,@sig,@now)')
        .run({ wf: workflowId, r: round, fp: boundString(fingerprint, 128, 'stall.fingerprint'), sig: signals != null ? encodeJson(signals, SIZE_LIMITS.metadata_json, 'stall.signals') : null, now: nowIso() })
    })()
  }
  async listStallRounds(workflowId: string): Promise<Array<{ round: number; fingerprint: string }>> {
    this.open()
    return (this.db.prepare('SELECT round, fingerprint FROM workflow_stall_rounds WHERE workflow_id=? ORDER BY round ASC').all(workflowId) as Array<{ round: number; fingerprint: string }>)
  }

  // ── compiler WorkflowDrafts (workflow_drafts) — immutable + idempotent ───────
  private draftRow(id: string): DraftRow | undefined { return this.db.prepare('SELECT * FROM workflow_drafts WHERE draft_id = ?').get(id) as DraftRow | undefined }
  private toDraft(r: DraftRow): WorkflowDraftRecord {
    const L = SIZE_LIMITS.metadata_json
    return { draft_id: r.draft_id, idempotency_key: r.idempotency_key, request_fingerprint: r.request_fingerprint, compiler_task_id: r.compiler_task_id, compiler_capability: decodeJson(r.compiler_capability_json, L, 'draft.capability'), constraints: decodeJson(r.constraints_json, L, 'draft.constraints'), inventory_snapshot: decodeJson(r.inventory_snapshot_json, L, 'draft.inventory'), inventory_hash: r.inventory_hash, spec: decodeJson(r.spec_json, SIZE_LIMITS.spec_json, 'draft.spec'), input_values: decodeJson(r.input_values_json, L, 'draft.input_values'), spec_hash: r.spec_hash, policy_summary: decodeJson(r.policy_summary_json, L, 'draft.policy_summary'), policy_summary_hash: r.policy_summary_hash, preview: decodeJson(r.preview_json, L, 'draft.preview'), rationale: decodeJson(r.rationale_json, L, 'draft.rationale'), warnings: decodeJson(r.warnings_json, L, 'draft.warnings'), questions: decodeJson(r.questions_json, L, 'draft.questions'), compiler_status: r.compiler_status, validation_status: r.validation_status, approval_status: r.approval_status, materialized_workflow_id: r.materialized_workflow_id, created_at: r.created_at, updated_at: r.updated_at }
  }
  async createDraft(input: { draft_id: string; idempotency_key: string | null; request_fingerprint: string; constraints: unknown; inventory_snapshot: unknown; inventory_hash: string }): Promise<{ draft: WorkflowDraftRecord; created: boolean }> {
    this.open()
    if (!isSafeId(input.draft_id)) throw new ControlStoreError('invalid_record', 'draft_id is not a safe identifier')
    return this.db.transaction(() => {
      const existing = this.draftRow(input.draft_id)
      if (existing) return { draft: this.toDraft(existing), created: false } // create-or-return by the stable draft_id (captures the ORIGINAL inventory once)
      const now = nowIso(); const L = SIZE_LIMITS.metadata_json
      this.db.prepare(`INSERT INTO workflow_drafts (draft_id,idempotency_key,request_fingerprint,constraints_json,inventory_snapshot_json,inventory_hash,compiler_status,validation_status,approval_status,created_at,updated_at)
        VALUES (@id,@key,@rf,@con,@inv,@ih,'pending','pending','unapproved',@now,@now)`)
        .run({ id: input.draft_id, key: input.idempotency_key, rf: boundString(input.request_fingerprint, 128, 'draft.request_fingerprint'), con: encodeJson(input.constraints ?? null, L, 'draft.constraints'), inv: encodeJson(input.inventory_snapshot ?? null, L, 'draft.inventory'), ih: boundString(input.inventory_hash, 128, 'draft.inventory_hash'), now })
      return { draft: this.toDraft(this.draftRow(input.draft_id)!), created: true }
    })()
  }
  async bindDraftCompilerTask(draftId: string, taskId: string, capability?: unknown): Promise<void> {
    this.open()
    this.db.transaction(() => {
      const r = this.draftRow(draftId); if (!r) throw new ControlStoreError('not_found', `draft not found: ${draftId}`)
      if (r.compiler_task_id !== null && r.compiler_task_id !== taskId) throw new ControlStoreError('invalid_transition', 'draft compiler task is immutable once bound')
      if (r.compiler_task_id === null) this.db.prepare('UPDATE workflow_drafts SET compiler_task_id=@t, compiler_capability_json=@cap, updated_at=@now WHERE draft_id=@id').run({ id: draftId, t: taskId, cap: capability !== undefined ? encodeJson(capability, SIZE_LIMITS.metadata_json, 'draft.capability') : null, now: nowIso() })
    })()
  }
  async finalizeDraft(draftId: string, patch: { compiler_status: string; validation_status: string; spec?: unknown; input_values?: unknown; spec_hash?: string | null; policy_summary?: unknown; policy_summary_hash?: string | null; preview?: unknown; rationale?: unknown; warnings?: unknown; questions?: unknown }): Promise<WorkflowDraftRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.draftRow(draftId); if (!r) throw new ControlStoreError('not_found', `draft not found: ${draftId}`)
      if (r.compiler_status !== 'pending') return this.toDraft(r) // first finalize wins (immutable content)
      const L = SIZE_LIMITS.metadata_json
      this.db.prepare(`UPDATE workflow_drafts SET compiler_status=@cs, validation_status=@vs, spec_json=@spec, input_values_json=@iv, spec_hash=@sh, policy_summary_json=@ps, policy_summary_hash=@psh, preview_json=@pv, rationale_json=@ra, warnings_json=@wa, questions_json=@qu, updated_at=@now WHERE draft_id=@id`)
        .run({ id: draftId, cs: boundString(patch.compiler_status, 32, 'draft.status'), vs: boundString(patch.validation_status, 32, 'draft.vstatus'),
          spec: patch.spec !== undefined ? encodeJson(patch.spec, SIZE_LIMITS.spec_json, 'draft.spec') : null, iv: patch.input_values !== undefined ? encodeJson(patch.input_values, L, 'draft.input_values') : null,
          sh: patch.spec_hash ?? null, ps: patch.policy_summary !== undefined ? encodeJson(patch.policy_summary, L, 'draft.policy_summary') : null, psh: patch.policy_summary_hash ?? null,
          pv: patch.preview !== undefined ? encodeJson(patch.preview, L, 'draft.preview') : null, ra: patch.rationale !== undefined ? encodeJson(patch.rationale, L, 'draft.rationale') : null,
          wa: patch.warnings !== undefined ? encodeJson(patch.warnings, L, 'draft.warnings') : null, qu: patch.questions !== undefined ? encodeJson(patch.questions, L, 'draft.questions') : null, now: nowIso() })
      return this.toDraft(this.draftRow(draftId)!)
    })()
  }
  async getDraft(draftId: string): Promise<WorkflowDraftRecord | null> { this.open(); const r = this.draftRow(draftId); return r ? this.toDraft(r) : null }
  async getDraftByIdempotencyKey(key: string): Promise<WorkflowDraftRecord | null> { this.open(); const r = this.db.prepare('SELECT * FROM workflow_drafts WHERE idempotency_key = ?').get(key) as DraftRow | undefined; return r ? this.toDraft(r) : null }
  async approveDraftWithWorkflow(draftId: string, workflowId: string): Promise<WorkflowDraftRecord> {
    this.open()
    return this.db.transaction(() => {
      const r = this.draftRow(draftId); if (!r) throw new ControlStoreError('not_found', `draft not found: ${draftId}`)
      if (r.materialized_workflow_id !== null) return this.toDraft(r) // idempotent (already approved + materialized)
      this.db.prepare("UPDATE workflow_drafts SET approval_status='approved', materialized_workflow_id=@wf, updated_at=@now WHERE draft_id=@id").run({ id: draftId, wf: workflowId, now: nowIso() })
      return this.toDraft(this.draftRow(draftId)!)
    })()
  }

  // ── Conversational Workflow Builder ──────────────────────────────────────────
  private builderSessionRow(id: string): BuilderSessionRow | undefined { return this.db.prepare('SELECT * FROM workflow_builder_sessions WHERE builder_session_id = ?').get(id) as BuilderSessionRow | undefined }
  private toBuilderSession(r: BuilderSessionRow): WorkflowBuilderSessionRecord {
    return { builder_session_id: r.builder_session_id, title: r.title, status: r.status as WorkflowBuilderSessionRecord['status'], created_at: r.created_at, updated_at: r.updated_at, current_draft_id: r.current_draft_id, current_spec_hash: r.current_spec_hash, revision: r.revision, source_workflow_id: r.source_workflow_id, compiler_agent: r.compiler_agent, compiler_node_id: r.compiler_node_id, pending_turn_key: r.pending_turn_key, pending_turn_started_at: r.pending_turn_started_at }
  }
  private toBuilderMessage(r: BuilderMessageRow): WorkflowBuilderMessageRecord {
    return { message_id: r.message_id, builder_session_id: r.builder_session_id, role: r.role as WorkflowBuilderMessageRecord['role'], content: r.content, created_at: r.created_at, sequence: r.sequence, draft_id: r.draft_id, spec_hash: r.spec_hash, metadata: decodeJson(r.metadata_json, SIZE_LIMITS.metadata_json, 'builder.message.metadata', true) as Record<string, unknown> | null, turn_key: r.turn_key }
  }
  private nextBuilderSeq(sessionId: string): number { const r = this.db.prepare('SELECT MAX(sequence) AS m FROM workflow_builder_messages WHERE builder_session_id = ?').get(sessionId) as { m: number | null }; return (r.m ?? -1) + 1 }
  private builderTurnRow(sessionId: string, turnKey: string, role: string): BuilderMessageRow | undefined { return this.db.prepare('SELECT * FROM workflow_builder_messages WHERE builder_session_id = ? AND turn_key = ? AND role = ? ORDER BY sequence ASC LIMIT 1').get(sessionId, turnKey, role) as BuilderMessageRow | undefined }

  async createBuilderSession(input: { builder_session_id: string; title: string; source_workflow_id?: string | null; compiler_agent?: string | null; compiler_node_id?: string | null }): Promise<WorkflowBuilderSessionRecord> {
    this.open()
    if (!isSafeId(input.builder_session_id)) throw new ControlStoreError('invalid_record', 'builder_session_id is not a safe identifier')
    return this.db.transaction(() => {
      const existing = this.builderSessionRow(input.builder_session_id)
      if (existing) return this.toBuilderSession(existing) // create-or-return by stable id (idempotent)
      const now = nowIso()
      this.db.prepare(`INSERT INTO workflow_builder_sessions (builder_session_id,title,status,current_draft_id,current_spec_hash,revision,source_workflow_id,compiler_agent,compiler_node_id,created_at,updated_at)
        VALUES (@id,@title,'active',NULL,NULL,1,@swf,@ca,@cn,@now,@now)`)
        .run({ id: input.builder_session_id, title: boundString(input.title, 512, 'builder.title'), swf: input.source_workflow_id ?? null, ca: input.compiler_agent ?? null, cn: input.compiler_node_id ?? null, now })
      return this.toBuilderSession(this.builderSessionRow(input.builder_session_id)!)
    })()
  }
  async getBuilderSession(id: string): Promise<WorkflowBuilderSessionRecord | null> { this.open(); const r = this.builderSessionRow(id); return r ? this.toBuilderSession(r) : null }
  async listBuilderMessages(id: string): Promise<WorkflowBuilderMessageRecord[]> { this.open(); return (this.db.prepare('SELECT * FROM workflow_builder_messages WHERE builder_session_id = ? ORDER BY sequence ASC').all(id) as BuilderMessageRow[]).map((r) => this.toBuilderMessage(r)) }
  async listBuilderSessions(page?: { limit?: number; offset?: number }): Promise<WorkflowBuilderSessionSummary[]> {
    this.open()
    const limit = Math.max(1, Math.min(page?.limit ?? 50, 200)); const offset = Math.max(0, page?.offset ?? 0)
    const rows = this.db.prepare('SELECT * FROM workflow_builder_sessions ORDER BY updated_at DESC, builder_session_id DESC LIMIT ? OFFSET ?').all(limit, offset) as BuilderSessionRow[]
    return rows.map((r) => {
      const last = this.db.prepare('SELECT content FROM workflow_builder_messages WHERE builder_session_id = ? ORDER BY sequence DESC LIMIT 1').get(r.builder_session_id) as { content: string } | undefined
      return { builder_session_id: r.builder_session_id, title: r.title, status: r.status as WorkflowBuilderSessionSummary['status'], updated_at: r.updated_at, revision: r.revision, draft_ready: r.current_spec_hash !== null, processing: r.pending_turn_key !== null, last_message_preview: last ? last.content.slice(0, 140) : null }
    })
  }
  async findBuilderTurn(id: string, turnKey: string): Promise<{ user: WorkflowBuilderMessageRecord | null; assistant: WorkflowBuilderMessageRecord | null }> {
    this.open()
    const u = this.builderTurnRow(id, turnKey, 'user'); const a = this.builderTurnRow(id, turnKey, 'assistant')
    return { user: u ? this.toBuilderMessage(u) : null, assistant: a ? this.toBuilderMessage(a) : null }
  }
  async appendBuilderUserMessage(id: string, input: { content: string; turn_key?: string | null }): Promise<{ message: WorkflowBuilderMessageRecord; replay: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const s = this.builderSessionRow(id); if (!s) throw new ControlStoreError('not_found', `builder session not found: ${id}`)
      if (s.status !== 'active') throw new ControlStoreError('invalid_transition', `builder session is ${s.status}; it cannot accept new messages`)
      // Idempotent resume: the same turn_key's user message already exists → reuse it.
      if (input.turn_key != null) { const ex = this.builderTurnRow(id, input.turn_key, 'user'); if (ex) return { message: this.toBuilderMessage(ex), replay: true } }
      // In-flight guard (RACE-SAFE, atomic): while ANOTHER turn is pending, no new turn
      // may start — it would overtake the incomplete earlier turn.
      if (s.pending_turn_key != null && s.pending_turn_key !== input.turn_key) throw new ControlStoreError('builder_turn_in_progress', `a turn is already in progress on this session`)
      const message = this.insertBuilderMessageSync(id, 'user', input.content, { turn_key: input.turn_key ?? null })
      // Mark a KEYED turn as pending (recoverable), atomically WITH the user message.
      if (input.turn_key != null) this.db.prepare('UPDATE workflow_builder_sessions SET pending_turn_key=@tk, pending_turn_started_at=@now, updated_at=@now WHERE builder_session_id=@id').run({ id, tk: input.turn_key, now: nowIso() })
      return { message, replay: false }
    })()
  }
  async completeBuilderTurn(id: string, expectedRevision: number, input: { assistant: { content: string; draft_id?: string | null; spec_hash?: string | null; metadata?: Record<string, unknown> | null; turn_key?: string | null }; current_draft_id: string | null; current_spec_hash: string | null }): Promise<{ session: WorkflowBuilderSessionRecord; message: WorkflowBuilderMessageRecord; replay: boolean }> {
    this.open()
    return this.db.transaction(() => {
      const s = this.builderSessionRow(id); if (!s) throw new ControlStoreError('not_found', `builder session not found: ${id}`)
      const tk = input.assistant.turn_key ?? null
      if (tk != null) { const ex = this.builderTurnRow(id, tk, 'assistant'); if (ex) return { session: this.toBuilderSession(s), message: this.toBuilderMessage(ex), replay: true } } // idempotent turn replay (no writes, no revision bump)
      if (s.status !== 'active') throw new ControlStoreError('invalid_transition', `builder session is ${s.status}; it cannot accept new messages`)
      if (s.revision !== expectedRevision) throw new ControlStoreError('builder_revision_conflict', `session revision is ${s.revision}, not the expected ${expectedRevision}`)
      // ONE atomic completion: assistant message + current-draft pointer + revision +
      // updated_at + CLEAR the pending-turn marker. The referenced draft was finalized
      // (immutably) by the compiler beforehand; the FK guarantees this pointer can never
      // reference a missing/partial draft, and it is only ever set inside this boundary.
      const message = this.insertBuilderMessageSync(id, 'assistant', input.assistant.content, { draft_id: input.assistant.draft_id ?? null, spec_hash: input.assistant.spec_hash ?? null, metadata: input.assistant.metadata ?? null, turn_key: tk })
      this.db.prepare('UPDATE workflow_builder_sessions SET current_draft_id=@cd, current_spec_hash=@cs, revision=revision+1, pending_turn_key=NULL, pending_turn_started_at=NULL, updated_at=@now WHERE builder_session_id=@id')
        .run({ id, cd: input.current_draft_id, cs: input.current_spec_hash, now: nowIso() })
      return { session: this.toBuilderSession(this.builderSessionRow(id)!), message, replay: false }
    })()
  }
  private insertBuilderMessageSync(sessionId: string, role: string, content: string, extra: { draft_id?: string | null; spec_hash?: string | null; metadata?: Record<string, unknown> | null; turn_key?: string | null }): WorkflowBuilderMessageRecord {
    if (!BUILDER_MESSAGE_ROLES.includes(role as never)) throw new ControlStoreError('invalid_record', `invalid builder message role: ${role}`)
    const seq = this.nextBuilderSeq(sessionId); const now = nowIso(); const messageId = 'bm_' + crypto.randomBytes(12).toString('hex')
    this.db.prepare(`INSERT INTO workflow_builder_messages (message_id,builder_session_id,role,content,sequence,draft_id,spec_hash,metadata_json,turn_key,created_at)
      VALUES (@mid,@sid,@role,@content,@seq,@did,@sh,@meta,@tk,@now)`)
      .run({ mid: messageId, sid: sessionId, role, content: boundString(content, SIZE_LIMITS.input_text, 'builder.message.content'), seq, did: extra.draft_id ?? null, sh: extra.spec_hash ?? null, meta: extra.metadata != null ? encodeJson(extra.metadata, SIZE_LIMITS.metadata_json, 'builder.message.metadata') : null, tk: extra.turn_key ?? null, now })
    return this.toBuilderMessage(this.db.prepare('SELECT * FROM workflow_builder_messages WHERE message_id = ?').get(messageId) as BuilderMessageRow)
  }
  async archiveBuilderSession(id: string): Promise<WorkflowBuilderSessionRecord> {
    this.open()
    return this.db.transaction(() => {
      const s = this.builderSessionRow(id); if (!s) throw new ControlStoreError('not_found', `builder session not found: ${id}`)
      if (s.status === 'archived') return this.toBuilderSession(s) // idempotent
      this.db.prepare("UPDATE workflow_builder_sessions SET status='archived', updated_at=@now WHERE builder_session_id=@id").run({ id, now: nowIso() })
      return this.toBuilderSession(this.builderSessionRow(id)!)
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
    // Bound the idempotency key BEFORE any DB write (defense in depth; the gateway
    // validates too). The stored fingerprint is a bounded digest, never the prompt.
    let idempotency_key: string | null = null
    if (input.idempotency_key != null) {
      if (!isSafeId(input.idempotency_key)) throw new ControlStoreError('invalid_record', 'task.idempotency_key is not a safe id')
      idempotency_key = input.idempotency_key
    }
    const request_fingerprint = input.request_fingerprint != null ? boundString(input.request_fingerprint, 256, 'task.request_fingerprint') : null
    const now = nowIso()
    this.db.prepare(`INSERT INTO tasks (task_id,revision,node_id,agent,workspace_key,permission_mode,status,remote_run_id,input_text,metadata_json,created_at,updated_at,terminal_at,last_event_sequence,earliest_retained_sequence,terminal_event_recorded,error_code,error_message,idempotency_key,request_fingerprint)
      VALUES (@task_id,1,@node_id,@agent,@workspace_key,@permission_mode,@status,@remote_run_id,@input_text,@metadata_json,@now,@now,NULL,-1,0,0,NULL,NULL,@idempotency_key,@request_fingerprint)`)
      .run({ task_id: input.task_id, node_id: input.node_id ?? null, agent: input.agent, workspace_key: input.workspace_key ?? null, permission_mode: input.permission_mode ?? null, status: input.status, remote_run_id: input.remote_run_id ?? null, input_text, metadata_json, idempotency_key, request_fingerprint, now })
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
    this.db.prepare('INSERT INTO task_events (task_id,sequence,event_type,ts,payload_json,created_at,source_sequence) VALUES (?,?,?,?,?,?,?)').run(taskId, ev.sequence, ev.event_type, ev.ts, payload_json, now, ev.source_sequence ?? null)
    this.db.prepare('UPDATE tasks SET last_event_sequence = ?, updated_at = ? WHERE task_id = ?').run(ev.sequence, now, taskId)
  }

  private createWorkflowSync(input: CreateWorkflowInput): WorkflowRecord {
    validateCreateWorkflow(input)
    if (this.workflowRow(input.workflow_id)) throw new ControlStoreError('duplicate', `workflow already exists: ${input.workflow_id}`)
    const spec_json = encodeJson(input.spec, SIZE_LIMITS.spec_json, 'workflow.spec')
    // Input values are immutable, bounded, and must never carry credential/token/
    // key/PID field names (defense in depth; the runtime validates against the spec).
    let input_values_json: string | null = null
    if (input.input_values != null) {
      assertNoForbiddenFields(input.input_values, 'workflow.input_values')
      input_values_json = encodeJson(input.input_values, SIZE_LIMITS.metadata_json, 'workflow.input_values')
    }
    const now = nowIso()
    this.db.prepare(`INSERT INTO workflows (workflow_id,revision,spec_version,workflow_name,spec_json,status,current_step_id,current_round,total_tasks,total_failures,started_at,created_at,updated_at,terminal_at,last_event_sequence,context_revision,context_json,earliest_retained_sequence,input_values_json,cancel_requested)
      VALUES (@workflow_id,1,@spec_version,@workflow_name,@spec_json,@status,@current_step_id,@current_round,0,0,NULL,@now,@now,NULL,-1,0,NULL,0,@input_values_json,0)`)
      .run({ workflow_id: input.workflow_id, spec_version: input.spec_version, workflow_name: input.workflow_name, spec_json, status: input.status ?? 'draft', current_step_id: input.current_step_id ?? null, current_round: input.current_round ?? 1, input_values_json, now })
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
      // Cancellation intent is monotonic (once requested, never cleared).
      cancel_requested: patch.cancel_requested === true || cur.cancel_requested === 1 ? 1 : 0,
      now: nowIso(), rev: cur.revision + 1, workflow_id: workflowId,
    }
    this.db.prepare(`UPDATE workflows SET revision=@rev,status=@status,current_step_id=@current_step_id,current_round=@current_round,total_tasks=@total_tasks,total_failures=@total_failures,started_at=@started_at,terminal_at=@terminal_at,cancel_requested=@cancel_requested,updated_at=@now WHERE workflow_id=@workflow_id`).run(next)
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
    return { task_id: r.task_id, revision: r.revision, node_id: r.node_id, agent: r.agent, workspace_key: r.workspace_key, permission_mode: r.permission_mode, status: r.status, remote_run_id: r.remote_run_id, input_text: r.input_text, metadata: decodeJson(r.metadata_json, SIZE_LIMITS.metadata_json, 'task.metadata', true) as Record<string, unknown> | null, created_at: r.created_at, updated_at: r.updated_at, terminal_at: r.terminal_at, last_event_sequence: r.last_event_sequence, earliest_retained_sequence: r.earliest_retained_sequence, terminal_event_recorded: r.terminal_event_recorded === 1, error_code: r.error_code, error_message: r.error_message, history_incomplete: r.history_incomplete === 1, history_reason: r.history_reason, history_boundary_sequence: r.history_boundary_sequence, last_remote_event_sequence: r.last_remote_event_sequence, idempotency_key: r.idempotency_key, request_fingerprint: r.request_fingerprint, result_status: r.result_status }
  }
  private toWorkflow(r: WorkflowRow): WorkflowRecord {
    return { workflow_id: r.workflow_id, revision: r.revision, spec_version: r.spec_version, workflow_name: r.workflow_name, spec: decodeJson(r.spec_json, SIZE_LIMITS.spec_json, 'workflow.spec'), status: r.status, current_step_id: r.current_step_id, current_round: r.current_round, total_tasks: r.total_tasks, total_failures: r.total_failures, started_at: r.started_at, created_at: r.created_at, updated_at: r.updated_at, terminal_at: r.terminal_at, last_event_sequence: r.last_event_sequence, context_revision: r.context_revision, earliest_retained_sequence: r.earliest_retained_sequence, input_values: decodeJson(r.input_values_json, SIZE_LIMITS.metadata_json, 'workflow.input_values', true) as Record<string, unknown> | null, cancel_requested: r.cancel_requested === 1 }
  }
  private toStep(r: StepRow): StepExecutionRecord {
    return { step_execution_id: r.step_execution_id, workflow_id: r.workflow_id, step_id: r.step_id, round: r.round, attempt: r.attempt, task_id: r.task_id, revision: r.revision, status: r.status, output: decodeJson(r.output_json, SIZE_LIMITS.step_output_json, 'step.output'), error: decodeJson(r.error_json, SIZE_LIMITS.step_error_json, 'step.error'), created_at: r.created_at, started_at: r.started_at, updated_at: r.updated_at, terminal_at: r.terminal_at, revision_before: this.decodeRevision(r.revision_before_json, 'step.revision_before'), revision_after: this.decodeRevision(r.revision_after_json, 'step.revision_after'), result_awaited_since: r.result_awaited_since ?? null }
  }
}

// ── row shapes ─────────────────────────────────────────────────────────────────
interface TaskRow { task_id: string; revision: number; node_id: string | null; agent: string; workspace_key: string | null; permission_mode: string | null; status: string; remote_run_id: string | null; input_text: string | null; metadata_json: string | null; created_at: string; updated_at: string; terminal_at: string | null; last_event_sequence: number; earliest_retained_sequence: number; terminal_event_recorded: number; error_code: string | null; error_message: string | null; history_incomplete: number; history_reason: string | null; history_boundary_sequence: number | null; last_remote_event_sequence: number | null; idempotency_key: string | null; request_fingerprint: string | null; result_status: string | null }
interface TaskResultRow { task_id: string; schema_version: string; result_status: string; final_output_text: string | null; process_exit_code: number | null; finalized_at: string | null; content_hash: string | null; evidence_refs_json: string; artifact_refs_json: string; verification_json: string | null; created_at: string }
interface TaskEventRow { task_id: string; sequence: number; event_type: string; ts: string; payload_json: string; created_at: string; source_sequence: number | null }
interface WorkflowRow { workflow_id: string; revision: number; spec_version: string; workflow_name: string; spec_json: string; status: string; current_step_id: string | null; current_round: number; total_tasks: number; total_failures: number; started_at: string | null; created_at: string; updated_at: string; terminal_at: string | null; last_event_sequence: number; context_revision: number; context_json: string | null; earliest_retained_sequence: number; input_values_json: string | null; cancel_requested: number }
interface StepRow { step_execution_id: string; workflow_id: string; step_id: string; round: number; attempt: number; task_id: string | null; revision: number; status: string; output_json: string | null; error_json: string | null; created_at: string; started_at: string | null; updated_at: string; terminal_at: string | null; revision_before_json: string | null; revision_after_json: string | null; result_awaited_since: string | null }
interface WorkspaceLeaseRow { workspace_lease_id: string; workflow_id: string; node_id: string; workspace_key: string; mode: string; status: string; revision: number; base_revision_json: string | null; current_revision_json: string | null; acquired_at: string | null; release_requested_at: string | null; released_at: string | null; acquire_reason: string | null; created_at: string; updated_at: string }
interface HumanRequestRow { request_id: string; workflow_id: string; step_execution_id: string; kind: string; prompt: string; choices_json: string | null; status: string; response_value: string | null; created_at: string; responded_at: string | null; updated_at: string; revision: number }
interface DraftRow { draft_id: string; idempotency_key: string | null; request_fingerprint: string | null; compiler_task_id: string | null; compiler_capability_json: string | null; constraints_json: string | null; inventory_snapshot_json: string | null; inventory_hash: string | null; spec_json: string | null; input_values_json: string | null; spec_hash: string | null; policy_summary_json: string | null; policy_summary_hash: string | null; preview_json: string | null; rationale_json: string | null; warnings_json: string | null; questions_json: string | null; compiler_status: string; validation_status: string; approval_status: string; materialized_workflow_id: string | null; created_at: string; updated_at: string }
interface BuilderSessionRow { builder_session_id: string; title: string; status: string; current_draft_id: string | null; current_spec_hash: string | null; revision: number; source_workflow_id: string | null; compiler_agent: string | null; compiler_node_id: string | null; pending_turn_key: string | null; pending_turn_started_at: string | null; created_at: string; updated_at: string }
interface BuilderMessageRow { message_id: string; builder_session_id: string; role: string; content: string; sequence: number; draft_id: string | null; spec_hash: string | null; metadata_json: string | null; turn_key: string | null; created_at: string }
interface WorkflowEventRow { workflow_id: string; sequence: number; event_type: string; ts: string; step_execution_id: string | null; payload_json: string; created_at: string }

/** A better-sqlite3 UNIQUE/PRIMARYKEY constraint violation (the idempotency-key
 *  index is the final authority under concurrent cross-connection inserts). */
function isUniqueConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as unknown as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')
}

function clampLimit(n?: number): number { return Number.isInteger(n) && (n as number) > 0 ? Math.min(n as number, 10000) : 1000 }
function clampOffset(n?: number): number { return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 0 }
