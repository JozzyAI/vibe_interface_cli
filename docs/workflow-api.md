# Workflow REST API

The durable [Workflow Runtime](./workflow-runtime.md) is exposed through the
existing `vibe api serve` process as versioned REST routes under `/v1/workflows`,
and through the existing `vibe mcp serve` adapter as eleven MCP tools. This layer
adds **lifecycle entry points only** (list, create, start, get, events, cancel,
and the human-pause operations pending-request / answer / decision / resume) —
it does **not** change Workflow Runtime semantics.

Not in this layer: natural-language workflow generation, automatic start after
generation, a workflow map UI, blocked-workflow resume, output repair, automatic
retries, A2A, arbitrary shell/HTTP steps, or distributed scheduling.

## Architecture

```
MCP host → vibe mcp serve → Workflow REST API → Workflow Runtime
        → Agent Gateway task API/client → relay → Node → Claude Code / Codex
```

- The REST workflow routes and the task API live in the **same** `vibe api serve`
  process — there is no second HTTP server and no second token type. Every request
  uses the same Gateway **Bearer** token (loopback-only by default).
- The Workflow Runtime uses the **same durable ControlStore** as Gateway tasks
  (schema v5). There is no in-memory fallback for workflow routes.
- MCP remains a **pure HTTP client** of the Gateway — it never instantiates the
  runtime and never connects to the relay or a Node directly.
- The runtime drives Agent Tasks through the colocated Gateway task API over
  loopback using the existing API token (never printed; no second listener).

One `WorkflowRuntime` instance is wired per API process/store. On startup the
server calls `recoverWorkflows()` (which schedules bounded per-workflow pumps and
returns immediately — it never blocks on an unavailable Node). Shutdown order:
stop accepting new requests → abort workflow waits/pumps/backoff → shut down the
runtime → shut down Gateway task pumps → close the ControlStore.

## Create vs. explicit start

`POST /v1/workflows` **creates** a durable workflow in status `ready` and starts
**no** Agent Task. Execution begins only on an explicit `POST
/v1/workflows/:id/start`. This separation is deliberate so a future
natural-language compiler can support **generate → validate → preview → approve →
start**.

## Route reference

All routes require `Authorization: Bearer <token>`.

| Method & path | Purpose |
| --- | --- |
| `GET /v1/workflows` | List durable workflow summaries (`status`, bounded `limit`≤200, `offset`) |
| `POST /v1/workflows` | Validate + create a `ready` workflow (no execution). Body `{ spec, input_values? }` → **201** durable snapshot |
| `GET /v1/workflows/:id` | Durable WorkflowSnapshot (spec, inputs, context, step executions incl. per-step `revision_before`/`revision_after`, current task, counters, timestamps, cancel intent, `workspace_leases` + `release_pending`, terminal/blocked reason) |
| `POST /v1/workflows/:id/start` | `ready`→`running`; running coalesces; terminal returns unchanged; blocked → **409** conflict. A **workspace-bound** workflow with no lease authority is refused (**422** `workspace_lease_unsupported`); a workspace already held by another workflow → **409** `workspace_lease_conflict`. Returns the snapshot (does not wait) |
| `GET /v1/workflows/:id/events` | SSE workflow events (see cursor semantics) |
| `POST /v1/workflows/:id/cancel` | Idempotent durable cancellation → current snapshot |
| `GET /v1/workflows/:id/pending-request` | The human pause request awaiting a response (`{ workflow_id, status, request }`; `request` is null when none) |
| `POST /v1/workflows/:id/answer` | Answer an **input** pause `{ request_id, value }` — idempotent; a different value → **409**; unknown request → **404** |
| `POST /v1/workflows/:id/decision` | Approve/reject an **approval** pause `{ request_id, approved }` — idempotent; a conflicting decision → **409**; reject → workflow `failed` |
| `POST /v1/workflows/:id/resume` | Continue a paused workflow once answered/approved → current snapshot (idempotent) |

**Summaries** and **snapshots** never include Gateway/relay tokens, encryption
keys, native-agent credentials, backend PIDs, native-agent histories, raw logs, DB
paths, SQL, stack traces, or filesystem paths. Sizes are bounded by the store. Step
outputs are the authoritative **AgentTaskResult**-backed final outputs (routed on the
first-class result, never reconstructed from event history).

### Workspace leases in the snapshot

