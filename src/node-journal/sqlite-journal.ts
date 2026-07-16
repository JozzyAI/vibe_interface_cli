/**
 * SQLite-backed {@link NodeJournal} (better-sqlite3, hidden behind the interface).
 *
 * Durable, single-file, WAL. Opens securely (rejects a symlinked path; user-only
 * where POSIX permits), enforces the contiguous 0-based NODE source-sequence per
 * `remote_run_id`, journals BEFORE publishing, and provides a race-free replay→live
 * subscription with bounded per-subscriber queues. A SEPARATE file from the
 * Gateway `control.sqlite`. NOT the Gateway task-event domain.
 *
 * The journal contains only the canonical remote-run event protocol data (private
 * local data — agent output may include sensitive repository content, so the DB is
 * 0600). It NEVER stores relay/Gateway tokens, encryption keys, env dumps, native
 * credentials, prompt-file paths, or backend process internals.
 */
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { vibeDir } from '../config.js'
import {
  JournalError, JOURNAL_LIMITS, JOURNAL_SCHEMA_VERSION, NODE_RUN_EVENT_TYPES, RUN_EVENT_REPLAY_CAPABILITY,
  type NodeRunEvent, type NodeRunEventInput, type NodeRunMeta, type ReplayMetadata,
} from './contract.js'
import { nowIso, isIsoUtc, encodeJson, decodeJson } from './serialization.js'
import { pruneTerminalRuns, pruneRunEvents } from './retention.js'
import type { NodeJournal, JournalHealth, JournalSubscription, SubscribeOptions, NodeRunResult } from './store.js'
import { validateTaskResult, MAX_FINAL_OUTPUT_BYTES, type AgentTaskResultV1 } from '../lib/agent-task-result.js'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled'])
const DEFAULT_BUSY_TIMEOUT_MS = 5000
const DEFAULT_MAX_QUEUE = 1000

export interface OpenJournalOptions { path?: string; busyTimeoutMs?: number }

/** Open (creating if needed), migrate, and return a ready Node journal. */
export function openNodeJournal(opts: OpenJournalOptions = {}): SqliteNodeJournal {
  const dbPath = opts.path ? path.resolve(opts.path) : path.join(vibeDir(), 'node-run-journal.sqlite')
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { if (fs.lstatSync(p).isSymbolicLink()) throw new JournalError('invalid_record', `refusing to open a symlinked journal path`) } catch (e) { if (e instanceof JournalError) throw e }
    }
  }
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma(`busy_timeout = ${Number.isInteger(opts.busyTimeoutMs) ? opts.busyTimeoutMs : DEFAULT_BUSY_TIMEOUT_MS}`)
  if (dbPath !== ':memory:' && process.platform !== 'win32') {
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.chmodSync(p, 0o600) } catch { /* sidecar may not exist yet */ } }
  }
  const j = new SqliteNodeJournal(db, dbPath)
  j.migrate()
  return j
}

// ── migrations (ordered, transactional, idempotent, fail-closed) ─────────────

const V1 = `
CREATE TABLE runs (
  remote_run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  terminal_at TEXT,
  last_sequence INTEGER NOT NULL DEFAULT -1,
  earliest_retained_sequence INTEGER NOT NULL DEFAULT 0,
  terminal_event_recorded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE run_events (
  remote_run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (remote_run_id, sequence),
  FOREIGN KEY (remote_run_id) REFERENCES runs(remote_run_id) ON DELETE CASCADE
);
CREATE INDEX idx_runs_terminal_at ON runs(terminal_at);
`
/** Journal v2 — durable first-class AgentTaskResult, keyed by remote_run_id
 *  (immutable content). Additive; the result is NEVER derived from run events.
 *  No token/key/credential/PID/prompt-path ever enters this table. */
const V2 = `
CREATE TABLE run_results (
  remote_run_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  result_status TEXT NOT NULL,
  final_output_text TEXT,
  process_exit_code INTEGER,
  finalized_at TEXT,
  content_hash TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (remote_run_id) REFERENCES runs(remote_run_id) ON DELETE CASCADE
);
`
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [{ version: 1, sql: V1 }, { version: 2, sql: V2 }]
export const LATEST_JOURNAL_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
const LATEST = LATEST_JOURNAL_SCHEMA_VERSION

