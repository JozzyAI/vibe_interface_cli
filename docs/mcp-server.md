# Vibe Agent Gateway — MCP server

`vibe mcp serve` exposes the [Agent Gateway](agent-task-api.md) as **MCP tools**
for local MCP hosts (Claude Desktop, Cursor, …). It is a **pure client** of the
gateway's HTTP API.

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
| `vibe_get_task` | `GET /v1/tasks/:id` | authoritative canonical Task |
| `vibe_get_task_events` | `GET /v1/tasks/:id/events` (SSE) | **bounded** request/response — see below |
| `vibe_cancel_task` | `POST /v1/tasks/:id/cancel` | **destructive** (annotated); idempotent (the gateway owns idempotency) |

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

- **PR #57** — richer wait/resume: a high-level `vibe_run_task` (start + bounded
  wait → terminal result, or a `task_id`/`next_event_id` to resume) and resumed
  polling helpers.
- **PR #58** — client-specific **Claude Desktop / Cursor** configuration guides
  and a live Claude/Codex integration smoke.
