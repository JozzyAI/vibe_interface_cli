# Natural-language Workflow Compiler

The compiler turns a **natural-language** workflow request into ONE validated
`WorkflowSpec` candidate captured as an immutable **WorkflowDraft**, then lets a human
approve it by its exact hash to materialize a `ready` workflow. The compiler LLM is
**never authoritative**: it proposes a bounded JSON object which trusted code re-parses,
re-validates, canonicalizes, and previews. Compile does **not** approve; approve does
**not** start.

## Architecture (`src/workflow/compiler/`)

```
compile request → WorkflowCompiler
   ├─ InventoryProvider.snapshot()          (safe agents/nodes; no tokens/keys/paths)
   ├─ CompilerModelClient.compile()          (runs the model via the DURABLE Agent Task path)
   │     └─ AgentTaskResult final_output      (the ONLY authoritative compiler output)
   ├─ parseCompilerResult()                   (strict single-JSON; no prose/repair/heuristics)
   ├─ validateReady()                          (10-step trusted re-validation)
   ├─ buildPolicySummary() / buildPreview()    (deterministic, trusted code — not LLM prose)
   └─ ControlStore workflow_drafts             (immutable; idempotent)
```

The compiler **never** calls the relay, a Node, a provider adapter, or the
WorkflowRuntime directly — only the injected `CompilerModelClient` (the durable Agent
Task path), the `InventoryProvider`, and the `ControlStore`.

## Inventory contract

`InventoryProvider.snapshot()` returns `{ agents: InventoryAgent[], observed_at }` where
each `InventoryAgent` is `{ agent, node_id?, permission_modes[], workspace_supported,
capabilities[] }`. Role assignment is fully flexible (Codex planner + Claude
implementer, Claude-only, one agent in multiple roles, single-step) — the compiler
model's own identity never constrains the generated roles. Every generated `(agent,
node_id)` placement is checked against this inventory.

## Compiler output (strict)

The model must emit exactly one JSON object (nothing else):

```json
{ "schema_version":"1", "status":"ready|needs_input|impossible|policy_denied",
  "workflow_spec":{}, "input_values":{}, "rationale":{}, "questions":[], "warnings":[] }
```

Strict JSON, no trailing prose, no heuristic extraction, no repair call, unknown fields
rejected. Misleading JSON in intermediate task events is ignored — only the
AgentTaskResult controls the result.

## Validation (`status:ready`)

Trusted code re-checks: (1) result schema, (2) the WorkflowSpec via the existing
validator, (3) input values, (4) every agent exists in the inventory, (5) every
`(agent, node)` placement is supported, (6) requested permissions are enforceable, (7)
workspace requirements are supported, (8) limits are within system policy, (9) a
completable workflow declares a `completion_policy`, (10) no secret/credential-like
fields. Any failure yields an **invalid** (unapprovable) draft.

## WorkflowDraft (ControlStore schema v12, immutable)

`workflow_drafts` persists: `draft_id`, `compiler_task_id`, normalized `constraints`,
`inventory_snapshot` + `inventory_hash`, canonical `spec` + `spec_hash`, `input_values`,
trusted `policy_summary` + `policy_summary_hash`, deterministic `preview`, `rationale`,
`warnings`/`questions`, `compiler_status`, `validation_status`, `approval_status`,
`materialized_workflow_id`, timestamps. A unique `idempotency_key` = hash(request +
constraints + inventory_hash) makes compile create-or-return. **A changed request or
spec creates a NEW draft; a finalized draft is never mutated.**

## Canonicalization & hashes

A hash is SHA-256 over stable canonical JSON (recursively sorted keys). `spec_hash`,
`policy_summary_hash`, and `inventory_hash` are deterministic; ANY agent / node /
permission / limit / route / policy change changes the hash.

## Preview (trusted, not LLM)

`buildPreview` emits — from the validated spec only — roles, agent/node assignments,
steps + edges (loop / terminal routes), workspace access, permissions, network
capability, task/round/runtime limits, completion policy, stall policy, the
verified-test requirement, external-side-effect warnings, and a text graph.

## Approval & materialization

Approval binds to the exact `spec_hash` (the caller supplies the inspected hash) plus
the draft's immutable `policy_summary_hash` + `inventory_snapshot_hash`. It must be
explicit, cannot be performed by the compiler agent or inferred from the request, is
**idempotent** for the same hash, **fails closed** on a hash mismatch, creates **exactly
one** `ready` workflow (deterministic id → idempotent), and **never starts** it. Any
Agent/Node/permission/workspace/limit/route/policy change produces a different draft +
hash, which cannot approve the old one.

## API / MCP

- REST: `POST /v1/workflow-drafts/compile`, `GET /v1/workflow-drafts/:id`,
  `POST /v1/workflow-drafts/:id/approve` (body `{ spec_hash }`).
- MCP: `vibe_compile_workflow`, `vibe_get_workflow_draft`, `vibe_approve_workflow_draft`.

Compile does not approve; approve does not start; starting still uses
`vibe_start_workflow`. MCP remains a pure Gateway HTTP client.

## Compile idempotency

An OPTIONAL caller-supplied `idempotency_key` identifies **one durable compile
operation**. Request identity is the hash of the NORMALIZED request + constraints
**only** — never volatile inventory fields (`observed_at`, transient
capacity/liveness). On first creation the operation captures **exactly one** inventory
snapshot (persisted on the draft, used as provenance via `inventory_snapshot_hash`). A
lost-response retry with the **same key + same request** returns the existing
draft/task and **does not re-snapshot**; the **same key + a changed request/constraints**
fails closed with `idempotency_conflict`. The compiler Agent Task is keyed to the stable
draft id (`idempotency_key = compile:<draft_id>`), not the request or inventory.

**Without an idempotency key, each compile creates a NEW operation (no retry
deduplication).**

## Compiler-agent permission enforcement

The compiler task runs with an enforceable **minimum-capability profile** — permission
mode `default` (approval-gated, never `unsafe-skip`), **no** workspace write, git push,
deploy, secret access, or external side effects; network disabled (v1 tasks have none).
Enforcement comes from the **Node/provider capabilities in the inventory**, not prompt
text: before starting the task the compiler verifies the selected `(compiler_agent,
compiler_node_id)` placement can enforce `default`; if not, it **fails closed before any
task is created** (no silent downgrade). A safe capability summary is persisted on the
draft (`compiler_capability`).

## Recovery

Recovery re-runs are idempotent at every crash boundary — compile-record-before-task,
task-before-bind, result-before-finalize, approval-before-materialize (deterministic
workflow id), workflow-before-draft-bind — so it never creates duplicate compiler tasks,
drafts, approvals, or ready workflows, and never auto-starts a workflow.

## Not in this layer

No graphical Workflow Map UI, automatic approval/start, compiler repair loops,
conversational resume, new step types, or A2A.
