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

export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: V1 }, { version: 2, sql: V2 }]
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
