# Agent Task API — canonical contract

The **Vibe Agent Gateway** turns any locally-runnable agent harness (Claude Code,
Codex, mock, …) into a uniform, streaming **Task API** so external callers
(Symphony, Linear/GitHub automation, n8n, Slack bots, other agents, MCP hosts)
can invoke an agent without knowing which harness runs underneath.

This document defines the **canonical, agent-neutral contract** — the stable
schema that the gateway's REST + SSE surface, and later the A2A and MCP adapters,
all map onto. It is implemented as pure types + mapping functions in
[`src/lib/agent-task-contract.ts`](../src/lib/agent-task-contract.ts). **There is
no HTTP server, bearer-token logic, SSE listener, or persistence at this layer** —
those arrive in later PRs. The existing run lifecycle
(`RunRecord`/`RunEvent`/`RunStatus`) remains the single source of truth; this
contract is a projection of it.

`contract_version` is carried on every resource (currently **1**).

## Task identity

`task_id == run_id` (1:1). A `run_id` is an internally-generated **opaque token**
(e.g. `run_xxxx`) — not a process, tmux session, or workspace identifier — so it
is safe to expose. The mapping is intentionally centralized (`taskIdForRun` /
`runIdForTask`) so it can change without touching callers.

**No backend-specific identifiers are ever exposed.** A `Task` never carries
`session_id`, `child_pid`, `workspace_path`, `prompt_file`, `repo_url`/`branch`,
or any `*_aes_key`.

## Task creation request

```jsonc
{
  "agent": "claude-code",          // required
  "node_id": "node_f7…",           // optional; omitted/local/auto → local node
  "input": { "text": "Fix the failing auth test" },   // required
  "workspace": { "path": "…", "repo_url": "…", "branch": "…", "workspace_key": "…" },
  "execution": { "permission_mode": "default", "timeout_seconds": 1800 },
  "metadata": { "source": "symphony", "issue_id": "JOZ-21" }
}
```

Deliberately **excluded** for the MVP arc: approvals, follow-up messages,
artifacts, file transfer, multi-user ownership.

## Task status

Canonical states: `queued`, `starting`, `running`, `completed`, `failed`,
`cancelled`.

| RunStatus            | TaskStatus            | notes |
|----------------------|-----------------------|-------|
| `queued`             | `queued`              | |
| `running`            | `running`             | |
| `completed`          | `completed`           | |
| `failed`             | `failed`              | includes runtime timeouts in v1 (see deferred `timed_out`) |
| `stopped`            | `cancelled`           | |
| `cancelled`          | `cancelled`           | |
| `blocked`            | `running`             | no runtime path preserves a paused state today |

- **`starting`** is gateway-synthesized (accepted, awaiting the node's first
  `status:running`); the status-only mapper never emits it.
- **Deferred — `timed_out`:** the runtime has no structured timeout reason today
  (a run timeout surfaces as a plain `failed` with a diagnostic string and
  `failure_reason:'unknown'`). Inferring `timed_out` by matching that string would
  risk the Task resource and the SSE terminal event disagreeing, so a timed-out
  run projects to `failed` in v1. `timed_out` — with a matching `task.timed_out`
  SSE terminal event — will be added together with a structured runtime timeout
  reason so both surfaces agree.
- **Deferred — `input_required` / `approval_required`:** no runtime path currently
  produces or *preserves* a waiting state (`status:'blocked'` is never written;
  `approval_required` events are informational and do not halt the run). These
  land with interactive tasks.

Legal transitions are defined in `TASK_TRANSITIONS`; terminal states are sinks.

## Event envelope

Versionable, agent-neutral, with a monotonic per-task `seq`:

```jsonc
{ "seq": 12, "task_id": "run_…", "type": "agent.output.delta",
  "ts": "…", "payload": { "stream": "stdout", "text": "…" }, "contract_version": 1 }
```

Initial taxonomy (minimal, mappable from existing `RunEvent` data):
`task.created`, `task.started`, `agent.output.delta`, `agent.output.completed`,
`task.completed`, `task.failed`, `task.cancelled`.

- Mapped from run events today: `status(running|completed|failed|stopped|cancelled)`
  → `task.*`; `log` → `agent.output.delta`.
- `task.created` and `agent.output.completed` are lifecycle **bookends
  synthesized by the emitter**, not produced by the run-event mapper.
- **Deferred (dropped from the stream for now):** `tool_call`, `pr_created`,
  `approval_*`, and `error` run events have no reliable neutral mapping yet and
  will get dedicated event types when the data model supports them. Failure
  detail remains available on the `Task` resource (`error`).

## Agent discovery

Conservative descriptor — no invented capabilities:

```jsonc
{ "id": "claude-code", "node_id": "node_f7…", "available": true, "streaming": true }
```

Built from a node's advertised agent id list (`resolveAgents()` locally or
`VibeNode.agents` over the relay). `streaming` is set only for agents known to
stream; unknown ids omit it.

## Error contract

Transport-neutral `ApiError`. Only the opaque `task_id` is ever exposed — the
internal `run_id` never reaches the wire (a `VibeError.run_id` is converted
through `taskIdForRun` and surfaced as `task_id`):

```jsonc
{ "error": true, "code": "node_offline", "message": "…", "retryable": true,
  "task_id": "run_…", "details": { … }, "ts": "…" }
```

Codes: `invalid_request`, `unauthorized`, `agent_unavailable`, `node_offline`,
`service_unavailable`, `task_not_found`, `invalid_state_transition`,
`cancellation_conflict`, `internal_error`. `node_offline` (a specific node is
unreachable) and `service_unavailable` (the relay/gateway itself is unreachable —
the public code never exposes "relay") are kept distinct; both are `503` and
retryable. Legacy `VibeError` (`src/types.ts`) and remote `RunErrorCode`
(`src/lib/run-error.ts`) both map into this schema
(`vibeErrorToApiError` / `runErrorToApiError`, with `relay_unavailable →
service_unavailable`); `apiErrorHttpStatus` suggests a REST status per code.

## Boundary (important)

Vibe is positioned as **self-hosted / user-owned**: a user-owned node with
user-owned credentials on a private network or trusted orchestrator. It is **not**
a public multi-tenant SaaS reselling a shared Claude subscription (an Anthropic
ToS boundary). The gateway's auth (added in a later PR) is a Bearer token,
loopback-only by default.

## Backwards-compatibility for future adapters

- **REST** maps `Task`/`TaskEvent`/`ApiError` directly; `apiErrorHttpStatus`
  gives status codes.
- **SSE** emits `TaskEvent` frames (`event: <type>` / `data: <json>`), `seq`
  giving clients an ordering/resume anchor.
- **A2A** maps its Agent Card ← `AgentDescriptor`, Task ← `Task`, status/artifact
  updates ← `TaskEvent`, cancel ← the cancel action.
- **MCP** exposes `list_agents`/`start_task`/`get_task`/`stream_task`/`cancel_task`
  over the same types.

Adapters must map **onto** this contract rather than re-deriving from
`RunRecord`/`RunEvent`, so run-lifecycle changes stay isolated behind these pure
functions and `contract_version` is the single compatibility signal.
