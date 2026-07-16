/**
 * Ordered, transactional, idempotent schema migrations for the control store.
 * `migrate()` applies pending migrations in order inside transactions; unknown
 * NEWER schema versions fail closed; there is no destructive downgrade and an
 * existing valid DB is never dropped or recreated.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { ControlStoreError } from './records.js'

export interface Migration { version: number; sql: string }

/** Schema v1 — the durable control store. All timestamps are ISO-8601 UTC text. */
const V1 = `
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  node_id TEXT,
  agent TEXT NOT NULL,
  workspace_key TEXT,
  permission_mode TEXT,
  status TEXT NOT NULL,
  remote_run_id TEXT,
  input_text TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  last_event_sequence INTEGER NOT NULL DEFAULT -1,
  earliest_retained_sequence INTEGER NOT NULL DEFAULT 0,
  terminal_event_recorded INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_terminal_at ON tasks(terminal_at);

CREATE TABLE task_events (
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  ts TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, sequence),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE workflows (
  workflow_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  spec_version TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step_id TEXT,
  current_round INTEGER NOT NULL,
  total_tasks INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  last_event_sequence INTEGER NOT NULL DEFAULT -1,
  context_revision INTEGER NOT NULL DEFAULT 0,
  context_json TEXT,
  earliest_retained_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_workflows_status ON workflows(status);

CREATE TABLE workflow_step_executions (
  step_execution_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  task_id TEXT,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE (workflow_id, step_id, round, attempt),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE SET NULL
);
CREATE INDEX idx_stepexec_workflow ON workflow_step_executions(workflow_id);

CREATE TABLE workflow_events (
  workflow_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  ts TEXT NOT NULL,
  step_execution_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, sequence),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  FOREIGN KEY (step_execution_id) REFERENCES workflow_step_executions(step_execution_id) ON DELETE SET NULL
);
`

/** Schema v2 — persisted task event-history completeness metadata (machine-
 *  readable; survives restart). Additive columns only (no destructive rewrite). */
const V2 = `
ALTER TABLE tasks ADD COLUMN history_incomplete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN history_reason TEXT;
ALTER TABLE tasks ADD COLUMN history_boundary_sequence INTEGER;
`

/** Schema v3 — Gateway ⇄ Node source-event replay. `last_remote_event_sequence`
 *  is the greatest durably-mapped NODE source cursor (NULL = unknown, -1 = known
 *  but nothing consumed, >=0 = a real cursor). `source_sequence` maps a persisted
 *  canonical task event to its NODE source sequence (NULL for Gateway-generated /
 *  non-Node events). The partial unique index enforces one canonical event per
 *  (task, source_sequence). Additive only — v1/v2 are never rewritten. NODE source
 *  sequence and Gateway TaskEvent sequence remain DISTINCT domains. */
const V3 = `
ALTER TABLE tasks ADD COLUMN last_remote_event_sequence INTEGER;
ALTER TABLE task_events ADD COLUMN source_sequence INTEGER;
CREATE UNIQUE INDEX idx_task_events_source ON task_events(task_id, source_sequence) WHERE source_sequence IS NOT NULL;
`

/** Schema v4 — idempotent task creation. `idempotency_key` is an OPTIONAL client-
 *  supplied stable identifier (e.g. a future workflow step_execution_id); the
 *  partial unique index enforces at most one durable task per non-null key (the
 *  authoritative create-or-return primitive). `request_fingerprint` is a
 *  deterministic digest of the normalized semantic request (NOT the prompt) used
 *  to detect a same-key request whose meaning changed (→ conflict). Both are
 *  nullable (legacy/non-idempotent tasks stay NULL). The key is NOT a task id, a
 *  credential, or a remote run id. Additive only — v1/v2/v3 are never rewritten. */
const V4 = `
ALTER TABLE tasks ADD COLUMN idempotency_key TEXT;
ALTER TABLE tasks ADD COLUMN request_fingerprint TEXT;
CREATE UNIQUE INDEX idx_tasks_idempotency_key ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
`

/** Schema v5 — durable Workflow Runtime state. `input_values_json` holds the
 *  IMMUTABLE validated workflow input values (bounded; validated against
 *  WorkflowSpec.inputs before creation; never credentials). `cancel_requested`
 *  durably records cancellation intent BEFORE remote task cancellation so a
 *  runtime/Gateway restart resumes the cancellation instead of starting new steps.
 *  Additive only — v1–v4 are never rewritten; legacy workflows keep NULL / 0. */
