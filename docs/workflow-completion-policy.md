# Workflow completion policy (verified evidence)

An agent declaring `status: "complete"` (routing to `$complete`) is a **claim**, not a
completion. When a `WorkflowSpec` declares a **`completion_policy`**, the Workflow
Runtime must first verify **system-observed evidence** before it completes the
workflow. This is an INTERNAL runtime capability — no REST/MCP surface, no generic
shell verifier, and test success is **never** inferred from agent prose or from the
mere presence of repository changes.

## Policy model (bounded, declarative)

```json
{
  "completion_policy": {
    "required_evidence": ["task_status", "exit_code", "content_hash", "workspace_revision", "changed_files", "tests_passed"],
    "require_repository_change": true,
    "require_no_remaining_work": true,
    "require_tests_passed": true
  }
}
```

- `required_evidence` — evidence types that must be **present** (observed) to complete.
- `require_repository_change` — the workspace revision must have **changed** (system-owned).
- `require_no_remaining_work` — the completing step's declared `remaining_work` must be empty.
- `require_tests_passed` — **provider-structured** test evidence must show tests passed.

## Required for completable specs

A **newly created** spec that can reach `$complete` (any edge routes to it) **must**
declare a `completion_policy` — creating one without a policy fails validation
(`completion_policy_required`). A spec with **no `$complete` route** may omit it. An
empty policy (`{}`) is the explicit "no extra evidence required" choice (completion is
still gated: conflicting evidence fails closed).

**Legacy compatibility.** A workflow persisted *before* this rule (a completable spec
with no policy) still executes, but its completion is marked **`legacy_unverified`** and
is **never** reported as `verified: true`. The workflow snapshot exposes
`completion_verification: "verified" | "legacy_unverified" | null` so a caller never
mistakes a legacy completion for a verified one.

## Evidence provenance

`tests_passed` / `tests_failed` may come **only** from a **Harness-owned,
provider-structured** `evidence_ref` (kind `tests_passed`/`tests_failed`) on the durable
`AgentTaskResult`. The agent's final JSON, its `tests_run` field, and arbitrary
evidence-ref summary text **never** create verified test evidence.

## Evidence model (system-observed, durable)

At the completion decision the runtime assembles a bounded `VerifiedEvidence` snapshot
from **already-durable system facts** — never agent claims:

| Field | Source (system-owned) |
| --- | --- |
| `task_status` | authoritative durable task status |
| `exit_code` | `AgentTaskResult.process_exit_code` |
| `content_hash` | `AgentTaskResult.content_hash` |
| `revision_before` / `revision_after` | workspace revision observed before/after the step |
| `repository_changed` | `revision_before !== revision_after` (derived) |
| `changed_files` / `changed_files_hash` | observed changed files after the step |
| `tests_passed` | provider `evidence_ref` `tests_passed` (→true) / `tests_failed` (→false); absent → null |

Agent-reported fields such as `tests_run` remain **claims** and never satisfy
`require_tests_passed`. The snapshot + decision are persisted durably
(`workflow_completion_evidence`, schema v10, first-write-wins) so a restart never
re-derives or re-completes, and the decision is auditable.

## Routing behavior

- requested complete **+ policy satisfied** → `$complete` (`workflow.completed`,
  `verified: true`).
- requested complete **+ missing/unmet evidence** → **`blocked`** with reason
  `verification_required` (and the `missing` list). The workspace lease is retained.
- **conflicting evidence** (the system contradicts the completion claim) → **fail
  closed**: an authoritative task status ≠ `completed`, a non-zero process exit, or
  provider evidence that tests **failed** → `workflow.failed` with a stable reason.

The completion event is emitted **exactly once** (idempotent terminalization).

## Not in this layer

No generic shell verifier, no inference of test success from prose or repository
changes, no no-progress detection, no compiler, no UI.
