/**
 * Declarative Workflow contract (v1) — pure validator/types tests. No runtime,
 * no I/O, no agents. Exercises the example loop plus every rejection path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkflowSpec, parseTemplateReferences, type ValidationResult } from '../src/workflow/validator.js'
import { plannerExecutorLoopExample } from '../src/workflow/examples.js'
import {
  compileResultRequiresApproval, isTerminalWorkflowStatus, isTerminalStepStatus, terminalTargetToStatus,
  canTakeLoopEdge, WORKFLOW_ROUND_START, isStepScopedEvent,
  type WorkflowSpec, type WorkflowCompileResult, type WorkflowStepExecutionRef, type WorkflowEvent,
} from '../src/workflow/contract.js'
import { evaluateCondition } from '../src/workflow/conditions.js'

/** Minimal branching spec: a → (x)b / (y)c → d → terminals. Used for dominance. */
function branchingSpec(dPrompt: string): WorkflowSpec {
  return {
    version: '1', name: 'branch', entry_step: 'a',
    agents: { r: { agent: 'mock' } },
    output_schemas: { dec: { fields: { status: { type: 'enum', required: true, enum: ['x', 'y'] }, summary: { type: 'string' } } } },
    limits: { max_tasks: 10, max_runtime_seconds: 60, max_step_attempts: 2, max_failures: 2 },
    steps: [
      { id: 'a', type: 'agent_task', agent_role: 'r', output_schema: 'dec', prompt_template: 'a' },
      { id: 'b', type: 'agent_task', agent_role: 'r', output_schema: 'dec', prompt_template: 'b' },
      { id: 'c', type: 'agent_task', agent_role: 'r', output_schema: 'dec', prompt_template: 'c' },
      { id: 'd', type: 'agent_task', agent_role: 'r', output_schema: 'dec', prompt_template: dPrompt },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'x' } },
      { from: 'a', to: 'c', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'y' } },
      { from: 'b', to: 'd', kind: 'normal' },
      { from: 'c', to: 'd', kind: 'normal' },
      { from: 'd', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'x' } },
      { from: 'd', to: '$failed', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'y' } },
    ],
  }
}

const clone = (): WorkflowSpec => JSON.parse(JSON.stringify(plannerExecutorLoopExample())) as WorkflowSpec
const hasError = (r: ValidationResult, code: string): boolean => r.issues.some((i) => i.severity === 'error' && i.code === code)
const codes = (r: ValidationResult): string[] => r.issues.filter((i) => i.severity === 'error').map((i) => i.code)

// ── happy paths ───────────────────────────────────────────────────────────────

test('valid planner/executor loop passes with no errors', () => {
  const r = validateWorkflowSpec(plannerExecutorLoopExample())
  assert.equal(r.valid, true, `unexpected errors: ${JSON.stringify(codes(r))}`)
  assert.equal(r.issues.filter((i) => i.severity === 'error').length, 0)
})

test('example is JSON round-trip stable', () => {
  const ex = plannerExecutorLoopExample()
  assert.deepEqual(JSON.parse(JSON.stringify(ex)), ex)
})

test('explicit loop is accepted with max_rounds (no loop error)', () => {
  const r = validateWorkflowSpec(plannerExecutorLoopExample())
  assert.ok(!hasError(r, 'loop_requires_max_rounds'))
  assert.ok(!hasError(r, 'unmarked_cycle'))
})

test('a graph with no loop edges is acyclic and valid', () => {
  const s = clone()
  s.edges = s.edges.filter((e) => e.kind !== 'loop') // drop the review→implement back-edge
  s.edges.push({ from: 'review', to: '$failed', kind: 'normal' }) // fallback covers the now-unrouted 'continue'
  delete s.limits.max_rounds                          // no longer required
  const r = validateWorkflowSpec(s)
  assert.equal(r.valid, true, JSON.stringify(codes(r)))
  assert.ok(!hasError(r, 'unmarked_cycle'))
})

test('valid terminal reachability (example routes to $complete/$blocked/$failed)', () => {
  assert.ok(!hasError(validateWorkflowSpec(plannerExecutorLoopExample()), 'no_terminal_reachable'))
})

// ── structural rejections ──────────────────────────────────────────────────────

test('duplicate step IDs rejected', () => {
  const s = clone(); s.steps[1].id = 'plan'
  assert.ok(hasError(validateWorkflowSpec(s), 'duplicate_step_id'))
})

test('missing/unknown entry step rejected', () => {
  const s = clone(); s.entry_step = 'does-not-exist'
  assert.ok(hasError(validateWorkflowSpec(s), 'unknown_entry_step'))
})

