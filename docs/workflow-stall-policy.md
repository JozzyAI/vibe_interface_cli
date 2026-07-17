# Workflow no-progress detection (stall policy)

An optional, bounded **`stall_policy`** lets the Workflow Runtime detect that a loop is
going in circles and **block** it (reason `no_progress`) instead of looping forever. It
is evaluated **only when an explicit loop edge is taken** — there is **no LLM-based
progress judgment** and **no automatic repair**.

## Policy model

```json
{ "stall_policy": {
  "max_stalled_rounds": 3,
  "signals": ["planner_next_step", "remaining_work", "workspace_revision", "verified_evidence"]
} }
```

- `max_stalled_rounds` — the number of **consecutive** loop rounds whose signals are all
  unchanged that triggers a block (positive integer).
- `signals` — the signals compared each loop round (non-empty). A `stall_policy` is only
  valid on a spec that has a loop edge.

Omitting `stall_policy` preserves current behavior (loops are bounded only by
`limits.max_rounds`).

## Signals (deterministic, runtime-derived)

Each loop round the runtime derives a value per configured signal and hashes the
configured set into a bounded **fingerprint** (only the configured signals participate):

| Signal | Value |
| --- | --- |
| `planner_next_step` | the looping review step's `output.next_step` |
| `remaining_work` | the latest executor handoff's `remaining_work` |
| `workspace_revision` | the workspace lease's current revision `state_hash` (system-observed) |
| `verified_evidence` | the **content hash** of the most recent completed task result (system-owned) — never an agent claim |

A stall is detected when the current fingerprint has been unchanged for
`max_stalled_rounds` consecutive rounds.

## On trigger

- **No next Agent Task starts.**
- The workflow is set to **`blocked`** with reason **`no_progress`** (non-terminal).
- **Workspace leases are retained** (a blocked workflow keeps its leases).
- The decision is **durable**: each loop round's fingerprint is persisted
  (`workflow_stall_rounds`, ControlStore **schema v11**, first-write-wins per round).

## Durability & restart

Because each round's fingerprint is first-write-wins per `(workflow, round)`, a restart
**never double-counts** a round, and terminalization is idempotent, so a restart never
emits a **duplicate `no_progress` blocked event**.

## Not in this layer

No compiler, no UI, no automatic repair, and no LLM-based progress judgment.
