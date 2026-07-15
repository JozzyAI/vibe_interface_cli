/**
 * Deterministic, PURE prompt / workspace-key rendering for the Workflow Runtime.
 *
 * Renders ONLY the four already-validated `{{ … }}` namespaces:
 *   inputs.<name>, steps.<step_id>.output.<field>, workflow.round,
 *   context.(latest_planner_decision|latest_executor_handoff).<field>.
 *
 * There is NO JavaScript evaluation, NO function calls, NO dynamic property
 * lookup, and NO arbitrary context paths — the static validator already rejects
 * anything else, and this renderer rejects it again at runtime. Rendered size is
 * bounded before task creation. No prompt content is ever logged.
 */
import { parseTemplateReferences, type TemplateRef } from './validator.js'
import type { ContextGroup } from './contract.js'

export const MAX_RENDERED_PROMPT_BYTES = 64 * 1024

export interface RenderScope {
  /** Normalized, validated input values (required inputs guaranteed present). */
  inputs: Record<string, unknown>
  /** step_id → that step's VALIDATED output (only dominators are referenced). */
  stepOutputs: Record<string, Record<string, unknown>>
  round: number
  context: Partial<Record<ContextGroup, Record<string, unknown>>>
}

export type RenderResult =
  | { ok: true; text: string }
  | { ok: false; code: 'render_missing_value' | 'render_too_large' | 'render_bad_reference'; message: string }

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

/** Deterministic scalar/array rendering: strings as text; numbers/booleans via
 *  String(); arrays as canonical JSON (stable, readable). */
function renderValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return JSON.stringify(v)
  if (v === null || v === undefined) return ''
  return JSON.stringify(v)
}

/** Resolve one reference. `undefined` return = value genuinely absent. */
function resolveRef(ref: TemplateRef, scope: RenderScope): { value: unknown; required: boolean } {
  switch (ref.kind) {
    case 'input':
      // A referenced input MUST have been supplied (required inputs always are;
      // an optional input referenced by a prompt must also be present).
      return { value: scope.inputs[ref.name], required: true }
    case 'workflow':
      return { value: scope.round, required: true }
    case 'step_output': {
      const out = scope.stepOutputs[ref.step]
      if (out === undefined) return { value: undefined, required: true } // dominator output must exist
      return { value: out[ref.field], required: false } // optional output field → empty when absent
    }
    case 'context': {
      const group = scope.context[ref.group as ContextGroup]
      return { value: group ? group[ref.field] : undefined, required: false } // best-effort latest handoff
    }
  }
}

/** Render a prompt template against a scope. Bounded; never logs content. */
export function renderPrompt(template: string, scope: RenderScope, maxBytes: number = MAX_RENDERED_PROMPT_BYTES): RenderResult {
  const parsed = parseTemplateReferences(template)
  if (parsed.errors.length) return { ok: false, code: 'render_bad_reference', message: `template has unsupported references (${parsed.errors[0]})` }
  let out = template
  for (const ref of parsed.refs) {
    const { value, required } = resolveRef(ref, scope)
    if (value === undefined && required) {
      return { ok: false, code: 'render_missing_value', message: `missing required runtime value for ${ref.raw}` }
    }
    out = out.split(ref.raw).join(renderValue(value))
  }
  if (byteLen(out) > maxBytes) return { ok: false, code: 'render_too_large', message: 'rendered prompt exceeds the size limit' }
  return { ok: true, text: out }
}

export type WorkspaceKeyResult =
  | { ok: true; workspaceKey: string | undefined }
  | { ok: false; code: 'render_missing_value' | 'render_bad_reference'; message: string }

const WORKSPACE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Render a workspace_key_template using the contract semantics: a safe literal
 * key, OR exactly one `{{ inputs.<name> }}` reference. An omitted optional input
 * value means NO explicit workspace key (the runtime lets the backend pick one).
 */
export function renderWorkspaceKey(template: string | undefined, scope: RenderScope): WorkspaceKeyResult {
  if (template === undefined) return { ok: true, workspaceKey: undefined }
  if (!template.includes('{{')) {
    if (!WORKSPACE_KEY_RE.test(template)) return { ok: false, code: 'render_bad_reference', message: 'workspace_key literal is not a safe opaque key' }
    return { ok: true, workspaceKey: template }
  }
  const parsed = parseTemplateReferences(template)
  const single = parsed.errors.length === 0 && parsed.refs.length === 1 && parsed.refs[0].kind === 'input' && template.trim() === parsed.refs[0].raw
  if (!single) return { ok: false, code: 'render_bad_reference', message: 'workspace_key_template must be exactly one {{ inputs.<name> }} reference' }
  const name = (parsed.refs[0] as { name: string }).name
  const v = scope.inputs[name]
  if (v === undefined || v === '') return { ok: true, workspaceKey: undefined } // omitted optional → no explicit key
  if (typeof v !== 'string' || !WORKSPACE_KEY_RE.test(v)) return { ok: false, code: 'render_bad_reference', message: 'workspace_key input value is not a safe opaque key' }
  return { ok: true, workspaceKey: v }
}