test('unknown agent role rejected', () => {
  const s = clone(); s.steps[0].agent_role = 'ghost'
  assert.ok(hasError(validateWorkflowSpec(s), 'unknown_agent_role'))
})

test('unknown output schema rejected', () => {
  const s = clone(); s.steps[0].output_schema = 'ghost'
  assert.ok(hasError(validateWorkflowSpec(s), 'unknown_output_schema'))
})

test('invalid edge target rejected', () => {
  const s = clone(); s.edges[0].to = 'ghost'
  assert.ok(hasError(validateWorkflowSpec(s), 'edge_bad_target'))
})

test('invalid edge source rejected', () => {
  const s = clone(); s.edges[0].from = 'ghost'
  assert.ok(hasError(validateWorkflowSpec(s), 'edge_bad_source'))
})

test('unreachable step rejected', () => {
  const s = clone()
  s.steps.push({ id: 'orphan', type: 'agent_task', agent_role: 'planner', output_schema: 'planner_decision', prompt_template: 'x' })
  assert.ok(hasError(validateWorkflowSpec(s), 'unreachable_step'))
})

test('unmarked cycle rejected', () => {
  const s = clone()
  const loop = s.edges.find((e) => e.kind === 'loop')!
  loop.kind = 'normal' // implement→review→implement now a non-loop cycle
  const r = validateWorkflowSpec(s)
  assert.ok(hasError(r, 'unmarked_cycle'), JSON.stringify(codes(r)))
})

test('loop without max_rounds rejected', () => {
  const s = clone(); delete s.limits.max_rounds
  assert.ok(hasError(validateWorkflowSpec(s), 'loop_requires_max_rounds'))
})

test('no terminal route rejected', () => {
  const s = clone()
  s.edges = s.edges.filter((e) => typeof e.to === 'string' && !e.to.startsWith('$'))
  assert.ok(hasError(validateWorkflowSpec(s), 'no_terminal_reachable'))
})

test('reserved terminal targets validated ($complete ok, $bogus rejected)', () => {
  assert.ok(!hasError(validateWorkflowSpec(plannerExecutorLoopExample()), 'edge_bad_target'))
  const s = clone(); s.edges[1].to = '$bogus' as unknown as '$complete'
  assert.ok(hasError(validateWorkflowSpec(s), 'edge_bad_target'))
})

// ── conditions ─────────────────────────────────────────────────────────────────

test('malformed condition rejected (missing op)', () => {
  const s = clone()
  ;(s.edges[0] as { condition?: unknown }).condition = { path: 'output.status' }
  assert.ok(hasError(validateWorkflowSpec(s), 'condition_unsupported_op'))
})

test('unsupported operator rejected', () => {
  const s = clone()
  ;(s.edges[0].condition as { op: string }).op = 'gt'
  assert.ok(hasError(validateWorkflowSpec(s), 'condition_unsupported_op'))
})

test('condition against unknown output field rejected', () => {
  const s = clone()
  ;(s.edges[0].condition as { path: string }).path = 'output.nonexistent'
  assert.ok(hasError(validateWorkflowSpec(s), 'condition_unknown_output_field'))
})

test('ambiguous unconditional outgoing edges rejected', () => {
  const s = clone()
  s.edges.push({ from: 'plan', to: '$complete', kind: 'normal' })
  s.edges.push({ from: 'plan', to: '$failed', kind: 'normal' })
  assert.ok(hasError(validateWorkflowSpec(s), 'ambiguous_unconditional_edges'))
})

test('duplicate equivalent edge rejected', () => {
  const s = clone(); s.edges.push(JSON.parse(JSON.stringify(s.edges[0])))
  assert.ok(hasError(validateWorkflowSpec(s), 'duplicate_edge'))
})

// ── templates ──────────────────────────────────────────────────────────────────

test('invalid template expression rejected (unbalanced + call-like)', () => {
  const s1 = clone(); s1.steps[0].prompt_template = 'hi {{ inputs.objective'
  assert.ok(hasError(validateWorkflowSpec(s1), 'template_malformed'))
  const s2 = clone(); s2.steps[0].prompt_template = 'x {{ evil() }}'
  assert.ok(hasError(validateWorkflowSpec(s2), 'template_unsupported_namespace'))
})

test('unknown input template reference rejected', () => {
  const s = clone(); s.steps[0].prompt_template = 'go {{ inputs.ghost }}'
  assert.ok(hasError(validateWorkflowSpec(s), 'template_unknown_input'))
})

