/**
 * Pure-unit tests for the Workflow Runtime building blocks: context_binding
 * validation, input-value normalization, prompt rendering, strict output parsing
 * + schema validation, and deterministic routing. No I/O, no store, no gateway.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkflowSpec } from '../src/workflow/validator.js'
import { plannerExecutorLoopExample } from '../src/workflow/examples.js'
import { normalizeInputValues } from '../src/workflow/input-values.js'
import { renderPrompt, renderWorkspaceKey } from '../src/workflow/prompt-renderer.js'
import { parseSingleJsonObject, extractAgentOutputText } from '../src/workflow/output-parser.js'
import { validateAgainstSchema } from '../src/workflow/output-validator.js'
import { selectEdge } from '../src/workflow/routing.js'
import type { WorkflowSpec, OutputSchema } from '../src/workflow/contract.js'

const errCodes = (r: { issues: Array<{ severity: string; code: string }> }) => r.issues.filter((i) => i.severity === 'error').map((i) => i.code)

// ── context_binding validation ────────────────────────────────────────────────

test('context_binding: the canonical example is valid and its bindings are structurally compatible', () => {
  const r = validateWorkflowSpec(plannerExecutorLoopExample())
  assert.equal(r.valid, true, JSON.stringify(errCodes(r)))
})

test('context_binding: unknown value fails validation', () => {
  const spec = plannerExecutorLoopExample() as any
  spec.steps[0].context_binding = 'not_a_group'
  const r = validateWorkflowSpec(spec)
  assert.ok(errCodes(r).includes('bad_context_binding'))
})

test('context_binding: schema not structurally compatible with the destination shape fails', () => {
  const spec = plannerExecutorLoopExample() as any
  // bind the executor step (executor_handoff schema) to the PLANNER slot → incompatible fields
  spec.steps[1].context_binding = 'latest_planner_decision'
  const r = validateWorkflowSpec(spec)
  assert.ok(errCodes(r).includes('context_binding_incompatible_schema'))
})

// ── input value normalization ─────────────────────────────────────────────────

const inSpec = (over: Record<string, unknown> = {}): WorkflowSpec => ({
  version: '1', name: 'w', entry_step: 's',
  inputs: { objective: { type: 'string', required: true }, count: { type: 'number', default: 3 }, flag: { type: 'boolean', required: false }, ...(over.inputs as object ?? {}) },
  agents: { r: { agent: 'mock' } }, output_schemas: { o: { fields: { status: { type: 'string', required: true } } } },
  limits: { max_tasks: 1, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
  steps: [{ id: 's', type: 'agent_task', agent_role: 'r', prompt_template: 'x', output_schema: 'o' }],
  edges: [{ from: 's', to: '$complete', kind: 'normal' }],
})

test('normalizeInputValues: applies defaults, enforces required, rejects unknown + type mismatch', () => {
  const ok = normalizeInputValues(inSpec(), { objective: 'do it' })
  assert.ok(ok.ok); if (ok.ok) { assert.equal(ok.values.objective, 'do it'); assert.equal(ok.values.count, 3) } // default applied
  assert.equal((normalizeInputValues(inSpec(), {}) as any).code, 'invalid_input_values') // missing required
  assert.equal((normalizeInputValues(inSpec(), { objective: 'x', nope: 1 }) as any).code, 'invalid_input_values') // unknown
  assert.equal((normalizeInputValues(inSpec(), { objective: 5 }) as any).code, 'invalid_input_values') // type mismatch
})

test('normalizeInputValues: rejects credential-like input names', () => {
  const spec = inSpec({ inputs: { objective: { type: 'string', required: true } } })
  const r = normalizeInputValues(spec, { objective: 'x', api_token: 'secret' })
  assert.equal(r.ok, false)
})

// ── prompt rendering ──────────────────────────────────────────────────────────

const scope = {
  inputs: { objective: 'ship it', n: 2 },
  stepOutputs: { plan: { summary: 'the plan', items: ['a', 'b'] } },
  round: 4,
  context: { latest_planner_decision: { next_step: 'do X', acceptance_criteria: ['c1', 'c2'] } },
}

test('renderPrompt: every namespace + arrays/numbers render deterministically', () => {
  const r = renderPrompt('O={{ inputs.objective }} N={{ inputs.n }} S={{ steps.plan.output.summary }} L={{ steps.plan.output.items }} R={{ workflow.round }} C={{ context.latest_planner_decision.next_step }} AC={{ context.latest_planner_decision.acceptance_criteria }}', scope)
  assert.ok(r.ok); if (r.ok) assert.equal(r.text, 'O=ship it N=2 S=the plan L=["a","b"] R=4 C=do X AC=["c1","c2"]')
})

test('renderPrompt: a missing required input value fails deterministically', () => {
  const r = renderPrompt('{{ inputs.missing }}', { ...scope, inputs: {} })
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, 'render_missing_value')
})

test('renderPrompt: enforces the rendered size limit', () => {
  const r = renderPrompt('{{ inputs.objective }}', { ...scope, inputs: { objective: 'x'.repeat(100) } }, 10)
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, 'render_too_large')
})

test('renderWorkspaceKey: literal, single input ref, and omitted-optional', () => {
  assert.deepEqual(renderWorkspaceKey('my-key.1', scope), { ok: true, workspaceKey: 'my-key.1' })
  assert.deepEqual(renderWorkspaceKey('{{ inputs.objective }}', { ...scope, inputs: { objective: 'wskey' } }), { ok: true, workspaceKey: 'wskey' })
  assert.deepEqual(renderWorkspaceKey('{{ inputs.objective }}', { ...scope, inputs: {} }), { ok: true, workspaceKey: undefined }) // omitted optional
  assert.equal((renderWorkspaceKey('has space', scope) as any).ok, false)
})

// ── strict output parsing + validation ────────────────────────────────────────

test('parseSingleJsonObject: accepts a bare object and a single ```json fence; rejects prose/array/multiple', () => {
  assert.deepEqual(parseSingleJsonObject('{"a":1}'), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseSingleJsonObject('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } })
  assert.equal((parseSingleJsonObject('here is json {"a":1}') as any).ok, false) // prose + json
  assert.equal((parseSingleJsonObject('{"a":1} trailing') as any).ok, false)     // trailing prose
  assert.equal((parseSingleJsonObject('[1,2]') as any).ok, false)                // array
  assert.equal((parseSingleJsonObject('{"a":1}{"b":2}') as any).ok, false)       // multiple
  assert.equal((parseSingleJsonObject('   ') as any).code, 'output_empty')
})

const schema: OutputSchema = { fields: { status: { type: 'enum', required: true, enum: ['a', 'b'] }, summary: { type: 'string', required: true }, tags: { type: 'string[]', required: false } } }

test('validateAgainstSchema: enforces required/type/enum and rejects unknown fields + oversize', () => {
  assert.ok(validateAgainstSchema({ status: 'a', summary: 's' }, schema).ok)
  assert.equal((validateAgainstSchema({ status: 'a' }, schema) as any).code, 'output_missing_required')
  assert.equal((validateAgainstSchema({ status: 'z', summary: 's' }, schema) as any).code, 'output_enum_invalid')
  assert.equal((validateAgainstSchema({ status: 'a', summary: 5 }, schema) as any).code, 'output_type_mismatch')
  assert.equal((validateAgainstSchema({ status: 'a', summary: 's', extra: 1 }, schema) as any).code, 'output_unknown_field')
  assert.equal((validateAgainstSchema({ status: 'a', summary: 'x'.repeat(20000) }, schema) as any).code, 'output_string_too_long')
})

test('extractAgentOutputText: concatenates stdout deltas in order and ignores stderr/comments', () => {
  const events = [
    { type: 'agent.output.delta', payload: { stream: 'stderr', text: 'LOG noise' } },
    { type: 'agent.output.delta', payload: { stream: 'stdout', text: '{"a":' } },
    { type: 'agent.output.delta', payload: { stream: 'stdout', text: '1}' } },
    { type: 'task.completed', payload: {} },
  ]
  assert.equal(extractAgentOutputText(events).text, '{"a":1}')
})

// ── routing ───────────────────────────────────────────────────────────────────

test('selectEdge: single match, no-edge, and ambiguous', () => {
  const spec = plannerExecutorLoopExample()
  const cont = selectEdge(spec, 'plan', { status: 'continue' }, 1)
  assert.ok(cont.ok); if (cont.ok) assert.deepEqual(cont.decision, { kind: 'step', target: 'implement', edgeKind: 'normal' })
  const comp = selectEdge(spec, 'review', { status: 'complete' }, 2)
  assert.ok(comp.ok); if (comp.ok) assert.equal(comp.decision.target, '$complete')
  const loop = selectEdge(spec, 'review', { status: 'continue' }, 1)
  assert.ok(loop.ok); if (loop.ok) assert.equal(loop.decision.edgeKind, 'loop')
  // no matching edge (an out-of-enum value routes nowhere)
  assert.equal((selectEdge(spec, 'plan', { status: 'weird' }, 1) as any).code, 'routing_no_edge')
  // ambiguous: a hand-built spec with two matching conditional edges
  const amb = { edges: [{ from: 's', to: 'a', kind: 'normal', condition: { path: 'output.x', op: 'exists' } }, { from: 's', to: 'b', kind: 'normal', condition: { path: 'output.x', op: 'exists' } }] } as unknown as WorkflowSpec
  assert.equal((selectEdge(amb, 's', { x: 1 }, 1) as any).code, 'routing_ambiguous')
})