function journalSchemaVersion(db: BetterSqlite3.Database): number {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) return 0
  let rows: Array<{ version: unknown }>
  try { rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: unknown }> } catch { throw new JournalError('corruption', 'schema_migrations unreadable') }
  let max = 0
  for (const r of rows) { if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) throw new JournalError('corruption', 'malformed schema version'); if (r.version > max) max = r.version }
  return max
}

/** Apply pending journal migrations (ordered, transactional, idempotent,
 *  fail-closed on unknown-newer). Exported for focused tests. */
export function runJournalMigrations(db: BetterSqlite3.Database): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const current = journalSchemaVersion(db)
  if (current > LATEST) throw new JournalError('unsupported_schema_version', `journal schema ${current} is newer than supported ${LATEST}`)
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.transaction(() => { db.exec(m.sql); db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, nowIso()) })()
  }
  return LATEST
}

// ── in-memory subscriber (bounded queue; race-free replay→live) ──────────────

interface Sub {
  runId: string
  cutoff: number // greatest sequence delivered by replay; live = seq > cutoff
  onEvent: (e: NodeRunEvent) => void
  onOverflow?: () => void
  maxQueue: number
  queue: NodeRunEvent[]
  draining: boolean
  overflowed: boolean
  closed: boolean
}

interface RunRow { remote_run_id: string; created_at: string; updated_at: string; status: string; terminal_at: string | null; last_sequence: number; earliest_retained_sequence: number; terminal_event_recorded: number }
interface ResultRow { remote_run_id: string; schema_version: string; result_status: string; final_output_text: string | null; process_exit_code: number | null; finalized_at: string | null; content_hash: string | null; evidence_refs_json: string; artifact_refs_json: string; created_at: string }
function boundFinal(text: string): string { if (Buffer.byteLength(text, 'utf8') > MAX_FINAL_OUTPUT_BYTES) throw new JournalError('too_large', 'run_result.final_output exceeds the size limit'); return text }
interface EventRow { remote_run_id: string; sequence: number; type: string; ts: string; payload_json: string; created_at: string }

export class SqliteNodeJournal implements NodeJournal {
  private closed = false
  private readonly subs = new Map<string, Set<Sub>>()

  constructor(private readonly db: BetterSqlite3.Database, readonly dbPath: string) {}