const V5 = `
ALTER TABLE workflows ADD COLUMN input_values_json TEXT;
ALTER TABLE workflows ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
`

/** Schema v6 — first-class durable AgentTaskResult. `task_results` is the
 *  authoritative control result of a task (keyed by the PUBLIC task_id, immutable
 *  content). `tasks.result_status` is a bounded projection for the task API. The
 *  result is NEVER derived from Gateway event history. Additive only — v1–v5 are
 *  never rewritten; legacy tasks keep NULL. No token/key/credential/PID/prompt-path
 *  ever enters these rows. */
const V6 = `
CREATE TABLE task_results (
  task_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  result_status TEXT NOT NULL,
  final_output_text TEXT,
  process_exit_code INTEGER,
  finalized_at TEXT,
  content_hash TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
ALTER TABLE tasks ADD COLUMN result_status TEXT;
`

/** Schema v7 — durable Workflow workspace-lease PROJECTION for recovery/inspection
 *  (the Node remains authoritative). At most one active lease projection per
 *  (workflow_id, node_id, workspace_key). Additive; no secrets; revisions bounded. */
const V7 = `
CREATE TABLE workflow_workspace_leases (
  workspace_lease_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'exclusive',
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  base_revision_json TEXT,
  current_revision_json TEXT,
  acquired_at TEXT,
  release_requested_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_wf_ws_lease_active ON workflow_workspace_leases(workflow_id, node_id, workspace_key)
  WHERE status IN ('acquiring','active','release_requested');
`

/** Schema v8 — per-step workspace revision evidence for the Workflow Runtime lease
 *  lifecycle. Additive nullable columns: the revision observed BEFORE a step's task
 *  is created and AFTER that task terminalizes, for out-of-band change detection.
 *  Bounded JSON (a WorkspaceRevision); no diff content, no secrets. */
const V8 = `
ALTER TABLE workflow_step_executions ADD COLUMN revision_before_json TEXT;
ALTER TABLE workflow_step_executions ADD COLUMN revision_after_json TEXT;
`

/** Schema v9 — durable HUMAN PAUSE requests (input / approval gates). At most one
 *  active request per step execution. Additive; bounded prompt/choices/value; no
 *  secrets. Enables waiting_input / waiting_approval / resume without event replay. */
const V9 = `
CREATE TABLE workflow_human_requests (
  request_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_execution_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  choices_json TEXT,
  status TEXT NOT NULL,
  response_value TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (step_execution_id),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  FOREIGN KEY (step_execution_id) REFERENCES workflow_step_executions(step_execution_id) ON DELETE CASCADE
);
CREATE INDEX idx_human_req_wf ON workflow_human_requests(workflow_id, status);
`

export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: V1 }, { version: 2, sql: V2 }, { version: 3, sql: V3 }, { version: 4, sql: V4 }, { version: 5, sql: V5 }, { version: 6, sql: V6 }, { version: 7, sql: V7 }, { version: 8, sql: V8 }, { version: 9, sql: V9 }]
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

function readCurrentVersion(db: BetterSqlite3.Database): number {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
  if (!has) return 0
  let rows: Array<{ version: unknown }>
  try { rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: unknown }> }
  catch { throw new ControlStoreError('corruption', 'schema_migrations table is unreadable') }
  let max = 0
  for (const r of rows) {
    if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) throw new ControlStoreError('corruption', 'schema_migrations contains a malformed version')
    if (r.version > max) max = r.version
  }
  return max
}

/**
 * Apply all pending migrations. Idempotent (a DB already at the latest version
 * applies nothing). Each migration + its version row commit in ONE transaction,
 * so a failure rolls back. A DB reporting a version NEWER than we know fails
 * closed (`unsupported_schema_version`).
 */
export function runMigrations(db: BetterSqlite3.Database): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const current = readCurrentVersion(db)
  if (current > LATEST_SCHEMA_VERSION) throw new ControlStoreError('unsupported_schema_version', `database schema version ${current} is newer than supported ${LATEST_SCHEMA_VERSION}`)
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    const apply = db.transaction(() => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString())
    })
    apply()
  }
  return LATEST_SCHEMA_VERSION
}
