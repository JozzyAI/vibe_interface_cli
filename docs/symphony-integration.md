# Symphony Integration Guide

Vibe Interface CLI is a **worker-node runtime**. Symphony is the orchestrator.
Symphony dispatches work to Vibe; Vibe never polls Symphony.

---

## CLI contract

For the authoritative CLI contract — the canonical command path, profile/default
behavior, success outputs, the JSONL event schema, the structured error
envelope, and exit codes — see **[`docs/orchestrator-contract.md`](orchestrator-contract.md)**.

That document is the single source of truth; this guide keeps only
Symphony-specific notes and does not restate the schema (to avoid drift).

In short, Symphony dispatches and observes a run with:

```
vibe run start   -> RunRecord JSON (run_id, status)
vibe run status  -> RunRecord JSON
vibe run stream  -> RunEvent JSONL until a terminal status
vibe run stop    -> updated RunRecord JSON
```

Terminal completion/failure/stop is a `status` event with a terminal `status`
value — not a `completed`/`failed`/`stopped` event type, and there is no
`.data.*` envelope. See the orchestrator contract for the exact event shapes.

---

## Environment Variables

| variable | default | description |
|----------|---------|-------------|
| `VIBE_WORKSPACE_ROOT` | `~/.vibe/workspaces` | root directory for all workspaces |
| `VIBE_NODE_ID` | `local` | node identifier in run records |

---

## Roadmap

| command | MVP |
|---------|-----|
| `vibe run start/stream/status/stop` | 0 (mock), 1 (claude-code) |
| `vibe node pair/daemon` | 3 (remote node) |
| `vibe run approve/deny` | 5 (approval flow) |
| `vibe run continue` | 5 |
