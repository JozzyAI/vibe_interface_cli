# Vibe MCP — client integration guide (Claude Code, Cursor)

This guide connects a **local MCP host** (Claude Code, Cursor, …) to your Vibe
agents through the Vibe MCP server. For the protocol/reference details of the
server itself, see [`mcp-server.md`](mcp-server.md); for the Gateway it talks to,
see [`agent-task-api.md`](agent-task-api.md).

> All examples use **placeholders** — replace `<path-to-vibe>`, `<gateway-url>`,
> `<api-token-file>`, `<relay-host>`, `<node-id>`, and `<vibe-dir>` with your own
> values. Never paste a real token, node id, username, private path, or LAN
> address into a config file or a prompt.

## Architecture

```
MCP host (Claude Code / Cursor)
   │  stdio, JSON-RPC 2.0
   ▼
vibe mcp serve                     ← the Vibe MCP server (this integration)
   │  HTTP + SSE, Authorization: Bearer <token from a 0600 file>
   ▼
Vibe Agent Gateway (vibe api serve)
   │  relay protocol (Gateway holds the relay connection + relay token)
   ▼
relay
   │
   ▼
remote Vibe Node (vibe node daemon)
   │
   ▼
Claude Code / Codex / mock  (the actual agent harness)
```

The MCP server is **only a Gateway HTTP client**. Concretely, it:

- **does not** connect directly to the relay;
- **never** reads or holds the relay token (only the Gateway does);
- **does not** provide arbitrary shell execution or file access;
- **does not** duplicate or bypass task validation — all task validation,
  workspace containment, encryption, and agent execution stay in the **Gateway**
  and **node** layers;
- never changes Gateway core behavior. Every MCP tool is a thin wrapper over a
  Gateway REST/SSE call.

This means the trust boundary you care about is the Gateway and the node — the
MCP server adds a convenience surface, not new authority.

## Prerequisites

Before configuring a host, confirm the chain below is healthy. (Commands use
placeholders; a Gateway started with `--relay` enables remote agents.)

1. **A Vibe Node is online.** A `vibe node daemon` is registered with the relay
   and advertises the agents you want (e.g. `claude-code`, `codex`).
2. **The Agent Gateway is running.**

   ```bash
   vibe api serve --host 127.0.0.1 --port 8787 \
     --token-file <api-token-file> \
     --relay ws://<relay-host>:7433 --relay-token-file <relay-token-file>
   ```

3. **The Gateway token file exists with secure permissions** — a `0600` regular
   file (not a symlink, not group/world-readable). `vibe api serve` creates it on
   first run and reuses it after.
4. **`vibe mcp serve` is available on PATH** (or reference `node <path-to-vibe>
   mcp serve …` by absolute path — see below).
5. **Remote agents appear in the Gateway agent list:**

   ```bash
   curl -s -H "Authorization: Bearer $(cat <api-token-file>)" \
     <gateway-url>/v1/agents
   ```

   You should see the local `mock` plus each online node's advertised agents,
   each tagged with its `node_id`.

The MCP server is started for you by the host process; you do not run it by hand
in normal use. To sanity-check it manually:

```bash
vibe mcp serve --gateway-url <gateway-url> --token-file <api-token-file>
# then send an initialize line on stdin; diagnostics print to stderr, protocol to stdout
```

## Claude Code setup

Verified against **Claude Code CLI 2.1.x**. Claude Code manages MCP servers with
`claude mcp …`.

### Add the server

```bash
claude mcp add vibe -- \
  node <path-to-vibe> mcp serve \
  --gateway-url <gateway-url> \
  --token-file <api-token-file>
```

- Everything after `--` is the stdio launch command and its args.
- Use `node <path-to-vibe>` (absolute path to the built CLI entry, e.g.
  `.../dist/src/index.js`) if `vibe` is not on the host's PATH; otherwise you can
  use `vibe` directly: `claude mcp add vibe -- vibe mcp serve --gateway-url … --token-file …`.

**Scope.** `claude mcp add` accepts `-s/--scope <local|user|project>`:

- `local` (default) — this project, your user only.
- `project` — shared via a checked-in `.mcp.json` (do **not** commit real token
  paths that are secret; the token stays in the referenced file, never inline).
- `user` — all your projects.

### List / verify / remove

```bash
claude mcp list            # shows each server + a live "✔ Connected" / "✘ Failed" probe
claude mcp get vibe        # details + connection status for one server
claude mcp remove vibe     # remove it (add -s <scope> if you added it in a non-default scope)
```