A workspace-bound workflow (a step whose agent role has a `node_id` and a
`workspace_key_template`) exclusively leases its Node workspaces for its whole run.
The snapshot exposes a bounded, path-free `workspace_leases` array — each with
`workspace_lease_id`, opaque `node_id`/`workspace_key`, `status`
(`acquiring`/`active`/`release_requested`/`released`), and compact `base_revision` /
`current_revision` (revision kind + `state_hash` + git head/dirty — **never** a
changed-files path list) — plus a top-level `release_pending` flag (true while a lease
still awaits release after the workflow terminalized). An out-of-band workspace change
detected before a step sets the workflow `blocked` with reason
`workspace_revision_conflict` (the lease is retained). See
[workflow workspace leases](workflow-workspace-leases.md).

### Errors

Uses the Gateway structured error envelope with workflow-specific codes:
`workflow_not_found` (404), `invalid_workflow_spec` (400; sanitized issue
code/severity/message/path — never raw prompt/spec values), `invalid_workflow_inputs`
(400), `workflow_state_conflict` (409), `workspace_lease_conflict` (409),
`workspace_lease_unsupported` (422; a workspace-bound workflow started with no lease
authority), `workspace_lease_unavailable` (503), `workflow_storage_failure` (500),
`workflow_runtime_unavailable` (503). A transient task/Gateway/lease unavailability is
**not** a terminal workflow failure.

## Workflow event cursor semantics

`GET /v1/workflows/:id/events` is SSE over the **durable** workflow event log:

- Workflow event sequences start at **0**; the initial cursor is **-1**.
- `Last-Event-ID` replays events strictly greater than the cursor; the transition
  from persisted replay to live events has **no gap and no duplicate** (each poll
  reads `sequence > cursor` from the durable log — the single source of truth).
- The next cursor is the greatest consumed workflow event sequence.
- The stream ends after the end-of-progress event
  (`workflow.completed`/`failed`/`cancelled`/`blocked`) once the cursor has caught
  up; the terminal event appears exactly once.
- A client **disconnect never cancels** the workflow. A slow/dead subscriber is
  detected on write and only that stream stops — Workflow Runtime correctness never
  depends on a subscriber.
- Retention/truncation is surfaced as an SSE comment when workflow event pruning
  has occurred.
- Workflow event sequences are **distinct** from task event ids and Node source
  sequences — never interchange them.

## `blocked` is non-terminal

`blocked` means the runtime paused (e.g. `task_history_incomplete`) and made no
guess. It is **not** terminal and is **not** auto-resumed; `POST /start` on a
blocked workflow returns a **409** conflict. User-driven resume is deferred to a
later extension.

## Wait timeout never cancels

The MCP `vibe_wait_workflow` and the client `waitForWorkflow` return when the
workflow becomes terminal, becomes blocked, or the overall wait budget expires. A
**timeout or disconnect never cancels** the workflow or its current Agent Task —
only an explicit cancel does. Terminal/blocked truth comes from the authoritative
`GET` workflow status; a missed terminal SSE event is never fabricated.

## Durable recovery

Workflow identities and state survive an API-process restart: `recoverWorkflows()`
resumes running workflows, re-submitting an unbound step's task with the same
`step_execution_id` (Gateway idempotency_key) so **no duplicate Agent Task** starts,
re-binding the same `task_id`, and continuing from the exact durable boundary.
Completed workflows remain queryable.

## Limitations (v1)

- **Single runtime process** per ControlStore database (documented; no distributed
  lock/lease, no active/active scheduling). Duplicate start/recover calls coalesce
  onto one in-process pump per workflow.
- No blocked-workflow **resume** yet.
- No natural-language **compiler** yet.
- No **Workflow Map UI** yet.
- No **A2A** yet.

## MCP tools

Eleven workflow tools are added alongside the seven task tools (eighteen total; the
task tools are unchanged): `vibe_list_workflows`, `vibe_create_workflow`,
`vibe_start_workflow`, `vibe_get_workflow`, `vibe_get_workflow_events`,
`vibe_wait_workflow`, `vibe_cancel_workflow`. See [`docs/mcp-server.md`](./mcp-server.md).

Recommended MCP workflow:

1. `vibe_create_workflow` — validate + create (does **not** start).
2. inspect the returned spec/state.
3. `vibe_start_workflow` — explicit start.
4. `vibe_wait_workflow` — bounded wait; resume with `next_event_id` if it times out.
5. `vibe_get_workflow` / `vibe_get_workflow_events` as needed.
6. `vibe_cancel_workflow` — only explicitly.
