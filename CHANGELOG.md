# Changelog

All notable changes to `vibe-interface-cli` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-07-14

The **MCP milestone**: the Vibe Agent Gateway is now reachable from local MCP
hosts (Claude Code, Cursor, …) as a set of tools, entirely as a pure HTTP client
of the Gateway — no changes to Gateway core, the relay, node execution, task
lifecycle, or encryption.

### Added

- **MCP stdio server** — `vibe mcp serve`: a dependency-free (at runtime)
  JSON-RPC 2.0 server over newline-delimited stdio. stdout carries only protocol
  messages; diagnostics go to stderr; the API token is never printed.
- **MCP protocol `2025-11-25`** (the official SDK's latest) with backwards
  negotiation — an explicitly requested supported version (`2025-11-25` /
  `2025-06-18` / `2025-03-26` / `2024-11-05`) is echoed, otherwise it negotiates
  down to `2025-11-25`; it never claims an unimplemented/future version.
- **Official MCP SDK compatibility** — the official `@modelcontextprotocol/sdk`
  (dev/test dependency only, never a runtime dependency) drives the real spawned
  server end-to-end in the test suite.
- **Claude Code real-host compatibility** — verified end-to-end against the
  Claude Code CLI as a real MCP host.
- **Seven MCP tools:**
  - `vibe_list_agents` — list runnable agents (local mock + each online node's
    advertised agents).
  - `vibe_start_task` — start a task and return immediately (Gateway v1 fields
    only; no path/repo/branch/timeout/shell).
  - `vibe_get_task` — authoritative canonical Task by id.
  - `vibe_get_task_events` — one bounded poll of a task's events.
  - `vibe_cancel_task` — cancel a running task (destructive, idempotent).
  - `vibe_run_task` — start **and** bounded-wait in one call (convenience
    workflow; may return before completion).
  - `vibe_wait_task` — resumable bounded wait on an existing task.
- **Resume cursor without gaps or duplicates** — `next_event_id` is the greatest
  **consumed** event id; passing it back as `after_event_id` yields strictly
  greater events, so there is no boundary duplicate and no gap. A poll that
  consumes nothing preserves the cursor.
- **Bounded wait/resume workflows** — `vibe_run_task` / `vibe_wait_task` share
  one overall `wait_seconds` budget (default 30s, min 0.5s, max 120s; rejected,
  not clamped) across internal polls; each internal SSE poll stays capped at 30s
  and at the remaining budget, so the total never exceeds the budget and there is
  no unbounded loop.
- **Authoritative terminal status** — terminal is decided by the GET Task status
  (`completed` / `failed` / `cancelled`), even if the terminal SSE event was
  missed; a missing terminal event is never fabricated and a terminal task never
  regresses to running.
- **Timeout / disconnect never auto-cancels** — a wait timeout or an MCP client
  disconnect never cancels a Gateway task; only `vibe_cancel_task` cancels. If
  task creation succeeds but the subsequent wait fails, the created `task_id` is
  preserved and the task is not auto-cancelled.
- **Dedicated Gateway Bearer-token file** — the MCP server reads the API token
  from a `0600` file (symlink / group-or-world-readable / empty / malformed files
  are rejected) and uses it only in the `Authorization` header. A non-loopback
  Gateway URL requires an explicit `--allow-remote-gateway` opt-in.
- **Documentation** — [`docs/mcp-server.md`](docs/mcp-server.md) (protocol /
  reference) and [`docs/mcp-client-integrations.md`](docs/mcp-client-integrations.md)
  (Claude Code + Cursor setup, seven-tool reference, recommended run/wait/resume
  workflow, security, troubleshooting).

### Fixed

- **MCP `serverInfo.version`** now reflects the real `package.json` version in the
  compiled/installed layout (previously reported the `0.0.0` sentinel because the
  version was resolved with a fixed relative path that only lined up in the TS
  source tree). `vibe --version` and MCP `serverInfo.version` now share one
  layout-robust package-version resolver.

### Notes

- **MCP remains a pure Gateway HTTP client** — it does not connect to the relay,
  never reads the relay token, adds no arbitrary shell execution, and does not
  duplicate or bypass task validation (all validation, workspace containment,
  encryption, and execution stay in the Gateway and node layers).
- **Cursor configuration is documented but was not live GUI-validated** in the
  release environment (no headless Cursor client was available). The `mcp.json`
  schema and stdio startup command are validated (identical to what the Claude
  Code acceptance and the test suite drive); version-dependent UI details are
  labeled unverified in the guide.

### Unchanged limitations

- The Gateway's task↔run mappings and SSE replay history remain **process-local
  and in-memory**.
- **No durable task adoption after a Gateway restart** — a restart drops the
  in-memory task/replay state (`task_not_found` for prior ids).
- **No A2A** adapter yet.
- **No public multi-user SaaS authentication** — self-hosted / user-owned node +
  user-owned credentials on a trusted network only.
- **No arbitrary-shell MCP tool.**
- **No direct MCP-to-relay connection** — the MCP server only talks to the local
  Gateway over HTTP.

### Acceptance baseline

- **PRs:** #56 (MCP stdio server + five tools), #57 (`vibe_run_task` /
  `vibe_wait_task` wait/resume workflows), #58 (Claude Code + Cursor integration
  guides). All squash-merged to `main`.
- **Final `main` SHA before this release PR:** `405fd9e`.
- **Tests:** focused MCP + SDK-compat + Gateway/contract suites **101/101**
  (includes a built-CLI regression asserting `serverInfo.version` == `vibe
  --version` == `package.json` version); full suite **559 passing**, with the
  **12 known Codex / node-local environment failures** tracked separately (they
  depend on a Codex binary and node-local host state absent from this
  environment — not MCP-related).
- **Claude Code MCP acceptance:** connected as a real host; all seven tools
  visible; `vibe_list_agents` works; `vibe_run_task` → timeout → `vibe_wait_task`
  resume → completed with no skipped/duplicated events; a wait timeout left the
  task running and only `vibe_cancel_task` cancelled it. Run against a temporary
  loopback Gateway with a temporary token/workspace, torn down afterward.
- **Cursor:** configuration schema + stdio startup command validated; live GUI
  validation not performed (no headless Cursor client).
- **Production services were not restarted for the MCP arc** — the relay, node
  daemon, dashboard, and `vibe-node` were untouched throughout #56–#58 and this
  release preparation.

## [0.1.0] — 2026-07-14

Initial **Vibe Agent Gateway v1** release — a REST + SSE Task API (`vibe api
serve`) in front of the existing run lifecycle, with a canonical agent-neutral
Task/event/error contract, Bearer auth (loopback-default), the local **mock**
agent, and **remote Claude Code / Codex** execution over an encrypted relay
transport. See [`docs/agent-gateway-v1-baseline.md`](docs/agent-gateway-v1-baseline.md).

[0.2.0]: https://github.com/JozzyAI/vibe_interface_cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/JozzyAI/vibe_interface_cli/releases/tag/v0.1.0