  // ── lifecycle ──────────────────────────────────────────────────────────────
  migrate(): number { this.open(); return runJournalMigrations(this.db) }
  healthCheck(): JournalHealth {
    this.open()
    return { ok: true, schema_version: (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0, foreign_keys: this.db.pragma('foreign_keys', { simple: true }) === 1, journal_mode: String(this.db.pragma('journal_mode', { simple: true })), busy_timeout: Number(this.db.pragma('busy_timeout', { simple: true })) }
  }
  close(): void {
    if (this.closed) return
    for (const set of this.subs.values()) for (const s of set) { s.closed = true }
    this.subs.clear()
    this.db.close(); this.closed = true
  }
  private open(): void { if (this.closed) throw new JournalError('closed', 'node journal is closed') }

  // ── capture ──────────────────────────────────────────────────────────────────
  ensureRun(remoteRunId: string, status = 'running'): NodeRunMeta {
    this.open(); this.assertId(remoteRunId)
    const existing = this.runRow(remoteRunId)
    if (existing) return this.toMeta(existing)
    const now = nowIso()
    this.db.prepare('INSERT INTO runs (remote_run_id, created_at, updated_at, status, terminal_at, last_sequence, earliest_retained_sequence, terminal_event_recorded) VALUES (?,?,?,?,NULL,-1,0,0)').run(remoteRunId, now, now, status)
    return this.toMeta(this.runRow(remoteRunId)!)
  }

  append(remoteRunId: string, event: NodeRunEventInput): NodeRunEvent {
    this.open()
    this.ensureRun(remoteRunId)
    const run = this.runRow(remoteRunId)!
    if (run.terminal_event_recorded) throw new JournalError('invalid_transition', 'run is already terminal; no further events')
    const seq = run.last_sequence + 1
    const stored = this.insertEvent(remoteRunId, seq, event)
    this.fanout(remoteRunId, stored)
    return stored
  }

  appendAt(remoteRunId: string, sequence: number, event: NodeRunEventInput): { event: NodeRunEvent; duplicate: boolean } {
    this.open(); this.ensureRun(remoteRunId)
    if (!Number.isInteger(sequence) || sequence < 0) throw new JournalError('invalid_record', 'sequence must be a non-negative integer')
    const run = this.runRow(remoteRunId)!
    const payload_json = this.validate(event)
    if (sequence <= run.last_sequence) {
      const existing = this.db.prepare('SELECT * FROM run_events WHERE remote_run_id = ? AND sequence = ?').get(remoteRunId, sequence) as EventRow | undefined
      if (!existing) throw new JournalError('event_gap', `missing event below high-water mark at ${sequence}`)
      if (existing.type !== event.type || existing.ts !== event.timestamp || existing.payload_json !== payload_json) throw new JournalError('event_conflict', `conflicting event at sequence ${sequence}`)
      return { event: this.toEvent(existing), duplicate: true }
    }
    if (sequence !== run.last_sequence + 1) throw new JournalError('event_gap', `gap: expected ${run.last_sequence + 1}, got ${sequence}`)
    if (run.terminal_event_recorded) throw new JournalError('invalid_transition', 'run is already terminal; no further events')
    const stored = this.insertEvent(remoteRunId, sequence, event, payload_json)
    this.fanout(remoteRunId, stored)
    return { event: stored, duplicate: false }
  }

  private validate(event: NodeRunEventInput): string {
    if (typeof event.type !== 'string' || !NODE_RUN_EVENT_TYPES.includes(event.type)) throw new JournalError('invalid_record', 'unsupported run event type')
    if (!isIsoUtc(event.timestamp)) throw new JournalError('invalid_record', 'timestamp must be ISO-8601 UTC')
    return encodeJson(event.payload ?? null, JOURNAL_LIMITS.event_payload_bytes, 'run_event.payload')
  }

  private insertEvent(remoteRunId: string, seq: number, event: NodeRunEventInput, precomputedPayload?: string): NodeRunEvent {
    if (seq >= JOURNAL_LIMITS.events_per_run) throw new JournalError('events_per_run_exceeded', `events per run exceeds ${JOURNAL_LIMITS.events_per_run}`)
    const payload_json = precomputedPayload ?? this.validate(event)
    const now = nowIso()
    const terminal = event.terminal === true
    const status = event.status ?? (terminal ? 'completed' : null)
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO run_events (remote_run_id, sequence, type, ts, payload_json, created_at) VALUES (?,?,?,?,?,?)').run(remoteRunId, seq, event.type, event.timestamp, payload_json, now)
      this.db.prepare('UPDATE runs SET last_sequence = ?, updated_at = ?, status = COALESCE(?, status), terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END, terminal_event_recorded = CASE WHEN ? THEN 1 ELSE terminal_event_recorded END WHERE remote_run_id = ?')
        .run(seq, now, status, terminal ? 1 : 0, now, terminal ? 1 : 0, remoteRunId)
    })()
    return { remote_run_id: remoteRunId, sequence: seq, type: event.type, timestamp: event.timestamp, payload: event.payload }
  }

  markStatus(remoteRunId: string, status: string, terminalAt?: string | null): NodeRunMeta {
    this.open()
    const run = this.runRow(remoteRunId); if (!run) throw new JournalError('not_found', 'run not found')
    if (run.terminal_event_recorded && !TERMINAL_STATUSES.has(status)) throw new JournalError('invalid_transition', 'terminal run cannot regress to non-terminal')
    this.db.prepare('UPDATE runs SET status = ?, updated_at = ?, terminal_at = COALESCE(?, terminal_at) WHERE remote_run_id = ?').run(status, nowIso(), terminalAt ?? null, remoteRunId)
    return this.toMeta(this.runRow(remoteRunId)!)
  }

  // ── durable AgentTaskResult (immutable; never derived from run events) ───────
  private resultRow(remoteRunId: string): ResultRow | undefined { return this.db.prepare('SELECT * FROM run_results WHERE remote_run_id = ?').get(remoteRunId) as ResultRow | undefined }
  /** Idempotent-duplicate check over the COMPLETE normalized immutable envelope
   *  (schema_version, final_output, process_exit_code, content_hash, evidence_refs,
   *  artifact_refs) — NOT merely content_hash. finalized_at is excluded (the first
   *  finalization's timestamp is preserved). */
  private resultMatches(row: ResultRow, resultStatus: string, result: AgentTaskResultV1 | null): boolean {
    if (row.result_status !== resultStatus) return false
    if (result === null) return row.content_hash === null
    return row.schema_version === result.schema_version
      && row.content_hash === result.content_hash
      && (row.final_output_text ?? '') === result.final_output.text
      && (row.process_exit_code ?? null) === (result.process_exit_code ?? null)
      && row.evidence_refs_json === encodeJson(result.evidence_refs ?? [], 256 * 1024, 'run_result.evidence_refs')
      && row.artifact_refs_json === encodeJson(result.artifact_refs ?? [], 256 * 1024, 'run_result.artifact_refs')
  }
  persistRunResult(remoteRunId: string, resultStatus: string, result: AgentTaskResultV1 | null): { applied: boolean } {
    this.open(); this.assertId(remoteRunId)
    return this.db.transaction(() => {
      this.ensureRun(remoteRunId)
      const existing = this.resultRow(remoteRunId)
      if (existing) { if (this.resultMatches(existing, resultStatus, result)) return { applied: false }; throw new JournalError('result_conflict', 'a different run result already exists (content mismatch)') }
      const now = nowIso()
      this.db.prepare(`INSERT INTO run_results (remote_run_id,schema_version,result_status,final_output_text,process_exit_code,finalized_at,content_hash,evidence_refs_json,artifact_refs_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        remoteRunId, result?.schema_version ?? '1', resultStatus,
        result ? boundFinal(result.final_output.text) : null,
        result?.process_exit_code ?? null, result?.finalized_at ?? null, result?.content_hash ?? null,
        encodeJson(result?.evidence_refs ?? [], 256 * 1024, 'run_result.evidence_refs'),
        encodeJson(result?.artifact_refs ?? [], 256 * 1024, 'run_result.artifact_refs'), now,
      )
      return { applied: true }
    })()
  }
  getRunResult(remoteRunId: string): NodeRunResult | null {
    this.open()
    const row = this.resultRow(remoteRunId); if (!row) return null
    if (row.result_status !== 'available') return { remote_run_id: remoteRunId, result_status: row.result_status, result: null }
    const v = validateTaskResult({ schema_version: row.schema_version, final_output: { kind: 'text', text: row.final_output_text ?? '' }, process_exit_code: row.process_exit_code, finalized_at: row.finalized_at ?? '', content_hash: row.content_hash ?? '', evidence_refs: decodeJson(row.evidence_refs_json, 256 * 1024, 'run_result.evidence_refs'), artifact_refs: decodeJson(row.artifact_refs_json, 256 * 1024, 'run_result.artifact_refs') })
    if (!v.ok) throw new JournalError('corruption', `persisted run result is invalid (${v.code})`)
    return { remote_run_id: remoteRunId, result_status: 'available', result: v.value }
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  getRun(remoteRunId: string): NodeRunMeta | null { this.open(); const r = this.runRow(remoteRunId); return r ? this.toMeta(r) : null }
  readEvents(remoteRunId: string, afterSequence: number, limit = 100_000): NodeRunEvent[] {
    this.open()
    return (this.db.prepare('SELECT * FROM run_events WHERE remote_run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?').all(remoteRunId, afterSequence, limit) as EventRow[]).map((r) => this.toEvent(r))
  }
  replayMetadata(remoteRunId: string, afterSequence: number): ReplayMetadata | null {
    this.open(); const run = this.runRow(remoteRunId); if (!run) return null
    // The requested prefix starts at afterSequence+1; history is complete for the
    // request iff that start is still retained (not pruned away).
    const complete = (afterSequence + 1) >= run.earliest_retained_sequence
    return { earliest_retained_sequence: run.earliest_retained_sequence, latest_sequence: run.last_sequence, history_complete_for_request: complete, status: run.status, terminal: run.terminal_event_recorded === 1, replay_capability: RUN_EVENT_REPLAY_CAPABILITY }
  }

  // ── race-free replay → live subscription ─────────────────────────────────────
  subscribe(remoteRunId: string, opts: SubscribeOptions): JournalSubscription {
    this.open()
    // This whole method is SYNCHRONOUS with no await, and `append` is synchronous
    // too, so (single-threaded) an event is EITHER read by the replay snapshot
    // below OR fanned out live after registration — never both, never neither.
    const meta = this.replayMetadata(remoteRunId, opts.afterSequence)
    const sub: Sub = { runId: remoteRunId, cutoff: opts.afterSequence, onEvent: opts.onEvent, onOverflow: opts.onOverflow, maxQueue: opts.maxQueue ?? DEFAULT_MAX_QUEUE, queue: [], draining: false, overflowed: false, closed: false }
    if (meta) opts.onEstablished?.(meta)
    // Snapshot cutoff = current last_sequence; replay (afterSequence, cutoff].
    const cutoff = meta ? meta.latest_sequence : opts.afterSequence
    const replay = this.readEvents(remoteRunId, opts.afterSequence)
    // Register BEFORE delivering replay so nothing appended mid-delivery is missed.
    sub.cutoff = cutoff
    let set = this.subs.get(remoteRunId); if (!set) { set = new Set(); this.subs.set(remoteRunId, set) }
    set.add(sub)
    // Replay is a bounded pull the consumer requested → deliver directly (not via
    // the live backpressure queue), in order.
    for (const ev of replay) { if (sub.closed || sub.overflowed) break; try { sub.onEvent(ev) } catch { /* consumer error must not corrupt the journal */ } }
    const handle: JournalSubscription = {
      remote_run_id: remoteRunId,
      get overflowed() { return sub.overflowed },
      get closed() { return sub.closed },
      close: () => { sub.closed = true; this.subs.get(remoteRunId)?.delete(sub) },
    }
    return handle
  }

  private fanout(remoteRunId: string, ev: NodeRunEvent): void {
    const set = this.subs.get(remoteRunId); if (!set) return
    for (const sub of set) {
      if (sub.closed || sub.overflowed) continue
      if (ev.sequence <= sub.cutoff) continue // already covered by replay
      sub.queue.push(ev)
      if (sub.queue.length > sub.maxQueue) { this.overflow(sub); continue }
      this.scheduleDrain(sub)
    }
  }
  private overflow(sub: Sub): void {
    sub.overflowed = true; sub.queue.length = 0
    this.subs.get(sub.runId)?.delete(sub)
    try { sub.onOverflow?.() } catch { /* ignore */ }
  }
  private scheduleDrain(sub: Sub): void {
    if (sub.draining) return
    sub.draining = true
    setImmediate(() => {
      sub.draining = false
      while (sub.queue.length && !sub.closed && !sub.overflowed) {
        const ev = sub.queue.shift()!
        try { sub.onEvent(ev) } catch { /* consumer error must not corrupt the journal */ }
      }
    })
  }

  // ── retention ─────────────────────────────────────────────────────────────
  pruneTerminalRuns(olderThanIso: string): { removed: number } { this.open(); return pruneTerminalRuns(this.db, olderThanIso) }
  pruneRunEvents(remoteRunId: string, keepLast: number): { removed: number } { this.open(); return pruneRunEvents(this.db, remoteRunId, keepLast) }

  // ── mappers ─────────────────────────────────────────────────────────────────
  private runRow(id: string): RunRow | undefined { return this.db.prepare('SELECT * FROM runs WHERE remote_run_id = ?').get(id) as RunRow | undefined }
  private assertId(id: string): void { if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new JournalError('invalid_record', 'invalid remote_run_id') }
  private toMeta(r: RunRow): NodeRunMeta { return { remote_run_id: r.remote_run_id, created_at: r.created_at, updated_at: r.updated_at, status: r.status, terminal_at: r.terminal_at, last_sequence: r.last_sequence, earliest_retained_sequence: r.earliest_retained_sequence, terminal_event_recorded: r.terminal_event_recorded === 1, schema_version: JOURNAL_SCHEMA_VERSION } }
  private toEvent(r: EventRow): NodeRunEvent { return { remote_run_id: r.remote_run_id, sequence: r.sequence, type: r.type, timestamp: r.ts, payload: decodeJson(r.payload_json, JOURNAL_LIMITS.event_payload_bytes, 'run_event.payload') } }
}
