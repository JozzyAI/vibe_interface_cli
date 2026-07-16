# Vibe Agent Gateway — MCP server

`vibe mcp serve` exposes the [Agent Gateway](agent-task-api.md) as **MCP tools**
for local MCP hosts (Claude Desktop, Cursor, …). It is a **pure client** of the
gateway's HTTP API.

> **Setting up a host?** For step-by-step **Claude Code / Cursor** configuration,
> the seven-tool reference, and the recommended run/wait/resume workflow, see
> [`mcp-client-integrations.md`](mcp-client-integrations.md). This page is the
> protocol/reference for the server itself.

```
MCP Host  ──stdio(JSON-RPC)──▶  Vibe MCP server  ──HTTP──▶  Vibe Agent Gateway  ──▶  relay / node / Claude / Codex
```

The MCP server **does not** connect to the relay, read the relay token, duplicate
task-execution logic, bypass Gateway validation, or expose arbitrary shell
execution. It never changes Gateway core behavior.

## Prerequisites

A running Agent Gateway (see [agent-task-api.md](agent-task-api.md)):

```bash
vibe api serve --host 127.0.0.1 --port 8787 --token-file ~/.cache/vibe/api-token \
  --relay ws://<relay-host>:7433 --relay-token-file ~/.config/vibe/relay-token
```

## Start the MCP server

```bash
vibe mcp serve --gateway-url http://127.0.0.1:8787 --token-file <vibe_dir>/api-token
```

- `--gateway-url` — Agent Gateway base URL. **Default `http://127.0.0.1:8787`.**
  Non-loopback URLs are **refused** unless `--allow-remote-gateway` is passed
  (the Bearer token would traverse the network).
- `--token-file` — the gateway's `0600` API token file. **Default
  `<vibe_dir>/api-token`** (the path `vibe api serve` creates by default). The
  token is read from this file and used only in the `Authorization` header — it
  is never accepted as a CLI argument, printed, logged, or placed in tool
  schemas/results/errors.
- **stdout carries only MCP protocol messages**; all diagnostics go to stderr.

## Protocol

