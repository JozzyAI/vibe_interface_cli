# Durable control store

A local, single-file **SQLite** persistence layer for Agent Gateway tasks and
canonical task events, plus workflow definitions, execution state, step
executions, workflow events, and workflow context/checkpoints.

> **Scope — foundation only.** This module is **not** wired into the running
> Agent Gateway or any workflow runtime yet. It creates no externally observable
> runtime behavior change; it is exercised only by its own tests. Deliberately
> **out of scope** here: Gateway startup recovery, live task-persistence wiring,
> remote stream reattachment, a Node event journal/replay, workflow execution or
> scheduling, LLM generation, HTTP/MCP workflow tools, UI, approvals, artifacts,
> A2A, and multi-user auth.

Module: [`src/control/`](../src/control) — `store.ts` (the async `ControlStore`
interface), `records.ts` (record contracts + errors), `serialization.ts` (safe
JSON + bounds + secret rejection), `migrations.ts` (schema), `sqlite-store.ts`
(the SQLite implementation). SQLite logic lives **only** here — never in
`agent-gateway.ts` or workflow modules.

## Why SQLite (and which driver)

Task/workflow recovery needs durable, transactional, queryable local state with
real crash-safety — a single embedded SQL database fits far better than ad-hoc
JSON files. The repo targets **Node 20** (ESM), so the built-in `node:sqlite`
(Node 22.5+, experimental, flag-gated) is **not** used — we do not raise the
minimum Node version merely to reach a newer built-in API. We use
**`better-sqlite3`** (v12): maintained, synchronous, file-backed with real WAL,
and shipping prebuilt binaries for common platforms (incl. linux-x64 / Node 20).

**Portability implications:** `better-sqlite3` is a **native** module (the repo's
first). Installs use a prebuilt binary where available and otherwise compile via
`node-gyp` (needs a C++ toolchain). It is hidden entirely behind the
`ControlStore` interface, so the driver can be swapped later without touching
callers. The synchronous driver is wrapped in an **async** interface so a future
async backend is a drop-in.

## Database location & permissions

Default path derives from the existing Vibe data directory via the repo's
`vibeDir()` helper: **`<vibe_dir>/control.sqlite`** (no new home-dir
convention). The path is **configurable** (`openControlStore({ path })`), and
**tests always use isolated temporary databases** — the suite creates no
production database.

- The parent directory follows existing Vibe-directory behavior.
- On open, the DB path and its `-wal`/`-shm` sidecars are refused if they are
  **symlinks** (no symlink-following).
- Where the platform permits (non-Windows), the DB and sidecars are `chmod 0600`
  (user-only) — no world-readable task/workflow database. On Windows, POSIX file
  modes are not enforced identically.

`PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, and a bounded
`PRAGMA busy_timeout` are set on every open; multi-record updates run inside
explicit transactions.

## Schema (v1)

`schema_migrations(version, applied_at)` tracks applied migrations. Tables:

- **tasks** — `task_id` (pk), `revision`, `node_id`, `agent`, `workspace_key?`,
  `permission_mode?`, `status`, `remote_run_id?` (internal), `input_text?`
  (bounded canonical input), `metadata_json`, timestamps, `terminal_at?`,
  `last_event_sequence`, `earliest_retained_sequence`, `terminal_event_recorded`,
  `error_code?`, `error_message?` (sanitized).
- **task_events** — (`task_id`,`sequence`) pk, `event_type`, `ts`,
  `payload_json`, FK→tasks (cascade). Append-only.
- **workflows** — `workflow_id` (pk), `revision`, `spec_version`,
  `workflow_name`, `spec_json` (the exact validated `WorkflowSpec`), `status`,
  `current_step_id?`, `current_round`, `total_tasks`, `total_failures`,
  timestamps, `terminal_at?`, `last_event_sequence`, `context_revision`,
  `context_json?`, `earliest_retained_sequence`.
- **workflow_step_executions** — `step_execution_id` (pk),
  unique(`workflow_id`,`step_id`,`round`,`attempt`), `task_id?`, `revision`,
  `status`, `output_json?`, `error_json?` (sanitized), timestamps; FK→workflows
  (cascade), FK→tasks (set null).
- **workflow_events** — (`workflow_id`,`sequence`) pk, `event_type`, `ts`,
  `step_execution_id?`, `payload_json`; FK→workflows (cascade), FK→step
  executions (set null). Append-only.

Workflow context is kept as fields on `workflows` (`context_json` +
`context_revision`).

### What is / is not persisted

Persisted: only internal recovery/history data — canonical task input
(`input_text`, bounded), metadata, statuses, event payloads, the validated
workflow spec, execution state, and bounded context. **Never** persisted:
Gateway/relay **bearer tokens**, **encryption keys**, native agent credentials,
environment dumps, **temporary prompt-file paths**, or backend PIDs. Error
messages are sanitized and bounded. The context bundle is fail-closed to its
allow-listed keys and rejects credential/token/key/PID/session field names.

## Optimistic concurrency

Mutable records (`tasks`, `workflows`, `workflow_step_executions`) carry a
numeric `revision`; workflow context carries its own `context_revision`. Every
update requires the **expected** current revision and returns a structured
`revision_conflict` (`ControlStoreError`) on mismatch — never a silent
overwrite. This later prevents two recovery/runtime loops from advancing the
same workflow concurrently. (No distributed locking in this PR.)

## Transactions & idempotency

Store-level atomic composites (not runtime orchestration):

- **createTaskWithCreatedEvent** — create task + append `task.created` + advance
  `last_event_sequence`.
- **terminalizeTask** — set terminal state + `terminal_at` + append exactly one
  terminal event + set `terminal_event_recorded` (rejected if already set).
- **startWorkflowStep** — create the step execution + update workflow
  step/round + append `step.started`.
- **bindStepTask** — bind `task_id` + append `step.task_created` + increment
  `total_tasks`.
- **checkpointWorkflow** — update workflow state/counters + (optionally) context
  + append the workflow event.

**Event idempotency & integrity** (task and workflow events alike): sequences
are contiguous from the record's `last_event_sequence` (`-1` initially, so the
first event is `0`). Appending the **exact same** event at an existing sequence
is a **no-op**; a **different** event at an existing sequence is an
`event_conflict`; a sequence beyond `last+1` (or a hole below the high-water
mark) is an `event_gap` — gaps are reported, never silently normalized. Events
are append-only. Step-scoped workflow events require a valid `step_execution_id`
that belongs to the workflow; workflow-scoped events must not carry one.

## State-transition invariants (enforced by the store)

- **Tasks:** terminal states cannot regress to non-terminal; `terminal_at`
  cannot be cleared once set; the terminal event is recorded at most once;
  `last_event_sequence` never decreases; identity fields (`task_id`, `node_id`,
  `agent`) are immutable (absent from the patch type).
- **Workflows:** `completed`/`failed`/`cancelled` cannot regress; **`blocked`
  may later transition to `running`** (blocked is resumable, not terminal);
  `current_round` and the task/failure counters cannot decrease; the persisted
  `WorkflowSpec` is immutable after creation (no patch field mutates it); step
  executions cannot change identity fields; a completed step's output cannot be
  silently replaced; a step's task binding is immutable once set.

The full workflow transition engine is **not** implemented here — the store only
rejects clearly invalid persistence operations.

## Serialization & validation

All JSON read from SQLite is **untrusted persisted input**: it is size-bounded,
parsed defensively, and returned as a structured `corruption` error on
malformed/oversized content — never executed, and never trusted merely because
this process wrote it. Size limits apply to task input, metadata, event
payloads, workflow specs, context bundles, and step outputs/errors. Errors never
echo full payloads. All timestamps are **ISO-8601 UTC**.

## Retention primitives

Bounded, explicit cleanup (no background scheduler; none runs during migration
or startup):

- `pruneTerminalTasks(cutoffIso)` / `pruneTerminalWorkflows(cutoffIso)` — delete
  terminal records older than a cutoff (FK cascade is atomic). **Active records
  are never deleted.**
- `pruneTaskEvents(taskId, keepLast)` / `pruneWorkflowEvents(workflowId,
  keepLast)` — keep the newest `keepLast` events and update
  `earliest_retained_sequence` so later replay can signal truncation.

All cleanup runs in a transaction and reports a removed count.

## Migration policy

Migrations are ordered, transactional, and idempotent (`migrate()` is safe to
call repeatedly; reopening an existing valid DB never drops or recreates it). A
failing migration rolls back and records no version. A DB reporting a **newer**
schema version than supported **fails closed** (`unsupported_schema_version`);
there is no destructive downgrade. Corrupt schema metadata returns a structured
`corruption` error. **Schema v2** adds the task event-history completeness columns
(`history_incomplete`, `history_reason`, `history_boundary_sequence`) as an
additive `ALTER TABLE … ADD COLUMN` migration — v1 is never rewritten.

## Gateway wiring & restart recovery

As of the gateway-durable-tasks change, `vibe api serve` **persists Gateway
tasks** to this store and **recovers non-terminal tasks after a restart** (this
covers Gateway *tasks* only — the workflow runtime is still not implemented).

- **Default DB & startup:** the gateway opens `<vibe_dir>/control.sqlite`
  (override with `--db-path`, a filesystem path — never a token) and **migrates
  before accepting requests**. If the DB is inaccessible, corrupt, too new, or
  insecure/symlinked, startup **fails clearly** — it never silently falls back to
  an in-memory store. The store is closed cleanly on graceful shutdown. Tests
  inject an explicit temporary store and never touch the production DB.
- **Persisted task lifecycle:** on create, the task record + `task.created` event
  are persisted **atomically**; each accepted canonical event is durably appended
  **before** it is published to SSE subscribers; terminal status + the terminal
  event are persisted atomically and **exactly once**. Public contracts (task
  IDs, status vocabulary, REST/SSE shapes, wait/resume cursor, cancellation,
  Bearer auth) are unchanged; a task created before restart keeps the same
  `task_id`.
- **Startup recovery:** non-terminal tasks are reloaded and re-registered (so
  they are immediately addressable via GET/events/cancel), active-slot accounting
  is rebuilt (recovered running tasks count against the active limit; terminal
  ones do not), and each task is reconciled against **authoritative** status
  (`readRun` locally / `remoteRunStatus` remotely). Still-running tasks resume a
  live pump; terminal reconciliation is monotonic and emits/persists the terminal
  state exactly once. A node-offline / transient error is **never** fabricated as
  a terminal failure — recovery retries with bounded backoff and shutdown aborts
  the recovery pumps/timers cleanly. Terminal/historical tasks remain queryable
  from the store even though they are not held in memory.
- **Ambiguous remote-start crash window:** for a remote task the gateway persists
  the task record + `task.created` **before** attempting remote start (with
  `remote_run_id` unbound), using a **gateway-owned public `task_id` decoupled
  from the relay run id**, then durably **binds** `remote_run_id` after a
  successful start. So a crash mid-start leaves a **durable, still-queryable
  task** — the uncertainty is only the *remote linkage*, not the task identity.
  On restart, a task with an unbound `remote_run_id` is treated as an **ambiguous
  start**: it is **never auto-restarted** (that could duplicate a Claude Code /
  Codex run), no remote run id is guessed, no broad cancellation is issued, and it
  is transitioned **exactly once** to a sanitized `recovery_unknown_start`
  failure. Recovery is idempotent across repeated restarts.
- **Missing events during downtime — structured completeness metadata:** there is
  **no Node-side event journal/replay yet**, so when the gateway resumes a running
  **remote** task after a restart, events emitted during downtime may be missing.
  This is recorded as **machine-readable, persisted** metadata on the task
  (schema v2): `history.complete=false`, `incomplete_reason:
  "gateway_restart_without_node_replay"`, `earliest_retained_sequence`, and
  `boundary_sequence` (the greatest sequence durably consumed before the missing
  interval). It is exposed on the REST `GET /v1/tasks/:id` response (an optional
  `history` object — older clients ignore it) and therefore through the MCP task
  tools; the SSE stream **also** keeps a human-readable `: warning …` comment, but
  that is no longer the only signal. This never consumes a canonical `TaskEvent`
  sequence, never changes `next_event_id` semantics, and the gateway **never
  invents or renumbers** events — the resume cursor stays the greatest event
  actually persisted/consumed. It is **not** set for normally-completed
  uninterrupted tasks, historical terminal tasks, or local tasks (whose full
  stream is deterministically replayable from the run event log). A **future Node
  journal** that verifies a gap-free replay past the boundary can clear the marker
  (`clearTaskHistoryIncomplete`, reserved and unused today).

## Durable recovery — requirement → test coverage

| Guarantee | Directly asserted by |
|-----------|----------------------|
| Task identity survives store close/reopen (same `task_id`) | `agent-gateway-durable` #1, #2 |
| Terminal task + events survive restart; gap/dup-free replay | `agent-gateway-durable` #2 |
| Persistence-before-publish (unsaved event not published) | `agent-gateway-durable` "persistence failure …" |
| Ambiguous start not restarted; identity survives; terminalized once; idempotent | `agent-gateway-durable` "ambiguous remote start …" |
| Known `remote_run_id` running recovery → reconciles to completed | `agent-gateway-remote-recovery` |
| Known `remote_run_id` terminal reconciliation, exactly-once terminal | `agent-gateway-remote-recovery` |
| Node-offline / transient recovery stays non-terminal, bounded retry | recovery retry logic (`reconcileRecovered`) + local `recovery_run_missing` path (`agent-gateway-durable`) |
| Recovered task cancellable (idempotent) | `agent-gateway-durable` #5 (local) + `agent-gateway-remote` cancel |
| Recovered active-slot accounting (active counts; terminal frees) | `agent-gateway-durable` #4 + `agent-gateway-remote-recovery` |
| Terminal event exactly once across recovery | `agent-gateway-durable` #2 + `agent-gateway-remote-recovery` |
| Structured history-incomplete metadata survives reopen + exposed | `agent-gateway-durable` "history-incomplete …" + `control-store` mark/clear + `agent-gateway-remote-recovery` |
| `Last-Event-ID` replay then live remote events, no boundary gap/dup | `agent-gateway-remote-recovery` |
| `next_event_id` = greatest consumed persisted event | `agent-gateway-remote-recovery` |
| Shutdown aborts retry timers/pumps (clean exit) | `agent-gateway-durable` (suite exits cleanly; `close()` clears `recoveryTimers` + aborts pumps) |
| DB holds no configured token; no production DB touched | `agent-gateway-durable` #6; suite-wide temp DBs |

## Current limitations

- **No Node-side event replay** across Gateway downtime — events emitted while
  the gateway was unavailable can be permanently missing (surfaced as truncated).
- **No workflow runtime** — workflow tables exist but nothing executes workflows.
- The ambiguous remote-start crash window above (no pre-start correlation id
  without a protocol redesign).