A healthy server shows **`✔ Connected`** in `claude mcp list`. If it shows
`✘ Failed to connect`, see [Troubleshooting](#troubleshooting).

### Example prompts

Once connected, ask the host in natural language (the tool names are
`mcp__vibe__<tool>`):

- **List agents:** "List the available Vibe agents."
- **Start a remote Claude Code task:** "Start a Vibe task on node `<node-id>`
  with the `claude-code` agent to summarize the README, and wait up to 60s."
- **Start a remote Codex task:** "Run a `codex` task on node `<node-id>` to add a
  unit test, waiting up to 90s."
- **Continue a timed-out task:** "That task timed out — continue waiting on it
  using its task_id and next_event_id for another 60s."
- **Cancel explicitly:** "Cancel Vibe task `<task-id>`."

The host will call `vibe_run_task` / `vibe_wait_task` / `vibe_cancel_task` for
you. A timed-out `vibe_run_task` returns a `resume` hint the host can follow with
`vibe_wait_task`.

## Cursor setup

Cursor uses a JSON MCP config with the same `mcpServers` shape as Claude
Desktop. The stdio launch command is **identical** to the one above.

> **Verification note.** The configuration schema and launch command below are
> validated (the Vibe MCP server is a standard stdio JSON-RPC server and starts
> from exactly this command — proven in this repo's tests and the Claude Code
> acceptance run). **Live Cursor UI validation was not performed** in this
> environment (no headless Cursor client was available). Treat the exact
> settings-panel labels and file location as version-dependent; confirm them in
> your Cursor version's MCP docs.

### Configuration

Cursor reads MCP servers from an `mcp.json`:

- **Project scope:** `.cursor/mcp.json` in the project root.
- **Global scope:** `mcp.json` in Cursor's user config directory (commonly
  `~/.cursor/mcp.json`; the exact location can vary by platform/version).

```json
{
  "mcpServers": {
    "vibe": {
      "command": "node",
      "args": [
        "<path-to-vibe>",
        "mcp",
        "serve",
        "--gateway-url",
        "<gateway-url>",
        "--token-file",
        "<api-token-file>"
      ]
    }
  }
}
```

- **command / args** — the same stdio invocation Claude Code uses. If `vibe` is
  on PATH you may set `"command": "vibe"` and drop the leading `<path-to-vibe>`
  from `args`.
- **env / flags** — none are required. Do **not** put the token in `env` or in
  `args`; pass only `--token-file`. If your Gateway is non-loopback, add
  `"--allow-remote-gateway"` to `args` (discouraged — see Security).
- **Restart / reload** — after editing `mcp.json`, reload the MCP servers
  (restart Cursor or use its "reload MCP" action) for changes to take effect.

### Verify