test('unknown step / output-field template reference rejected', () => {
  const s1 = clone(); s1.steps[0].prompt_template = '{{ steps.ghost.output.summary }}'
  assert.ok(hasError(validateWorkflowSpec(s1), 'template_unknown_step'))
  const s2 = clone(); s2.steps[2].prompt_template = '{{ steps.implement.output.ghostfield }}'
  assert.ok(hasError(validateWorkflowSpec(s2), 'template_unknown_output_field'))
})

test('workspace_key_template only allows input references', () => {
  const s = clone(); s.steps[1].workspace_key_template = '{{ steps.plan.output.summary }}'
  assert.ok(hasError(validateWorkflowSpec(s), 'workspace_key_bad_reference'))
})

test('parseTemplateReferences: recognizes the three namespaces, preserves text', () => {
  const p = parseTemplateReferences('a {{ inputs.objective }} b {{ steps.plan.output.summary }} c {{ workflow.round }}')
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.refs.map((r) => r.kind), ['input', 'step_output', 'workflow'])
})

// ── limits ─────────────────────────────────────────────────────────────────────

test('zero / negative / excessive limits rejected', () => {
  const z = clone(); z.limits.max_tasks = 0
  assert.ok(hasError(validateWorkflowSpec(z), 'limit_invalid'))
  const n = clone(); n.limits.max_failures = -1
  assert.ok(hasError(validateWorkflowSpec(n), 'limit_invalid'))
  const x = clone(); x.limits.max_runtime_seconds = 9_999_999
  assert.ok(hasError(validateWorkflowSpec(x), 'limit_exceeds_max'))
})

test('missing required limit rejected', () => {
  const s = clone(); delete (s.limits as { max_tasks?: number }).max_tasks
  assert.ok(hasError(validateWorkflowSpec(s), 'limit_missing'))
})

// ── fail-closed + secrets ────────────────────────────────────────────────────────

test('unknown top-level field fails closed', () => {
  const s = clone() as WorkflowSpec & { extra?: number }; s.extra = 1
  assert.ok(hasError(validateWorkflowSpec(s), 'unknown_top_level_field'))
})

test('credential-like field names are rejected', () => {
  const s = clone() as WorkflowSpec & { api_token?: string }; s.api_token = 'anything'
  assert.ok(hasError(validateWorkflowSpec(s), 'secret_field_forbidden'))
})

test('the example serialization contains no credential-like field names', () => {
  const json = JSON.stringify(plannerExecutorLoopExample())
  for (const bad of ['token', 'secret', 'password', 'bearer', 'api_key', 'apikey', 'credential', 'private_key', 'encryption_key']) {
    assert.ok(!new RegExp(`"[^"]*${bad}[^"]*"\\s*:`, 'i').test(json), `unexpected credential-like key containing "${bad}"`)
  }
})

// ── issue shape + helpers + compiler contract ────────────────────────────────────

test('validation issues have a stable structured shape', () => {
  const s = clone(); s.entry_step = 'nope'
  const r = validateWorkflowSpec(s)
  assert.equal(r.valid, false)
  for (const i of r.issues) {
    assert.ok(i.severity === 'error' || i.severity === 'warning')
    assert.equal(typeof i.code, 'string')
    assert.equal(typeof i.message, 'string')
    if (i.path !== undefined) assert.equal(typeof i.path, 'string')
  }
})

test('terminal-state helpers + terminal-target mapping', () => {
  assert.equal(isTerminalWorkflowStatus('completed'), true)
  assert.equal(isTerminalWorkflowStatus('running'), false)
  assert.equal(isTerminalStepStatus('skipped'), true)
  assert.equal(isTerminalStepStatus('pending'), false)
  assert.equal(terminalTargetToStatus('$complete'), 'completed')
  assert.equal(terminalTargetToStatus('$blocked'), 'blocked')
  assert.equal(terminalTargetToStatus('$failed'), 'failed')
})

test('pure condition evaluation matches operators', () => {
  const scope = { output: { status: 'continue' }, workflow: { round: 2 } }
  assert.equal(evaluateCondition({ path: 'output.status', op: 'eq', value: 'continue' }, scope), true)
  assert.equal(evaluateCondition({ path: 'output.status', op: 'neq', value: 'complete' }, scope), true)
  assert.equal(evaluateCondition({ path: 'output.status', op: 'in', value: ['a', 'continue'] }, scope), true)
  assert.equal(evaluateCondition({ path: 'output.missing', op: 'exists' }, scope), false)
  assert.equal(evaluateCondition({ path: 'workflow.round', op: 'eq', value: 2 }, scope), true)
})

