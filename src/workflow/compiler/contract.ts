/**
 * Natural-language Workflow Compiler — PURE contract types + strict result parsing.
 *
 * The compiler LLM is NEVER authoritative: it proposes exactly one bounded JSON
 * object (its AgentTaskResult final_output), which trusted code then re-parses,
 * re-validates, canonicalizes, and previews. Misleading JSON in intermediate task
 * events is ignored — only the AgentTaskResult controls the result.
 */

export const COMPILER_RESULT_SCHEMA_VERSION = '1'
export type CompilerStatus = 'ready' | 'needs_input' | 'impossible' | 'policy_denied'
export const COMPILER_STATUSES: readonly CompilerStatus[] = ['ready', 'needs_input', 'impossible', 'policy_denied']

/** The compiler LLM's REQUIRED single JSON object (nothing else). */
export interface CompilerResultV1 {
  schema_version: '1'
  status: CompilerStatus
  workflow_spec: Record<string, unknown>
  input_values: Record<string, unknown>
  rationale: Record<string, unknown>
  questions: string[]
  warnings: string[]
}

const KNOWN_RESULT_FIELDS = ['schema_version', 'status', 'workflow_spec', 'input_values', 'rationale', 'questions', 'warnings']
const MAX_LIST = 50
const MAX_STR = 4096
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

export type ParseResult =
  | { ok: true; value: CompilerResultV1 }
  | { ok: false; code: 'not_json' | 'not_object' | 'unknown_field' | 'bad_schema_version' | 'bad_status' | 'bad_shape'; message: string }

/**
 * STRICT parse of the compiler's authoritative output text: exactly one JSON object,
 * no trailing prose, no heuristic extraction, no repair. Unknown fields are rejected.
 * NEVER echoes the raw text (which may contain the request/prompt) in the message.
 */
export function parseCompilerResult(text: string): ParseResult {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '' || (trimmed[0] !== '{')) return { ok: false, code: 'not_json', message: 'compiler output must be exactly one JSON object' }
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return { ok: false, code: 'not_json', message: 'compiler output is not valid JSON (no trailing prose / repair)' } }
  if (!isObj(parsed)) return { ok: false, code: 'not_object', message: 'compiler output must be a JSON object' }
  for (const k of Object.keys(parsed)) if (!KNOWN_RESULT_FIELDS.includes(k)) return { ok: false, code: 'unknown_field', message: `unknown compiler-result field: ${k}` }
  if (parsed.schema_version !== COMPILER_RESULT_SCHEMA_VERSION) return { ok: false, code: 'bad_schema_version', message: 'unsupported compiler-result schema_version' }
  if (typeof parsed.status !== 'string' || !COMPILER_STATUSES.includes(parsed.status as CompilerStatus)) return { ok: false, code: 'bad_status', message: 'invalid compiler-result status' }
  const spec = parsed.workflow_spec ?? {}
  const inputs = parsed.input_values ?? {}
  const rationale = parsed.rationale ?? {}
  const questions = parsed.questions ?? []
  const warnings = parsed.warnings ?? []
  if (!isObj(spec) || !isObj(inputs) || !isObj(rationale)) return { ok: false, code: 'bad_shape', message: 'workflow_spec/input_values/rationale must be objects' }
  if (!isStrList(questions) || !isStrList(warnings)) return { ok: false, code: 'bad_shape', message: 'questions/warnings must be bounded string arrays' }
  return { ok: true, value: { schema_version: '1', status: parsed.status as CompilerStatus, workflow_spec: spec, input_values: inputs, rationale, questions: questions.slice(0, MAX_LIST), warnings: warnings.slice(0, MAX_LIST) } }
}

function isStrList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= MAX_LIST && v.every((s) => typeof s === 'string' && s.length <= MAX_STR)
}