After reload, open Cursor's MCP/tools view and confirm the **seven** Vibe tools
appear (see the [Tool reference](#tool-reference)). Then try "List the available
Vibe agents" to exercise `vibe_list_agents` end-to-end.

## Tool reference

The server exposes **seven** tools. Full return shapes and the resume-cursor /
bounded-wait model are documented in [`mcp-server.md`](mcp-server.md).

| Tool | Purpose | Key inputs | Returns | Destructive? | Timeout leaves task running? |
|------|---------|-----------|---------|:---:|:---:|
| `vibe_list_agents` | List runnable agents (local mock + each online node's agents) | — | `{ agents: [{ id, node_id?, available, streaming? }] }` | no | n/a |
| `vibe_start_task` | Start a task and return immediately (no wait) | `agent`, `input_text`, optional `node_id`, `workspace_key`, `permission_mode`, `metadata` | the canonical Task | no | n/a |
| `vibe_get_task` | Get the authoritative Task by id | `task_id` | the canonical Task | no | n/a |
| `vibe_get_task_events` | One **bounded** poll of a task's events | `task_id`, optional `after_event_id`, `wait_seconds` ∈ [0.5, 30] | `task`, ordered `events`, `next_event_id`, `terminal`, `truncated`, `ended_by` | no | **yes** |
| `vibe_run_task` | **Start + bounded-wait** in one call | start fields + `wait_seconds` ∈ [0.5, 120] | Task + `events` + `next_event_id` + `terminal`/`ended_by` (+ `task_id`/`resume` on timeout, optional `output_preview`) | no | **yes** |
| `vibe_wait_task` | **Resumable bounded-wait** on an existing task | `task_id`, optional `after_event_id`, `wait_seconds` ∈ [0.5, 120] | same shape as `vibe_run_task` | no | **yes** |
| `vibe_cancel_task` | **Cancel** a running task (idempotent) | `task_id` | the canonical Task | **yes** | n/a |

**Cursor/wait semantics (the three waiting tools).**

- `after_event_id` is a **resume cursor** = the **greatest event id already
  consumed** (equal to a prior call's `next_event_id`), *not* the id of the next
  event. Events returned are strictly **greater than** it, so there is no
  duplicate at the boundary and no gap.
- `next_event_id` in the result is the new cursor to pass into the next call. A
  poll that receives no new event **preserves** your cursor.
- `terminal` is decided by the **authoritative** Task status (`completed` /
  `failed` / `cancelled`), even if a terminal SSE event was not seen in that
  window; a missing terminal event is never fabricated and a terminal task never
  regresses to running. `ended_by` is `"terminal"` or `"timeout"`.
- `vibe_run_task` / `vibe_wait_task` share **one overall `wait_seconds` budget**
  across internal polls (default 30s, min 0.5s, **max 120s**; out-of-range is
  rejected, not clamped). Each internal SSE poll stays capped at 30s and at the
  remaining budget — the total never exceeds the budget.
- **Only `vibe_cancel_task` cancels.** A wait that ends by `"timeout"` (or an MCP
  host disconnect) leaves the task **running**; the result carries the `task_id`
  and a `resume` hint.

## Recommended workflow

1. **`vibe_list_agents`** — discover which agents/nodes are available.
2. **`vibe_run_task`** — start the task and wait (bounded) in one call.
3. **If `terminal` is `false`** (`ended_by: "timeout"`) — the task is still
   running; call **`vibe_wait_task`** with the returned `task_id` and
   `after_event_id = next_event_id`. Repeat until `terminal` is `true`.
4. **`vibe_cancel_task`** — only when you explicitly want to stop the task. A
   timeout is *not* a cancellation.

`next_event_id` is a **resume cursor equal to the greatest consumed event id**;
passing it back as `after_event_id` guarantees no skipped or duplicated events
across the sequence.

## Security

- The Gateway **API token is read from a `0600` file** and used only in the
  `Authorization` header. Symlink / group-or-world-readable / empty / malformed
  token files are rejected.
- **Never put the token in MCP config `args` or `env`** — pass only
  `--token-file`. The token is never printed, logged, echoed, or placed in tool
  schemas/results/errors.
- A **non-loopback** `--gateway-url` is **refused** unless you explicitly pass
  `--allow-remote-gateway` (the Bearer token would traverse the network).
  Default and recommended: a loopback Gateway.
- The **relay token is never used by the MCP server** — only the Gateway holds
  the relay connection and its token.
- **No task cancellation on host disconnect or wait timeout** — only
  `vibe_cancel_task` cancels.
- `workspace_key` is an **opaque identifier** matching
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, **not a filesystem path**. Path-shaped
  workspace fields are not exposed by these tools; the node enforces workspace
  containment.
- The Gateway's task↔run mappings and SSE replay history are **process-local and
  in-memory**; a Gateway restart drops them (see [Durability](#troubleshooting)).

## Troubleshooting

| Symptom | Likely cause & fix |
|--------|--------------------|
| **MCP server "not connected" / `✘ Failed to connect`** | Host couldn't spawn the command. Check the `command`/`args` path (`node <path-to-vibe>` must resolve), that `vibe mcp serve` runs by hand, and that the token file is readable. Diagnostics go to the host's MCP **stderr** log. |
| **Gateway not running** | Tool calls return a `gateway_unreachable` / `gateway_timeout` error. Start `vibe api serve` and confirm `<gateway-url>/v1/agents` responds. |
| **Token file missing / insecure** | The server refuses to start a request with `token_file_missing`, `token_file_symlink`, `token_file_insecure_perms`, or `token_file_invalid`. Recreate it via `vibe api serve` and `chmod 600` it. |
| **Node offline** | Starting a task on an offline node maps to a distinguishable error (e.g. `node_offline` / `service_unavailable`). Bring the node online (`vibe node daemon`) and re-check `/v1/agents`. |
| **Agent unavailable** | The requested `agent` isn't advertised by the target node → `agent_unavailable` (non-retryable unless the Gateway says otherwise). Pick an agent that appears in `vibe_list_agents`. |
| **Service unavailable** | Transient/at-capacity → `service_unavailable` (**retryable**). Retry with backoff; the task may still be created. |
| **Task "continues after MCP timeout"** | Expected. `ended_by: "timeout"` / `terminal: false` means the task is **still running** — resume with `vibe_wait_task` using the returned cursor. Only `vibe_cancel_task` stops it. |
| **Replay truncation** (`truncated: true`) | The gateway's SSE replay predated its retained buffer. The returned `next_event_id` cursor is still safe/usable — keep resuming from it. |
| **`task_not_found` after a Gateway restart** | Gateway task/run mappings are **process-local in-memory**; a restart drops them. Start a new task. |
| **Duplicate agent kinds** (e.g. two `mock`) | Agents are distinguished by **`node_id`** — the local mock has no `node_id`; remote ones carry their node's id. Specify `node_id` when starting to target a specific node. |

## See also

- [`mcp-server.md`](mcp-server.md) — the MCP server protocol/reference (tools,
  negotiation, bounded-wait internals, security boundaries).
- [`agent-task-api.md`](agent-task-api.md) — the Agent Gateway REST/SSE contract.
