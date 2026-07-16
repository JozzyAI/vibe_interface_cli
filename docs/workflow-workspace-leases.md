# Workspace lease foundation (durable storage + contract)

The eventual goal is to prevent concurrent workflows or Vibe tasks from mutating the
same Node workspace while a workflow owns it, via a durable exclusive lease keyed by
`(node_id, workspace_key)` plus bounded revision evidence.

> **Status — foundation only.** This PR delivers the durable lease/revision **STORAGE
> and CONTRACT** and the Node-local lease operations. It exposes **no new externally
> usable behavior**:
>
> - **No relay protocol** is exposed yet — leases cannot be acquired/released over the wire.
> - The `workspace_lease_v1` **capability is intentionally NOT advertised** in this PR.
> - **Agent Tasks do not yet carry `workspace_lease_id`.**
> - **WorkflowRuntime does not acquire leases** and does not observe revisions.
> - The Node's run-start `validateWorkspaceLeaseForRun` is present as an internal
>   method but is **not yet wired into remote run start**.
>
> **Roadmap:** **PR #70** adds the relay `workspace_lease_v1` capability + acquire/get/
> release operations, Agent-Task `workspace_lease_id` binding, and Node run-start
> enforcement. **PR #71** adds the WorkflowRuntime acquire/release lifecycle and
> per-step revision checks. **PR #67** (Workflow API/MCP) remains **Draft/blocked** and
> is not modified.

## Authority & layering (target design)

The **Node is the authority** for whether a workspace is currently leased. The
ControlStore keeps a durable **projection** for recovery/inspection only — it is NOT
the authority. The intended end-to-end path (completed across PR #70/#71):

```
Workflow Runtime → Gateway workspace-lease client → relay → Node workspace lease service → contained workspace
```

A lease is deliberately **not** an in-memory Runtime mutex, a Gateway-only row, or a
prompt asking the agent not to modify files — those are insufficient. Enforcement will
live at the Node run-start gate (wired in PR #70).

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
- `getWorkspaceLease` / `getActiveWorkspaceLease` / `releaseWorkspaceLease` (idempotent).
- `validateWorkspaceLeaseForRun(node, workspace, presentedLeaseId)` — the run-start gate
  LOGIC (not yet wired into run start; that is PR #70): if the workspace is leased, a run
  must present the matching active lease id; a missing lease → `workspace_lease_conflict`,
  a wrong lease → `workspace_lease_invalid`; an unleased workspace allows any run.
- `recordWorkspaceRevision(lease, step, phase, revision)` — appends a bounded observation
  and updates the lease `current_revision`.

These are internal Node-local operations only. No relay message exposes them yet, and no
capability is advertised, so nothing outside the Node can acquire, release, or be gated
by a lease in this PR.

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
`workspace_lease_released`, `workspace_node_ambiguous`, `workspace_revision_conflict`,
`workspace_revision_unavailable`, `workspace_release_pending`. None expose physical
paths, Git diff content, SQL, DB paths, tokens, or stack traces.

## ControlStore projection (schema v7)

Additive `workflow_workspace_leases` table (unique active projection per
`workflow_id, node_id, workspace_key`; optimistic `revision`; bounded base/current
revision JSON). The Node remains authoritative; the projection supports recovery and
inspection. Active leases are never removed by ordinary retention.

## Roadmap (NOT in this PR)

- **PR #70 — protocol + Agent Task enforcement.** The relay `workspace_lease_v1`
  capability + authenticated `workspace_lease_acquire`/`get`/`release` ops (advertised
  only with full enforcement available; old Nodes degrade explicitly; only
  `node_id`/`workspace_key`/opaque lease metadata cross the wire — real paths stay
  Node-local). An optional Agent-Task `workspace_lease_id` (in the request fingerprint;
  never forwarded to Claude/Codex or provider env/metadata; distinct from `task_id` /
  `remote_run_id` / `idempotency_key`). Node run-start enforcement wired in, plus
  run-to-lease binding so a lease cannot be released while a bound run is non-terminal.
- **PR #71 — WorkflowRuntime lifecycle + revision checks.** Deterministic target
  resolution (explicit `node_id`, else `workspace_node_ambiguous`), acquire in canonical
  sorted order before the first Agent Task, record base revisions, observe before/after
  each step (mismatch → `workspace_revision_conflict`, no task start), retain leases
  across states/restarts/`blocked`, release only after all bound tasks terminalize (never
  while a task may still be writing). No TTL auto-expiry.

## Limits of protection

Even once wired, a lease is enforced at the Node run-start gate — it blocks another
workflow's task, a direct Vibe task without a lease, and a task with an old/released
lease. It **cannot** prevent a human or unrelated OS process from editing the workspace
files directly; such out-of-band edits are **detected later** via the revision checks
(`state_hash` divergence → `workspace_revision_conflict`), not prevented by the lease.

## Out of scope

Automatic Git worktree creation, shared read-only leases, role-based permissions,
completion policy, test verifier, waiting_input/approval, no-progress detection, NL
compiler, Workflow Map UI, A2A, production deployment.
