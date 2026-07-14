# Vibe Agent Gateway v1 — production acceptance baseline

This is the frozen v1 baseline. Its purpose is diagnostic: when the MCP / A2A
adapters (next arc) misbehave, this record lets us tell an **adapter** problem
apart from a **Gateway core** regression. Do not change Gateway v1 core to make an
adapter work — fix the adapter, or open a separate, reviewed core change.

Contains **no secrets** — no tokens, encryption keys, API tokens, or authenticated
URLs.

## Frozen scope

```
REST + SSE  →  dedicated Bearer auth  →  encrypted relay  →  remote Claude Code / Codex
            →  authoritative status + idempotent cancel  →  node-side workspace containment
```

Layers (all merged to `main`):

| PR   | What | squash |
|------|------|--------|
| #50  | relay: preserve current node registration on stale disconnect | `cecb46d` |
| #51  | canonical agent task contract (types + mappers) | `dfe9d26` |
| #52  | local agent task gateway (mock, REST + SSE) | `30b3405` |
| #53  | execute agent tasks on remote vibe nodes (encrypted; reconciliation; cancel) | `5fe1998` |
| #54  | node: contain remote workspaces within workspace root | `3d2ac81` |

**Baseline code:** `main` at `3d2ac81` (the v1 milestone commit). Package version
`0.1.0`.

## Contract invariants (must hold for v1)

- **Auth:** `Authorization: Bearer` only (dedicated API token, never the relay or
  terminal token); constant-time compared; loopback-only unless `--allow-bind`;
  token lives only in a `0600` file and is never printed/logged/echoed.
- **Request semantics fail closed:** only `agent`, `node_id`, `input.text`,
  `workspace.workspace_key`, `execution.permission_mode`, `metadata` are honored;
  `workspace.path`/`repo_url`/`branch` and `execution.timeout_seconds` are rejected
  (`invalid_request`/400), never silently dropped; `workspace_key` must match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; unsafe values are never echoed.
- **Remote execution is encrypted end-to-end:** `run_start` is encrypted for the
  target node (mandatory preflight requires the node online, advertising the
  agent, with an encryption key); **no plaintext fallback**.
- **Transport ≠ result:** a dropped event stream never fabricates a terminal
  status; the gateway reconciles authoritative status with bounded backoff.
- **Terminal exactly once:** GET, cancel, and stream terminal events fold through
  one reconciliation that is terminal-monotonic (a terminal task never regresses)
  and emits exactly one terminal event; cancel is idempotent.
- **Node is the filesystem trust boundary:** the node independently contains every
  relay client's `workspace_key` within its workspace root (opaque-key rule +
  realpath containment + existing-escaping-symlink rejection). Residual TOCTOU
  limitation documented in `src/workspace.ts` (per-component `O_NOFOLLOW` follow-up).
- **Durability is process-local:** task→run mappings and SSE history are in-memory
  only; a gateway restart loses them (the run store is unaffected). Bounds:
  active 32, retained-completed 100, events/task 1000, body 1 MiB.

## Deterministic test baseline

- Full suite: **538 tests, 526 pass, 12 fail** — the 12 are the known
  environment-specific failures on a box without the `codex` binary
  (`codex: …`, `node list: …`, `node status local: …`). Any *other* failure is a
  regression.
- Focused gateway/contract/node suites: `agent-task-contract` + `agent-gateway`
  (local) + `agent-gateway-remote` + `agent-gateway-encrypted` +
  `node-workspace-containment` all green.

## Live production acceptance (verified 2026-07-14)

Topology (LAN, no external exposure): a Mac relay on port `7433`; a
terminal-dashboard gateway on port `8790`; a WSL production node
(`node_f7cedd3b6590aff9`, a public key-derived id) in tmux `vibe-node`, advertising
`mock`, `claude-code`, `codex`, running `main@3d2ac81`.

Verified end-to-end against the live production relay + node:

- `GET /v1/agents` lists the node with `claude-code` and `codex`.
- **Claude Code** and **Codex** each ran a task end-to-end over **encrypted**
  remote execution: ordered canonical SSE (`task.created → task.started →
  agent.output.delta… → task.completed`), `GET` matched the SSE terminal state.
- Cancel is idempotent and terminal exactly once.
- No `run_id`-internal/session/workspace/PID/encryption-key/token/raw-envelope
  value appeared in API output; the API token never appeared in logs.
- **Node-side containment:** an unsafe `workspace_key` (`../…`) sent straight to
  the node (bypassing the gateway) returned a structured `invalid_workspace_key`,
  created no workspace directory and no run record, started no backend, did not
  echo the unsafe value, and left the node online; a safe explicit key and an
  omitted key both remained compatible.

The gateway ran as an isolated, loopback-only process with a temporary token file
and temporary workspace, torn down after the smoke; the production relay,
dashboard gateway, node daemon, and `vibe-node` tmux were not restarted or
modified.