MCP JSON-RPC 2.0 over newline-delimited stdio, preferred protocol version
**`2025-11-25`** (the official SDK's latest). Negotiation echoes any explicitly
requested **supported** version (`2025-11-25` / `2025-06-18` / `2025-03-26` /
`2024-11-05`) and otherwise negotiates down to `2025-11-25` — it never claims an
unimplemented/future version. Methods: `initialize`, `notifications/initialized`,
`tools/list`, `tools/call`, `ping`. Requests are validated (`jsonrpc` must be
`"2.0"`; ids must be string/number; unknown methods → method-not-found; unknown
notifications ignored; handler exceptions still return a JSON-RPC error).

**No runtime MCP dependency** — the server is hand-written to keep production
dependencies minimal. The official `@modelcontextprotocol/sdk` is used **only as
a dev/test dependency** for an official-client conformance test (it drives the
real spawned server end-to-end).

## Tools

| Tool | Gateway call | Notes |
|------|--------------|-------|
| `vibe_list_agents` | `GET /v1/agents` | local mock + online nodes' agents |
| `vibe_start_task` | `POST /v1/tasks` | `agent`, optional `node_id`, `input_text`, optional `workspace_key` (opaque; not a path), `permission_mode`, `metadata`. Deferred gateway fields (`path`/`repo_url`/`branch`/`timeout_seconds`) are **not exposed**. Returns the Task; does not wait. |
| `vibe_run_task` | `POST /v1/tasks` + bounded resume loop | **convenience workflow**: start **and** wait (bounded) in one call — see below. Same inputs as `vibe_start_task` plus `wait_seconds`. **May return before completion.** |
| `vibe_wait_task` | `GET /v1/tasks/:id/events` (SSE) resume loop | **resumable bounded wait**: continue an existing task from a cursor until terminal or timeout — see below. Inputs `task_id`, optional `after_event_id`, `wait_seconds`. |
| `vibe_get_task` | `GET /v1/tasks/:id` | authoritative canonical Task |
| `vibe_get_task_events` | `GET /v1/tasks/:id/events` (SSE) | **bounded** single request/response — see below |
| `vibe_cancel_task` | `POST /v1/tasks/:id/cancel` | **destructive** (annotated); idempotent (the gateway owns idempotency) |
| `vibe_list_workflows` | `GET /v1/workflows` | durable workflow summaries; optional `status`, bounded `limit`/`offset` |
| `vibe_create_workflow` | `POST /v1/workflows` | validate + create a **`ready`** workflow; **does NOT start it** (inputs `spec`, `input_values`) |
| `vibe_start_workflow` | `POST /v1/workflows/:id/start` | explicit start (idempotent); returns the snapshot without waiting |
| `vibe_get_workflow` | `GET /v1/workflows/:id` | durable WorkflowSnapshot |
| `vibe_get_workflow_events` | `GET /v1/workflows/:id/events` (SSE) | **bounded** poll; workflow event cursor (distinct from task ids) |
| `vibe_wait_workflow` | `GET /v1/workflows/:id/events` resume loop | **resumable bounded wait**: return on terminal, blocked, or timeout (`terminal`/`blocked`/`ended_by`) |
| `vibe_cancel_workflow` | `POST /v1/workflows/:id/cancel` | **destructive** (annotated); idempotent + durable |

### Workflow tools (durable Workflow Runtime)

Seven workflow tools sit alongside the seven task tools (fourteen total). They are
pure HTTP clients of the `/v1/workflows` routes — see
[`docs/workflow-api.md`](workflow-api.md) for full semantics. Key points:

- **create ≠ start**: `vibe_create_workflow` only validates + persists a `ready`
  workflow (no Agent Task runs); you must call `vibe_start_workflow` explicitly.
- **`vibe_wait_workflow`** returns when the workflow is terminal
  (`completed`/`failed`/`cancelled`), **blocked** (non-terminal, `terminal:false
  blocked:true`), or the wait budget expires (`ended_by:"timeout"`, still running —
  resume with `next_event_id`). A timeout or MCP disconnect **never** cancels.
- **`blocked` is non-terminal** and not auto-resumed; cancellation is explicit
  (`vibe_cancel_workflow` only).
- Recommended flow: `vibe_create_workflow` → inspect → `vibe_start_workflow` →
  `vibe_wait_workflow` → `vibe_get_workflow`/`vibe_get_workflow_events` →
  `vibe_cancel_workflow` (only explicitly).

### Bounded event polling (`vibe_get_task_events`)

MCP tool calls are request/response, so this tool is **bounded**, not an endless
stream. Inputs: `task_id`, optional `after_event_id` (resume cursor), optional
`wait_seconds` (must be in **`[0.5, 30]`** — out-of-range values are **rejected**,
not clamped). It connects to the gateway SSE endpoint, sends `Last-Event-ID:
after_event_id` (so events are strictly **greater than** the cursor — **no
duplicate at the boundary**), collects ordered events, and returns as soon as the
task is terminal **or** the bounded wait elapses. It returns:

- `task` — the current canonical Task
- `events` — ordered events with id **strictly greater than** the cursor
- `next_event_id` — a **resume cursor** = the **greatest event id consumed** (NOT
  the id of the next event); `-1` if nothing has been consumed. Pass it back as
  `after_event_id`. A poll that consumes nothing **preserves** the caller's cursor.
- `terminal` — decided by the **authoritative** Task status (a `completed` /
  `failed` / `cancelled` GET makes this `true` even if this SSE window did not
  receive the terminal event; no terminal event is fabricated into `events`)
- `truncated` — whether the gateway's replay predated its retained buffer (the
  returned cursor stays safe/usable)
- `ended_by` — `"terminal"` (authoritative status is terminal) or `"timeout"`

**Closing or timing out the tool never cancels the task** — only
`vibe_cancel_task` cancels. Poll again with `next_event_id` to follow a long task.

### Wait/resume workflows (`vibe_run_task`, `vibe_wait_task`)

