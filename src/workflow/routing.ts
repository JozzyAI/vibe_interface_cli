/**
 * Deterministic runtime edge selection for the Workflow Runtime — PURE.
 *
 * After a step completes with VALIDATED output, exactly one outgoing edge must be
 * selected. Conditions are evaluated with the same restricted evaluator the
 * validator uses (no JavaScript). An unconditional edge is a fallback only. Zero
 * or multiple matches is a structured routing failure (never a silent choice).
 */
import type { WorkflowSpec, WorkflowEdge, TerminalTarget } from './contract.js'
import { isTerminalTarget } from './contract.js'
import { evaluateCondition } from './conditions.js'

export interface RoutingDecision {
  /** `step` = a normal/loop step target; `terminal` = a reserved $target. */
  kind: 'step' | 'terminal'
  target: string | TerminalTarget
  edgeKind: 'normal' | 'loop'
}

export type RoutingResult =
  | { ok: true; decision: RoutingDecision }
  | { ok: false; code: 'routing_no_edge' | 'routing_ambiguous'; message: string }

/**
 * Select the single outgoing edge for `fromStepId` given the source step's
 * validated `output` and the current `round`. A matching conditional edge wins;
 * with no conditional match, a single unconditional fallback is taken. Zero
 * matches → `routing_no_edge`; more than one conditional match (or >1 fallback)
 * → `routing_ambiguous`.
 */
export function selectEdge(spec: WorkflowSpec, fromStepId: string, output: Record<string, unknown>, round: number): RoutingResult {
  const outgoing = spec.edges.filter((e) => e.from === fromStepId)
  const scope = { output, workflow: { round } }
  const matchedConditional = outgoing.filter((e) => e.condition !== undefined && evaluateCondition(e.condition, scope))
  const fallbacks = outgoing.filter((e) => e.condition === undefined)

  if (matchedConditional.length > 1) return { ok: false, code: 'routing_ambiguous', message: `step "${fromStepId}" matched ${matchedConditional.length} conditional edges` }
  let chosen: WorkflowEdge | undefined
  if (matchedConditional.length === 1) chosen = matchedConditional[0]
  else if (fallbacks.length === 1) chosen = fallbacks[0]
  else if (fallbacks.length > 1) return { ok: false, code: 'routing_ambiguous', message: `step "${fromStepId}" has ${fallbacks.length} unconditional fallback edges` }

  if (!chosen) return { ok: false, code: 'routing_no_edge', message: `step "${fromStepId}" has no matching outgoing edge` }
  const target = chosen.to
  return { ok: true, decision: { kind: isTerminalTarget(target) ? 'terminal' : 'step', target, edgeKind: chosen.kind } }
}