test('compile result must require approval', () => {
  const result: WorkflowCompileResult = {
    workflow_spec: plannerExecutorLoopExample(),
    assumptions: ['assumed two nodes'],
    warnings: [],
    requires_user_approval: true,
  }
  assert.equal(compileResultRequiresApproval(result), true)
  // and the compiled spec must itself pass the same validator
  assert.equal(validateWorkflowSpec(result.workflow_spec).valid, true)
})

// ── (1) context handoff namespace ────────────────────────────────────────────────

test('context.* namespace: valid fields parse; unknown context field rejected', () => {
  const p = parseTemplateReferences('{{ context.latest_planner_decision.next_step }} {{ context.latest_executor_handoff.changed_files }}')
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.refs.map((r) => r.kind), ['context', 'context'])
  const s = clone(); s.steps[1].prompt_template = '{{ context.latest_planner_decision.ghost }}'
  assert.ok(hasError(validateWorkflowSpec(s), 'template_unknown_context_field'))
})

test('context handoff loop: example implement/review use context.* and remain valid', () => {
  const ex = plannerExecutorLoopExample()
  assert.match(ex.steps[1].prompt_template, /context\.latest_planner_decision\.next_step/)   // implement reads newest planner instruction
  assert.match(ex.steps[2].prompt_template, /context\.latest_executor_handoff\.summary/)      // review reads latest executor handoff
  assert.equal(validateWorkflowSpec(ex).valid, true)
})

// ── (2) step-output availability (dominance) ──────────────────────────────────────

test('guaranteed predecessor (dominator) step-output ref is valid', () => {
  assert.equal(validateWorkflowSpec(branchingSpec('{{ steps.a.output.summary }}')).valid, true) // entry dominates all
})

test('self reference rejected', () => {
  const s = clone(); s.steps[0].prompt_template = '{{ steps.plan.output.summary }}'
  assert.ok(hasError(validateWorkflowSpec(s), 'template_self_reference'))
})

test('downstream reference rejected', () => {
  const s = clone(); s.steps[0].prompt_template = '{{ steps.review.output.summary }}' // plan referencing later review
  assert.ok(hasError(validateWorkflowSpec(s), 'template_step_not_guaranteed'))
})

test('predecessor on only one branch rejected (not a dominator)', () => {
  assert.ok(hasError(validateWorkflowSpec(branchingSpec('{{ steps.b.output.summary }}')), 'template_step_not_guaranteed'))
})

test('workspace_key_template: literal ok; string input ok; non-string input rejected', () => {
  const lit = clone(); lit.steps[1].workspace_key_template = 'safe.key-1'
  assert.ok(!hasError(validateWorkflowSpec(lit), 'bad_workspace_key'))
  assert.equal(validateWorkflowSpec(plannerExecutorLoopExample()).valid, true) // {{ inputs.workspace_key }} (string)
  const bad = clone()
  bad.inputs = { ...bad.inputs, count: { type: 'number' } }
  bad.steps[1].workspace_key_template = '{{ inputs.count }}'
  assert.ok(hasError(validateWorkflowSpec(bad), 'workspace_key_input_not_string'))
})

// ── (3) deterministic + exhaustive routing ────────────────────────────────────────

test('condition value must match the enum field (declared values only)', () => {
  const s = clone(); (s.edges[0].condition as { value: unknown }).value = 'bogus'
  assert.ok(hasError(validateWorkflowSpec(s), 'condition_value_not_in_enum'))
})

test('workflow.round comparisons require numeric values', () => {
  const s = clone()
  s.edges.push({ from: 'plan', to: '$failed', kind: 'normal', condition: { path: 'workflow.round', op: 'eq', value: 'two' } })
  assert.ok(hasError(validateWorkflowSpec(s), 'condition_round_needs_number'))
})

test('overlapping eq/in values across branches rejected', () => {
  const s = clone()
  ;(s.edges[1].condition as { value: unknown }).value = 'continue' // both edge0 and edge1 now match "continue"
  assert.ok(hasError(validateWorkflowSpec(s), 'routing_overlapping_values'))
})

test('mixed selectors across a multi-branch set rejected', () => {
  const s = clone()
  s.edges.push({ from: 'plan', to: '$failed', kind: 'normal', condition: { path: 'output.summary', op: 'eq', value: 'x' } })
  assert.ok(hasError(validateWorkflowSpec(s), 'routing_mixed_selectors'))
})

test('neq/exists in a multi-branch set is not provably disjoint', () => {
  const s = clone()
  ;(s.edges[0].condition as { op: string }).op = 'neq'
  assert.ok(hasError(validateWorkflowSpec(s), 'routing_not_provably_disjoint'))
})