These are convenience wrappers so an agent host can start and follow a task
without hand-rolling the poll loop. They add **no** Gateway behavior: each is a
sequence of the same bounded calls above.

- **`vibe_run_task`** — creates the task (`POST /v1/tasks`, only Gateway v1
  fields), then resumes its events from the last consumed cursor until the task is
  **terminal** or the **overall** `wait_seconds` budget expires. **It may return
  before completion.**
- **`vibe_wait_task`** — the continuation path: resume an existing `task_id` from
  `after_event_id` (a `next_event_id` from a prior call) under the same bounded
  loop. Use it whenever `vibe_run_task` returns `terminal: false`.

**Overall wait semantics.** `wait_seconds` is a **single overall deadline**
(default **30 s**, min **0.5 s**, max **120 s**; out-of-range is **rejected**, not
clamped) shared across all internal polls — a fresh full window is **never**
re-granted per request, so the total wait can never exceed the budget. Each
internal SSE poll stays capped at 30 s; a longer budget simply loops more bounded
polls. There is no unbounded loop and every HTTP request has a bounded timeout.

Both return the same shape as `vibe_get_task_events` (`task`, ordered `events`,
`next_event_id`, `terminal`, `truncated`, `ended_by`) plus, when the agent emitted
output, a bounded `output_preview` (concatenated `agent.output.delta` text only,
capped, with `output_preview_truncated` when the cap is hit — the canonical
`events` are always kept in full and nothing is invented).

**A timeout does NOT mean the task was cancelled.** When `ended_by` is
`"timeout"` / `terminal` is `false`, the task **is still running**; the result
carries the `task_id` and a `resume` hint. Continue with `vibe_wait_task`
(or `vibe_get_task_events`). Only `vibe_cancel_task` cancels — never a timeout or
an MCP client disconnect. If task **creation** succeeds but the subsequent wait
fails, the result still carries the created `task_id` and states the task may
still be running; it is **not** auto-cancelled.

**Terminal is authoritative.** As with `vibe_get_task_events`, a `completed` /
`failed` / `cancelled` GET makes `terminal: true` even if the terminal SSE event
was missed; a missing terminal event is never fabricated, and a terminal task is
never regressed to running.

**Example multi-call flow** (a task that outlives the first wait):

```jsonc
// 1) start + wait up to 30s
vibe_run_task { "agent": "claude-code", "node_id": "node_x", "input_text": "…", "wait_seconds": 30 }
//    -> { "terminal": false, "ended_by": "timeout", "task_id": "run_42",
//         "next_event_id": 7, "resume": { "tool": "vibe_wait_task", … } }

// 2) resume from the cursor, no gap / no duplicate
vibe_wait_task { "task_id": "run_42", "after_event_id": 7, "wait_seconds": 60 }
//    -> { "terminal": true, "ended_by": "terminal", "task": { "status": "completed", … } }
```

## Errors

Canonical Gateway `ApiError` responses are mapped to structured MCP tool errors
(`isError: true`, with `code`/`message`/`retryable`/`http_status` in the result) —
never a leaked token or `Authorization` header. HTTP timeouts are bounded and
surface as `gateway_timeout`.

## Security boundaries

- Loopback gateway by default; non-loopback requires an explicit opt-in.
- Token only in a `0600` file (symlink / group-or-world-readable / empty /
  malformed files are rejected), never on the wire to stdout/stderr or in tool
  output.
- No relay/relay-token access, no Gateway-validation bypass, no shell tools;
  `workspace_key` stays an opaque safe key.
- MCP client disconnect/timeout never cancels a running task.

## Durability

The Gateway's task→run mappings and SSE replay history are **process-local and
in-memory** (see [agent-task-api.md](agent-task-api.md#durability-process-local-in-memory-only)).
A gateway restart drops them; the MCP server holds no additional state.

## Roadmap

- **Client integration guides** (Claude Code, Cursor) + tool reference +
  recommended workflow: [`mcp-client-integrations.md`](mcp-client-integrations.md).
