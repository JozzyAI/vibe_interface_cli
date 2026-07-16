# Workspace leases (durable storage + relay protocol + Agent-Task enforcement)

The goal is to prevent concurrent workflows or Vibe tasks from mutating the same Node
workspace while a workflow owns it, via a durable exclusive lease keyed by
`(node_id, workspace_key)` plus bounded revision evidence.

> **Status — protocol + enforcement (PR #70).** Building on the PR #69 storage/contract
> foundation, the lease authority is now reachable over the relay and Agent Tasks bind to
> leases:
>
> - The **`workspace_lease_v1` capability** is advertised — but **only** when the Node
>   lease store is open, the acquire/get/release ops are registered, **and** run-start
>   enforcement is active (never partial; a Node that cannot enforce does not advertise).
> - Authenticated relay ops **`workspace_lease_acquire` / `get` / `release`** carry only
>   `node_id` + opaque `workspace_key`/lease metadata — the **physical filesystem path
>   never crosses the relay**; the Node computes containment + revision locally.
> - Agent Tasks may carry an optional **`workspace_lease_id`** (in the request
>   fingerprint; distinct from `task_id`/`remote_run_id`/`idempotency_key`/`workflow_id`;
>   **never forwarded to the provider** — not in the prompt, metadata, env, or logs).
> - The Node **enforces the lease at run start**, before any directory/prompt write or
>   backend spawn, and **binds the run to its lease** so the lease cannot be released
>   while a bound run is non-terminal.
>
> **Still deferred:** **WorkflowRuntime does not acquire leases** and does not observe
> revisions — the runtime lifecycle + per-step revision checks are **PR #71**. **PR #67**
> (Workflow API/MCP) remains **Draft/blocked** and is not modified; workflow lease tooling
> is **not** exposed in MCP.

## Authority & layering (target design)

The **Node is the authority** for whether a workspace is currently leased. The
ControlStore keeps a durable **projection** for recovery/inspection only — it is NOT
the authority. The end-to-end path (Runtime step completed in PR #71):

```
Workflow Runtime → Gateway workspace-lease client → relay → Node workspace lease service → contained workspace
```

A lease is deliberately **not** an in-memory Runtime mutex, a Gateway-only row, or a
prompt asking the agent not to modify files — those are insufficient. Enforcement lives
at the **Node run-start gate** (wired in this PR). A caller that cannot reach a
lease-enforcing Node fails closed: a `workspace_lease_id` on a local/in-process backend
is rejected with `workspace_lease_unsupported` rather than silently unprotected.

## Lease identity

`WorkspaceLeaseV1 { workspace_lease_id, workflow_id, node_id, workspace_key,
mode:'exclusive', status: acquiring|active|release_requested|released|conflict,
acquired_at?, release_requested_at?, released_at?, base_revision?, current_revision? }`.

- `workspace_lease_id` is stable, opaque, and **deterministic** per
  `(workflow_id, node_id, workspace_key)` (so recovery reuses it and acquisition is
  idempotent). It is **not** a task id, remote run id, or idempotency key.
- `workspace_key` stays an opaque contained key, never an arbitrary path.
- At most **one active exclusive lease** per `(node_id, workspace_key)`, enforced by a
  partial unique index (the SQLite index is the cross-connection authority).
- Identity fields are immutable; no tokens/credentials/keys/session-ids are stored.

## Node persistence & authority (journal schema v3)

Additive `workspace_leases` + `workspace_revisions` tables. The Node journal exposes:

- `acquireWorkspaceLease(workflow, node, workspace, baseRevision)` — no active lease →
  create one active lease; **same** workflow retries → return the same lease (no
  duplicate); a **different** workflow holding it → `workspace_lease_conflict`. Survives
  journal reopen (a Node restart never silently releases).
- `getWorkspaceLease` / `getActiveWorkspaceLease` / `releaseWorkspaceLease`. Release is
  idempotent, but **refuses while a bound non-terminal run exists** →
  `workspace_lease_in_use` (see run-to-lease binding below).
- `validateWorkspaceLeaseForRun(node, workspace, presentedLeaseId)` — the run-start gate,
  invoked by the Node **before** any directory/prompt write or backend spawn: if the
  workspace is leased, the run must present the **exact active** lease id
  (`workspace_lease_required` if none presented, `workspace_lease_invalid` on mismatch);
  a presented id for an unleased workspace resolves to `workspace_lease_released` (if it
  names a released lease) or `workspace_lease_invalid`; an unleased workspace with no
  presented id allows the run (backward compatible).
- `bindRunToLease(runId, leaseId)` / `isLeaseInUse(leaseId)` — persist the authorizing
  lease on the Node run row (journal schema **v4**, additive nullable column), immutable
  once set; a lease is "in use" while any bound run is non-terminal.
- `recordWorkspaceRevision(lease, step, phase, revision)` — appends a bounded observation
  and updates the lease `current_revision`.

## Relay protocol (`workspace_lease_v1`)

Authenticated request/ack messages, routed to the owning Node by `node_id` (the relay is
a router, never the authority):

- **`workspace_lease_acquire`** `{ node_id, workflow_id, workspace_key, mode:'exclusive' }`
  → the Node resolves containment + observes the base revision **locally**, then
  acquires. Same `(workflow, workspace)` retry is idempotent (`created:false`, same id); a
  different workflow → `workspace_lease_conflict`.
- **`workspace_lease_get`** `{ node_id, workspace_lease_id }` → exact lookup by id (there
  is **no enumeration** endpoint).
- **`workspace_lease_release`** `{ node_id, workspace_lease_id }` → exact, idempotent,
  refused while in use.
- **`workspace_lease_ack`** `{ req_id, ok, created?, lease?, error?, code? }`.

Only `node_id`, the opaque `workspace_key`, and bounded lease projection data cross the
wire — the physical path and Git diff content stay Node-local. An unknown target node →
`workspace_lease_unavailable`. Old Nodes simply don't advertise the capability, so a
lease-requiring caller fails closed against them.

## Agent Task binding

`CreateTaskRequest.workspace_lease_id` is an optional bounded safe identifier, validated
with the same shape rule as `idempotency_key` and **distinct** from
`task_id`/`remote_run_id`/`idempotency_key`/`workflow_id`. It joins the request
fingerprint, so the **same `idempotency_key` with a changed lease → `idempotency_conflict`**
while an identical retry replays. The Gateway carries it **inside the encrypted run-start
payload** (the relay never sees protected task content) and requires an explicit
lease-capable remote `node_id`: a local/in-process backend rejects it with
`workspace_lease_unsupported`, and a remote node that does not advertise the capability is
likewise rejected — never silently unprotected. The lease id reaches the Node **only** for
authorization; it is written to a dedicated Node-local run field and is **never** placed in
the prompt, provider metadata, environment, or logs.

## Revision evidence

`WorkspaceRevision` is bounded + serializable. For a Git workspace:
`{ revision_kind:'git', head_commit, dirty, state_hash, changed_files (bounded),
observed_at }`. `state_hash` deterministically reflects the observable repository state
(HEAD + full `git status --porcelain`) used for conflict detection — even though the
stored `changed_files` list is capped, a change beyond the cap still flips the hash. No
unbounded diff is persisted. A non-Git (or unreadable) workspace is `revision_kind:
'unavailable'` — we never claim Git-level verification we cannot make. Revision evidence
is **system-observed**, distinct from the agent's `executor_handoff.tests_run` /
`changed_files` claims, and a revision change is **not** proof that tests passed.

## Error codes (stable, sanitized)

`workspace_lease_conflict`, `workspace_lease_unavailable`, `workspace_lease_invalid`,
`workspace_lease_released`, `workspace_lease_required`, `workspace_lease_in_use`,
`workspace_lease_unsupported`, `workspace_node_ambiguous`, `workspace_revision_conflict`,
`workspace_revision_unavailable`, `workspace_release_pending`. None expose physical
paths, Git diff content, SQL, DB paths, tokens, or stack traces.

## ControlStore projection (schema v7)

Additive `workflow_workspace_leases` table (unique active projection per
`workflow_id, node_id, workspace_key`; optimistic `revision`; bounded base/current
revision JSON). The Node remains authoritative; the projection supports recovery and
inspection. Active leases are never removed by ordinary retention.

## Roadmap (NOT in this PR)

- **PR #71 — WorkflowRuntime lifecycle + revision checks.** Deterministic target
  resolution (explicit `node_id`, else `workspace_node_ambiguous`), acquire in canonical
  sorted order before the first Agent Task, record base revisions, observe before/after
  each step (mismatch → `workspace_revision_conflict`, no task start), retain leases
  across states/restarts/`blocked`, release only after all bound tasks terminalize (never
  while a task may still be writing). No TTL auto-expiry.

## Limits of protection

A lease is enforced at the Node run-start gate — it blocks another workflow's task, a
direct Vibe task without a lease, and a task with an old/released lease. It **cannot**
prevent a human or unrelated OS process from editing the workspace
files directly; such out-of-band edits are **detected later** via the revision checks
(`state_hash` divergence → `workspace_revision_conflict`), not prevented by the lease.

## Out of scope

Automatic Git worktree creation, shared read-only leases, role-based permissions,
completion policy, test verifier, waiting_input/approval, no-progress detection, NL
compiler, Workflow Map UI, A2A, production deployment.