test('required enum selector must route every outcome (or a fallback)', () => {
  const missing = clone()
  missing.edges = missing.edges.filter((e) => !(e.from === 'plan' && e.to === '$failed')) // drop the "failed" route
  assert.ok(hasError(validateWorkflowSpec(missing), 'enum_outcome_unrouted'))
  const withFallback = clone()
  withFallback.edges = withFallback.edges.filter((e) => !(e.from === 'plan' && e.to === '$failed'))
  withFallback.edges.push({ from: 'plan', to: '$failed', kind: 'normal' }) // unconditional fallback covers the remainder
  assert.ok(!hasError(validateWorkflowSpec(withFallback), 'enum_outcome_unrouted'))
})

// ── (4) round / retry accounting ──────────────────────────────────────────────────

test('round accounting: starts at 1; max_rounds includes the first iteration', () => {
  assert.equal(WORKFLOW_ROUND_START, 1)
  assert.equal(canTakeLoopEdge(1, 6), true)
  assert.equal(canTakeLoopEdge(5, 6), true)
  assert.equal(canTakeLoopEdge(6, 6), false) // max_rounds=6 → at most six rounds, not seven
  assert.equal(canTakeLoopEdge(1, 1), false)
})

// ── (5) stable step-execution identity ────────────────────────────────────────────

test('step-execution ref shape + step-scoped event classification', () => {
  const ref: WorkflowStepExecutionRef = { step_execution_id: 'se_1', step_id: 'implement', round: 2, attempt: 1 }
  assert.equal(ref.round > 0 && ref.attempt > 0, true)
  assert.equal(ref.task_id, undefined) // optional until task creation succeeds
  const ev: WorkflowEvent = { workflow_id: 'wf_1', seq: 1, ts: 't', type: 'step.started', step_execution: ref, payload: {}, contract_version: 1 }
  assert.equal(ev.step_execution?.step_execution_id, 'se_1')
  assert.equal(isStepScopedEvent('step.started'), true)
  assert.equal(isStepScopedEvent('step.completed'), true)
  assert.equal(isStepScopedEvent('workflow.started'), false)
  assert.equal(isStepScopedEvent('workflow.round_advanced'), false)
})

// ── (6) nested fail-closed ─────────────────────────────────────────────────────────

test('limits.budget must be exactly an empty object', () => {
  const empty = clone(); empty.limits.budget = {}
  assert.equal(validateWorkflowSpec(empty).valid, true)
  const nonEmpty = clone(); (nonEmpty.limits as { budget?: unknown }).budget = { tokens: 5 }
  assert.ok(hasError(validateWorkflowSpec(nonEmpty), 'budget_unknown_field'))
})

test('output schema fail-closed: only fields key, non-empty fields, enum only on enum type', () => {
  const extra = clone(); (extra.output_schemas.planner_decision as unknown as { note?: string }).note = 'x'
  assert.ok(hasError(validateWorkflowSpec(extra), 'schema_unknown_field'))
  const emptyFields = clone(); emptyFields.output_schemas.planner_decision.fields = {}
  assert.ok(hasError(validateWorkflowSpec(emptyFields), 'schema_no_fields'))
  const enumOnString = clone(); (enumOnString.output_schemas.planner_decision.fields.summary as { enum?: string[] }).enum = ['a']
  assert.ok(hasError(validateWorkflowSpec(enumOnString), 'enum_on_non_enum_field'))
})

test('enum values must be unique and non-empty', () => {
  const dup = clone(); dup.output_schemas.planner_decision.fields.status.enum = ['continue', 'continue']
  assert.ok(hasError(validateWorkflowSpec(dup), 'enum_duplicate_values'))
  const empty = clone(); empty.output_schemas.planner_decision.fields.status.enum = ['continue', '']
  assert.ok(hasError(validateWorkflowSpec(empty), 'enum_value_invalid'))
})

test('label and description must be strings when present', () => {
  const s = clone(); (s.steps[0] as { label?: unknown }).label = 5
  assert.ok(hasError(validateWorkflowSpec(s), 'bad_field_type'))
})

// ── (7) blocked semantics ──────────────────────────────────────────────────────────

test('blocked is resumable (not terminal); completed/failed/cancelled are terminal', () => {
  assert.equal(isTerminalWorkflowStatus('blocked'), false)
  assert.equal(isTerminalWorkflowStatus('completed'), true)
  assert.equal(isTerminalWorkflowStatus('failed'), true)
  assert.equal(isTerminalWorkflowStatus('cancelled'), true)
  assert.equal(terminalTargetToStatus('$blocked'), 'blocked')
})
