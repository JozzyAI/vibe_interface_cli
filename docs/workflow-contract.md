# Vibe Workflow contract (v1)

A stable, **JSON-first** specification for a multi-agent workflow — for example a
Codex **planner** → Claude Code **executor** → Codex **review** loop. This
document describes the contract only; it is deliberately **not** a runtime.

> **Scope.** This is `WorkflowSpec` v1: types + a pure validator + a pure
> condition/template model + a validated example. There is **no** execution,
> persistence, HTTP/MCP surface, UI, LLM compiler, or JSON repair here. Those
> consume this contract later and stay independent of it. Module:
> [`src/workflow/`](../src/workflow) (`contract.ts`, `conditions.ts`,
> `validator.ts`, `examples.ts`). No workflow logic lives in `agent-gateway.ts`.

## Canonical representation

**JSON is canonical.** A `WorkflowSpec` is fully JSON-serializable: no functions,
classes, `RegExp`, or arbitrary expressions. YAML authoring is out of scope for
v1; a future YAML layer may convert to the same JSON contract.

## WorkflowSpec shape

```jsonc
{
  "version": "1",
  "name": "planner-executor-loop",      // safe id: ^[a-z0-9][a-z0-9_-]{0,63}$
  "description": "...",
  "entry_step": "plan",                   // must be a defined step id
  "inputs":  { "objective": { "type": "string", "required": true } },
  "agents":  { "planner": { "agent": "codex", "node_id": "node_planner" } },
  "output_schemas": { "planner_decision": { "fields": { /* ... */ } } },
  "limits":  { "max_rounds": 6, "max_tasks": 20, "max_runtime_seconds": 3600,
               "max_step_attempts": 3, "max_failures": 3 },
  "steps":   [ /* agent_task steps */ ],
  "edges":   [ /* conditional / loop edges */ ]
}
```

Unknown top-level fields **fail closed** (no forward-compat extension fields in
v1).

### Inputs

Named inputs with a tiny type set: `string`, `number`, `boolean`, `string[]`
(optional `required`, `description`, literal `default`). No nested schemas.

### Agent roles

Roles are named **separately** from step ids so multiple steps can share a role.
Each role is `{ agent, node_id?, description? }` — pure **data**, never a shell
command or CLI args. `node_id` may be omitted; the contract **preserves** that
routing ambiguity for the runtime to reject at execution time. Credentials are
never stored in a spec (credential-like field names are rejected anywhere).

### Steps (`agent_task` only)

v1 supports only `type: "agent_task"`:

| field | notes |
|-------|-------|
| `id` | safe id, unique |
| `agent_role` | references `agents` |
| `prompt_template` | text with `{{ … }}` references |
| `output_schema` | references `output_schemas` |
| `permission_mode?` | `default` \| `unsafe-skip` |
| `workspace_key_template?` | a safe opaque key **or** a single `{{ inputs.<name> }}` |
| `label?` / `description?` | human-readable |

No command / shell / HTTP / JavaScript / deploy / plugin steps. New kinds require
separate review.

### Prompt templates

A deliberately small reference syntax (validated, **not** rendered here). Four
bounded namespaces:

```
{{ inputs.<name> }}
{{ steps.<id>.output.<field> }}
{{ workflow.round }}
{{ context.latest_planner_decision.<field> }}     // status|summary|next_step|acceptance_criteria|open_questions
{{ context.latest_executor_handoff.<field> }}     // status|summary|changed_files|tests_run|remaining_work|risks
```

The validator identifies references, rejects malformed expressions, unsupported
namespaces, unbalanced braces, and (where statically determinable) references to
unknown inputs, unknown steps, unknown output fields, or unknown context fields.
It **never** evaluates JavaScript, permits function calls, or mutates anything;
surrounding plain text is preserved. Only the fixed `context.*` paths above are
allowed — never arbitrary context paths.

**`context.*` handoff namespace.** Backed by the `WorkflowContextBundle`, it
carries the **latest** structured handoffs across rounds. The **future runtime**
refreshes:

- `latest_planner_decision` after every successful **planner/review** step, and
- `latest_executor_handoff` after every successful **executor** step,

so a looped step reads the newest guidance (e.g. the implementer reads the
reviewer's most recent `next_step`). The **first** iteration must not depend on a
context value that has not yet been populated — in the example, the initial
`plan` populates `latest_planner_decision` before `implement` reads it, and
`implement` populates `latest_executor_handoff` before `review` reads it.

**`context_binding` (which slot a step updates).** An `agent_task` step may declare
an optional, fail-closed `context_binding` — `latest_planner_decision` or
`latest_executor_handoff` — naming which slot its **validated** output replaces on
success. The bound `output_schema` must be **structurally compatible** with the
destination shape (its fields ⊆ the slot's allowed fields, with required `status` +
`summary`). An **omitted** binding persists the step output (still referenceable via
`steps.<id>.output.*`) but updates neither slot. Binding is never inferred from role
names, step ids, or schema names, and an unknown value fails validation. The runtime
uses these bindings to refresh the `context.*` namespace deterministically.

### Step-output availability (dominance)

A `steps.<id>.output.<field>` reference must be **guaranteed** to be available
whenever the referencing step runs. Using the graph with **loop edges removed**,
the validator requires the referenced step to **dominate** the referencing step
(every path from `entry_step` to the referencing step passes through it), and so:

- rejects **self** references (`template_self_reference`);
- rejects **downstream/future** references;
- rejects a predecessor that exists on only **one branch** (not a dominator).

All three surface as `template_step_not_guaranteed` (except self-reference). For
cross-round "latest value" handoffs — where a strict dominator cannot be proven —
use the `context.*` namespace instead.

### workspace_key_template

Either a safe literal opaque key (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`) **or**
exactly one `{{ inputs.<name> }}` reference (no other text). The referenced input
**must be `type: "string"`** (`number`/`boolean`/`string[]` are rejected). An
omitted/optional workspace value means **no explicit workspace key** is supplied
(the runtime falls back to its default workspace behavior).

### Structured output schemas

Because routing depends on agent output, outputs are **structured**. Schemas are
a small, strongly-typed, JSON-serializable subset (`string` / `number` /
`boolean` / `string[]` / `enum`), not arbitrary validators. Built-in examples:

```jsonc
"planner_decision": { "fields": {
  "status": { "type": "enum", "enum": ["continue","complete","blocked","failed"], "required": true },
  "summary": { "type": "string", "required": true },
  "next_step": { "type": "string" },
  "acceptance_criteria": { "type": "string[]" },
  "open_questions": { "type": "string[]" }
}}

"executor_handoff": { "fields": {
  "status": { "type": "enum", "enum": ["implemented","blocked","failed"], "required": true },
  "summary": { "type": "string", "required": true },
  "changed_files": { "type": "string[]", "required": true },
  "tests_run": { "type": "string[]", "required": true },
  "remaining_work": { "type": "string[]", "required": true },
  "risks": { "type": "string[]", "required": true }
}}
```

The **future runtime** will: (1) request structured output, (2) validate it,
(3) optionally attempt a bounded repair, (4) fail the step if it stays invalid.
None of that output parsing/repair is implemented in this PR.

### Edges and conditions

Conditions are **structured**, never string expressions:

```jsonc
{ "path": "output.status", "op": "eq", "value": "continue" }
```

Operators: `eq`, `neq`, `exists`, `in`. A condition reads only the **source
step's validated output** (`output.<field>`) or a bounded workflow value
(`workflow.round`). Reserved terminal targets — **not** steps — are `$complete`,
`$failed`, `$blocked` (mapping to workflow status `completed` / `failed` /
`blocked`).

**Deterministic, exhaustive routing (v1 semantics).** When a step finishes, the
runtime evaluates its outgoing conditional edges and **exactly one** edge must be
selected; a single optional **unconditional** edge acts only as a **fallback**
when no condition matches. Zero matches without a fallback, or multiple matches,
is a routing failure. To make this **statically** decidable, the validator
requires:

- condition values match the referenced schema field **type**; `enum` conditions
  may use only **declared enum values**; `workflow.round` comparisons require
  **numeric** values;
- for multiple conditional edges from one step: **provable disjointness** — they
  must share **one** selector path and use only `eq`/`in` with **pairwise-disjoint**
  value sets (overlapping sets are rejected; `neq`/`exists` cannot be combined
  into an ambiguous multi-branch set);
- for a **required `enum`** selector: every enum value is routed **exactly once**
  or covered by the single fallback — unrouted outcomes are rejected.

Each edge is `{ from, to, condition?, kind }` where `kind` is `normal` or
`loop`. **Loop accounting:**

- every intentional back-edge must be `kind: "loop"`;
- taking a loop edge increments the workflow **round** counter;
- any spec with a loop edge must define a positive `max_rounds`;
- after removing loop edges the remaining graph must be **acyclic** — unmarked
  cycles are rejected.

### Limits

Explicit, bounded, positive integers (validated against conservative maxima so a
generated spec cannot request absurd values):

| limit | max |
|-------|-----|
| `max_rounds` (required iff loops) | 100 |
| `max_tasks` | 1000 |
| `max_runtime_seconds` | 86 400 |
| `max_step_attempts` | 20 |
| `max_failures` | 100 |

`limits.budget` is a **reserved** extension point for future token/cost budgets;
in v1 it must be **exactly an empty object** (any key is rejected) and no cost
enforcement exists yet.

**Round / task / retry / failure accounting** (contract semantics; no runtime
enforcement in this PR): `workflow.round` **starts at 1** and `max_rounds`
**includes the first iteration**, so `max_rounds: 6` permits at most **six**
rounds (not seven). A loop edge may be taken only while `round < max_rounds`, and
taking it **increments the round before** the destination step starts (the pure
`canTakeLoopEdge(round, maxRounds)` helper encodes this). `max_step_attempts` is
counted **per `(step_id, round)`**; `max_tasks` counts **every** created Agent
Task (including any future retry/repair tasks); `max_failures` counts failed step
attempts across the whole workflow; `max_runtime_seconds` is **elapsed** wall-clock
runtime and does **not** reset on resume.

### Runtime state + events (types only)

`WorkflowStatus` (`draft`/`ready`/`running`/`blocked`/`completed`/`failed`/
`cancelled`) and `StepStatus` (`pending`/`running`/`completed`/`failed`/
`skipped`/`cancelled`) are defined with pure terminal-state helpers.

**`blocked` is resumable and therefore NOT terminal** — only `completed`,
`failed`, and `cancelled` are terminal. Reaching `$blocked` emits
`workflow.blocked` and preserves resumable state; **resume semantics are deferred
to the runtime PR**.

**Stable step-execution identity.** A looping/retrying workflow cannot identify
an execution by `step_id` alone, so step-scoped events carry a
`WorkflowStepExecutionRef { step_execution_id, step_id, round, attempt, task_id? }`:
`round`/`attempt` are positive integers; `step_execution_id` is a stable opaque
id preserved across process restart; a **retry** receives a **new**
`step_execution_id` and a higher `attempt`; `task_id` is safe and stays absent
until Agent Task creation succeeds. (No id generation or persistence here.)

A minimal versioned `WorkflowEvent` envelope carries
`{ workflow_id, seq, ts, type, step_execution?, payload, contract_version }`.
**Step-scoped** events (`step.started`, `step.task_created`, `step.completed`,
`step.failed`) MUST carry `step_execution`; **workflow-scoped** events
(`workflow.created`, `workflow.validated`, `workflow.started`, `edge.selected`,
`workflow.round_advanced`, `workflow.blocked`, `workflow.completed`,
`workflow.failed`, `workflow.cancelled`) omit it. No event store or emitter is
implemented here.

### Context bundle

`WorkflowContextBundle` is a bounded, serializable handoff between planner and
executor: `objective`, `current_round`, `latest_planner_decision`,
`latest_executor_handoff`, `decisions`, `open_questions`, `verified_evidence`,
safe `prior_task_ids`, and bounded `history_summaries`. It must **never** carry
raw credentials, relay tokens, API bearer tokens, encryption keys, unrestricted
native-agent session histories, or backend PIDs. The **runtime** (not the agent)
is responsible for `verified_evidence` such as authoritative task status and
captured test events.

### Natural-language compiler contract (types only)

`WorkflowCompileRequest { natural_language_description, available_agents,
constraints? }` → `WorkflowCompileResult { workflow_spec, assumptions, warnings,
requires_user_approval: true }`. The result's `workflow_spec` must pass the same
validator, and `requires_user_approval` is the literal `true`. Required future
flow:

```
natural language → generated JSON → schema validation → policy validation
                 → visual/user preview → explicit approval → execution
```

Natural-language generation must **never** directly execute a workflow.

## Validation

`validateWorkflowSpec(spec): { valid, issues[] }` is pure — it returns structured
issues and never throws or exits. Each issue is
`{ severity: "error" | "warning", code, message, path? }` with no unsafe value
echo. It checks (at least): supported version; safe/unique name and ids; valid
entry step; unique step ids; valid agent-role/output-schema references; valid
edge sources/targets and reserved terminals; at least one reachable terminal
route; condition shape and unknown operators; unknown template references;
unmarked/illegal cycles; loops without `max_rounds`; unreachable steps; ambiguous
unconditional outgoing edges; duplicate equivalent edges; invalid/excessive
limits; credential-like field names; and unknown top-level fields (fail closed).

## Example — planner/executor loop

The built-in [`plannerExecutorLoopExample()`](../src/workflow/examples.ts)
(`node_id`s are placeholders; no credentials or native-session sharing):

```
              ┌───────────── loop while review status=continue (kind:"loop", ++round ≤ max_rounds) ─────────────┐
              │                                                                                                  │
  entry       ▼          writes                          writes                          updates                │
 ┌────────────────┐  context.latest_    ┌────────────────────┐  context.latest_   ┌────────────────┐  context.latest_
 │  plan (codex)  │  planner_decision   │ implement (claude) │  executor_handoff  │ review (codex) │  planner_decision
 │ planner_decision│ ─ status=continue ▶│  executor_handoff  │ ─ status=implemented▶│ planner_decision│ ──────────┘
 └───────┬────────┘   (implement reads  └─────────┬──────────┘   (review reads     └───────┬────────┘  (looped implement
         │             latest next_step            │             latest handoff)            │            gets newest instruction)
         │             + acceptance_criteria)      │                                        │
         │ complete → $complete                    │ blocked → $blocked                     │ complete → $complete
         │ blocked  → $blocked                     │ failed  → $failed                      │ blocked  → $blocked
         │ failed   → $failed                                                               │ failed   → $failed
         ▼                                                                                  ▼
   ($complete / $blocked / $failed)                                              ($complete / $blocked / $failed)
```

Codex decision → `context.latest_planner_decision` → Claude implementation →
`context.latest_executor_handoff` → Codex review → **updated**
`latest_planner_decision` → loop back to Claude with the newest instruction.

- `objective` (and optional string `workspace_key`) inputs.
- `planner` (Codex) and `executor` (Claude Code) roles on **distinct** nodes — no
  native-session sharing; handoffs flow only through structured `context.*`.
- `planner_decision` / `executor_handoff` schemas drive **exhaustive** routing.
- One explicit `kind: "loop"` back-edge (`review → implement`) with `max_rounds`.
- Terminal outcomes via `$complete` / `$blocked` / `$failed`.

## Out of scope (this PR)

Execution, persistence/SQLite, task recovery, LLM calls, natural-language
compilation, JSON repair, HTTP endpoints, MCP workflow tools, a dashboard, A2A,
approvals, artifacts/file transfer, shell/command steps, and multi-user auth.
