/**
 * Restricted, declarative edge conditions — PURE, no expression evaluation.
 *
 * A condition is structured data (`{ path, op, value }`), never a string like
 * `output.status == "continue"`. This module provides:
 *   - a pure shape checker used by the validator (`checkConditionShape`)
 *   - a pure evaluator over a bounded scope (`evaluateCondition`) that the future
 *     runtime can reuse — it reads only the SOURCE step's validated output and a
 *     small set of workflow values, and NEVER evaluates JavaScript.
 */
import type { Condition, ConditionOp } from './contract.js'
import { CONDITION_OPS } from './contract.js'

/** Supported condition path namespaces. `output.<field>` = the source step's
 *  validated output; `workflow.round` = the current loop round counter. */
const OUTPUT_PATH_RE = /^output\.([A-Za-z_][A-Za-z0-9_]*)$/
const WORKFLOW_PATH_RE = /^workflow\.(round)$/

export interface ParsedConditionPath {
  namespace: 'output' | 'workflow'
  /** For `output.<field>` this is the field name; for `workflow.round` it is `round`. */
  key: string
}

/** Parse a condition path into a namespaced reference, or `null` if unsupported. */
export function parseConditionPath(path: string): ParsedConditionPath | null {
  const o = OUTPUT_PATH_RE.exec(path)
  if (o) return { namespace: 'output', key: o[1] }
  const w = WORKFLOW_PATH_RE.exec(path)
  if (w) return { namespace: 'workflow', key: w[1] }
  return null
}

function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/**
 * Validate a condition's SHAPE (not its runtime truthiness). Returns a list of
 * stable issue codes (empty = well-formed). Never throws.
 */
export function checkConditionShape(cond: unknown): string[] {
  const issues: string[] = []
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return ['condition_not_object']
  const c = cond as Record<string, unknown>
  if (typeof c.path !== 'string' || !parseConditionPath(c.path)) issues.push('condition_bad_path')
  const op = c.op
  if (typeof op !== 'string' || !CONDITION_OPS.includes(op as ConditionOp)) {
    issues.push('condition_unsupported_op')
  } else {
    if (op === 'exists') {
      if (c.value !== undefined) issues.push('condition_exists_takes_no_value')
    } else if (op === 'in') {
      if (!Array.isArray(c.value) || c.value.length === 0 || !c.value.every(isScalar)) issues.push('condition_in_needs_scalar_array')
    } else { // eq / neq
      if (!isScalar(c.value)) issues.push('condition_needs_scalar_value')
    }
  }
  // Reject unknown keys (fail closed).
  for (const k of Object.keys(c)) if (!['path', 'op', 'value'].includes(k)) issues.push('condition_unknown_field')
  return issues
}

// ── pure evaluation (reusable by the future runtime; no side effects) ────────

export interface ConditionScope {
  /** The source step's validated output object. */
  output: Record<string, unknown>
  /** Bounded workflow values exposed to conditions. */
  workflow: { round: number }
}

/** Resolve a condition path against a scope. */
export function resolveConditionValue(path: string, scope: ConditionScope): { found: boolean; value: unknown } {
  const parsed = parseConditionPath(path)
  if (!parsed) return { found: false, value: undefined }
  if (parsed.namespace === 'workflow') return { found: true, value: scope.workflow.round }
  const has = Object.prototype.hasOwnProperty.call(scope.output, parsed.key)
  return { found: has, value: has ? scope.output[parsed.key] : undefined }
}

/**
 * Evaluate a well-formed condition against a scope. Total and pure; unsupported
 * paths/ops evaluate to `false` rather than throwing.
 */
export function evaluateCondition(cond: Condition, scope: ConditionScope): boolean {
  const { found, value } = resolveConditionValue(cond.path, scope)
  switch (cond.op) {
    case 'exists': return found && value !== undefined && value !== null
    case 'eq': return found && value === cond.value
    case 'neq': return !(found && value === cond.value)
    case 'in': return found && Array.isArray(cond.value) && (cond.value as unknown[]).includes(value)
    default: return false
  }
}
