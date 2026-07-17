/**
 * Pure validator for {@link WorkflowSpec}. Returns STRUCTURED issues; it never
 * throws, never exits the process, and performs NO I/O and NO evaluation. It is
 * the single gate every spec (hand-written or compiler-generated) must pass.
 *
 * Also exports a pure `{{ … }}` template-reference parser used for validation
 * (NOT prompt rendering — the runtime renders later).
 */
import {
  KNOWN_SPEC_FIELDS, LIMIT_MAXIMA, SAFE_ID_RE, NODE_ID_RE, TERMINAL_TARGETS,
  MAX_ENUM_VALUES, MAX_ENUM_VALUE_LENGTH, CONTEXT_FIELDS, CONTEXT_GROUPS, EVIDENCE_TYPES, STALL_SIGNALS,
  isTerminalTarget,
  type ContextGroup, type WorkflowInputType, type SchemaFieldType, type EvidenceType, type StallSignal,
} from './contract.js'
import { checkConditionShape, parseConditionPath } from './conditions.js'

export interface ValidationIssue {
  severity: 'error' | 'warning'
  /** Stable machine code (e.g. `duplicate_step_id`). */
  code: string
  message: string
  /** JSON-pointer-ish location, when applicable. */
  path?: string
}

export interface ValidationResult {
  /** True when there are no `error`-severity issues. */
  valid: boolean
  issues: ValidationIssue[]
}

// ── template reference parser (pure; for validation only) ────────────────────

export type TemplateRef =
  | { kind: 'input'; name: string; raw: string }
  | { kind: 'step_output'; step: string; field: string; raw: string }
  | { kind: 'workflow'; key: 'round'; raw: string }
  | { kind: 'context'; group: ContextGroup; field: string; raw: string }
  | { kind: 'pause'; raw: string }   // pause.response — THIS step's answered input pause

export interface TemplateParse {
  refs: TemplateRef[]
  /** Stable issue codes for malformed/unsupported references. */
  errors: string[]
}

const TPL_INPUT_RE = /^inputs\.([A-Za-z_][A-Za-z0-9_]*)$/
const TPL_STEP_RE = /^steps\.([a-z0-9][a-z0-9_-]*)\.output\.([A-Za-z_][A-Za-z0-9_]*)$/
const TPL_WORKFLOW_RE = /^workflow\.round$/
const TPL_CONTEXT_RE = /^context\.(latest_planner_decision|latest_executor_handoff)\.([A-Za-z_][A-Za-z0-9_]*)$/
const TPL_PAUSE_RE = /^pause\.response$/
const KNOWN_TEMPLATE_NAMESPACES = ['inputs', 'steps', 'workflow', 'context', 'pause']

/**
 * Parse `{{ … }}` references from text. Recognizes ONLY `inputs.<name>`,
 * `steps.<id>.output.<field>`, `workflow.round`, and
 * `context.(latest_planner_decision|latest_executor_handoff).<field>`.
 * Surrounding plain text is ignored/preserved. Never evaluates anything; rejects
 * function calls, operators, quotes, unknown namespaces, and unbalanced braces.
 */
export function parseTemplateReferences(text: string): TemplateParse {
  const refs: TemplateRef[] = []
  const errors: string[] = []
  const opens = (text.match(/\{\{/g) ?? []).length
  const closes = (text.match(/\}\}/g) ?? []).length
  if (opens !== closes) errors.push('template_malformed')

  const re = /\{\{([\s\S]*?)\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim()
    const raw = m[0]
    if (inner === '') { errors.push('template_malformed'); continue }
    let mm: RegExpExecArray | null
    if ((mm = TPL_INPUT_RE.exec(inner))) { refs.push({ kind: 'input', name: mm[1], raw }); continue }
    if ((mm = TPL_STEP_RE.exec(inner))) { refs.push({ kind: 'step_output', step: mm[1], field: mm[2], raw }); continue }
    if (TPL_WORKFLOW_RE.test(inner)) { refs.push({ kind: 'workflow', key: 'round', raw }); continue }
    if ((mm = TPL_CONTEXT_RE.exec(inner))) { refs.push({ kind: 'context', group: mm[1] as ContextGroup, field: mm[2], raw }); continue }
    if (TPL_PAUSE_RE.test(inner)) { refs.push({ kind: 'pause', raw }); continue }
    const ns = inner.split('.')[0]
    errors.push(KNOWN_TEMPLATE_NAMESPACES.includes(ns) ? 'template_bad_reference' : 'template_unsupported_namespace')
  }
  return { refs, errors }
}

// ── small guards ─────────────────────────────────────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isStr = (x: unknown): x is string => typeof x === 'string'
const isPosInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0
const WORKSPACE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const SECRET_TOKENS = ['token', 'secret', 'password', 'passwd', 'apikey', 'bearer', 'credential', 'privatekey', 'encryptionkey', 'accesskey', 'signingkey']
function isSecretKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SECRET_TOKENS.some((t) => norm.includes(t))
}

function matchesInputType(v: unknown, t: WorkflowInputType): boolean {
  switch (t) {
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'string[]': return Array.isArray(v) && v.every((x) => typeof x === 'string')
  }
}

type Err = (code: string, message: string, path?: string) => void
interface FieldDef { type: SchemaFieldType; enum?: string[]; required?: boolean }

// ── the validator ─────────────────────────────────────────────────────────────

export function validateWorkflowSpec(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  const err: Err = (code, message, path) => issues.push({ severity: 'error', code, message, path })
  const done = (): ValidationResult => ({ valid: !issues.some((i) => i.severity === 'error'), issues })

  if (!isObj(input)) { err('not_an_object', 'workflow spec must be a JSON object'); return done() }
  const spec = input

  scanSecretFields(spec, '', err)
  for (const k of Object.keys(spec)) if (!KNOWN_SPEC_FIELDS.includes(k)) err('unknown_top_level_field', `unknown top-level field: ${k}`, `/${k}`)

  if (spec.version !== '1') err('unsupported_version', 'unsupported workflow version (expected "1")', '/version')
  if (!isStr(spec.name) || !SAFE_ID_RE.test(spec.name)) err('bad_workflow_name', 'name must be a safe identifier ^[a-z0-9][a-z0-9_-]{0,63}$', '/name')
  if (spec.description !== undefined && !isStr(spec.description)) err('bad_field_type', 'description must be a string', '/description')

  const agentRoles = validateAgents(spec.agents, err)
  const inputTypes = validateInputs(spec.inputs, err)
  const { schemaNames, schemaFields, schemaFieldDefs } = validateOutputSchemas(spec.output_schemas, err)
  const { stepIds, stepOutputSchema } = validateSteps(spec.steps, agentRoles, schemaNames, schemaFieldDefs, err)

  if (!isStr(spec.entry_step) || !stepIds.has(spec.entry_step)) err('unknown_entry_step', 'entry_step must reference an existing step id', '/entry_step')

  const hasLoopEdge = Array.isArray(spec.edges) && spec.edges.some((e) => isObj(e) && e.kind === 'loop')
  validateLimits(spec.limits, hasLoopEdge, err)
  if (spec.completion_policy !== undefined) validateCompletionPolicy(spec.completion_policy, err)
  if (spec.stall_policy !== undefined) validateStallPolicy(spec.stall_policy, hasLoopEdge, err)

  const graph = validateEdges(spec, stepIds, stepOutputSchema, schemaFields, err)
  const entry = isStr(spec.entry_step) && stepIds.has(spec.entry_step) ? spec.entry_step : undefined
  const { reachable, doms } = analyzeGraph(spec, stepIds, entry, graph, err)

  // template references (needs stepIds/schemas + dominators for step-output refs).
  validateTemplates(spec.steps, inputTypes, stepIds, stepOutputSchema, schemaFields, reachable, doms, err)

  // deterministic + exhaustive routing (needs schema field defs + edges).
  validateRouting(graph.outgoing, stepOutputSchema, schemaFieldDefs, err)

  return done()
}

// ── completion policy ─────────────────────────────────────────────────────────

function validateCompletionPolicy(cp: unknown, err: Err): void {
  const p = '/completion_policy'
  if (!isObj(cp)) { err('bad_completion_policy', 'completion_policy must be an object', p); return }
  if (cp.required_evidence !== undefined) {
    if (!Array.isArray(cp.required_evidence) || cp.required_evidence.length > EVIDENCE_TYPES.length) err('bad_required_evidence', `required_evidence must be an array of at most ${EVIDENCE_TYPES.length} evidence types`, `${p}/required_evidence`)
    else for (const e of cp.required_evidence) if (!EVIDENCE_TYPES.includes(e as EvidenceType)) err('bad_evidence_type', `unknown evidence type: ${String(e)} (allowed: ${EVIDENCE_TYPES.join(', ')})`, `${p}/required_evidence`)
  }
  for (const k of ['require_repository_change', 'require_no_remaining_work', 'require_tests_passed']) {
    if (cp[k] !== undefined && typeof cp[k] !== 'boolean') err('bad_completion_flag', `completion_policy.${k} must be a boolean`, `${p}/${k}`)
  }
  for (const k of Object.keys(cp)) if (!['required_evidence', 'require_repository_change', 'require_no_remaining_work', 'require_tests_passed'].includes(k)) err('completion_policy_unknown_field', `unknown completion_policy field: ${k}`, `${p}/${k}`)
}

const MAX_STALLED_ROUNDS = 100
function validateStallPolicy(sp: unknown, hasLoopEdge: boolean, err: Err): void {
  const p = '/stall_policy'
  if (!isObj(sp)) { err('bad_stall_policy', 'stall_policy must be an object', p); return }
  if (!hasLoopEdge) err('stall_policy_without_loop', 'stall_policy is only meaningful with a loop edge', p)
  if (!isPosInt(sp.max_stalled_rounds) || (sp.max_stalled_rounds as number) > MAX_STALLED_ROUNDS) err('bad_max_stalled_rounds', `max_stalled_rounds must be a positive integer ≤ ${MAX_STALLED_ROUNDS}`, `${p}/max_stalled_rounds`)
  if (!Array.isArray(sp.signals) || sp.signals.length === 0 || sp.signals.length > STALL_SIGNALS.length) err('bad_stall_signals', 'signals must be a non-empty array of stall signals', `${p}/signals`)
  else for (const s of sp.signals) if (!STALL_SIGNALS.includes(s as StallSignal)) err('bad_stall_signal', `unknown stall signal: ${String(s)} (allowed: ${STALL_SIGNALS.join(', ')})`, `${p}/signals`)
  for (const k of Object.keys(sp)) if (!['max_stalled_rounds', 'signals'].includes(k)) err('stall_policy_unknown_field', `unknown stall_policy field: ${k}`, `${p}/${k}`)
}

// ── agents / inputs / schemas ─────────────────────────────────────────────────

function validateAgents(agents: unknown, err: Err): Set<string> {
  const roles = new Set<string>()
  if (!isObj(agents) || Object.keys(agents).length === 0) { err('agents_missing', 'agents must be a non-empty object of role → { agent, node_id? }', '/agents'); return roles }
  for (const [role, def] of Object.entries(agents)) {
    const p = `/agents/${role}`
    if (!SAFE_ID_RE.test(role)) err('bad_role_name', `agent role name is not a safe identifier: ${role}`, p)
    roles.add(role)
    if (!isObj(def)) { err('bad_role', 'agent role must be an object', p); continue }
    if (!isStr(def.agent) || def.agent.trim() === '') err('bad_role_agent', 'role.agent must be a non-empty string (data, not a command)', `${p}/agent`)
    if (def.node_id !== undefined && (!isStr(def.node_id) || !NODE_ID_RE.test(def.node_id))) err('bad_role_node_id', 'role.node_id must be a safe opaque id', `${p}/node_id`)
    if (def.description !== undefined && !isStr(def.description)) err('bad_field_type', 'role.description must be a string', `${p}/description`)
    for (const k of Object.keys(def)) if (!['agent', 'node_id', 'description'].includes(k)) err('role_unknown_field', `unknown agent-role field: ${k}`, `${p}/${k}`)
  }
  return roles
}

function validateInputs(inputs: unknown, err: Err): Map<string, WorkflowInputType> {
  const types = new Map<string, WorkflowInputType>()
  if (inputs === undefined) return types
  if (!isObj(inputs)) { err('inputs_bad', 'inputs must be an object', '/inputs'); return types }
  for (const [name, def] of Object.entries(inputs)) {
    const p = `/inputs/${name}`
    if (!SAFE_ID_RE.test(name)) err('bad_input_name', `input name is not a safe identifier: ${name}`, p)
    if (!isObj(def)) { err('bad_input', 'input def must be an object', p); continue }
    const t = def.type
    if (!isStr(t) || !['string', 'number', 'boolean', 'string[]'].includes(t)) err('bad_input_type', 'input.type must be string|number|boolean|string[]', `${p}/type`)
    else { types.set(name, t as WorkflowInputType); if (def.default !== undefined && !matchesInputType(def.default, t as WorkflowInputType)) err('bad_input_default', 'input.default does not match input.type', `${p}/default`) }
    if (def.required !== undefined && typeof def.required !== 'boolean') err('bad_field_type', 'input.required must be boolean', `${p}/required`)
    if (def.description !== undefined && !isStr(def.description)) err('bad_field_type', 'input.description must be a string', `${p}/description`)
    for (const k of Object.keys(def)) if (!['type', 'required', 'description', 'default'].includes(k)) err('input_unknown_field', `unknown input field: ${k}`, `${p}/${k}`)
  }
  return types
}

function validateOutputSchemas(output_schemas: unknown, err: Err): { schemaNames: Set<string>; schemaFields: Map<string, Set<string>>; schemaFieldDefs: Map<string, Map<string, FieldDef>> } {
  const schemaNames = new Set<string>()
  const schemaFields = new Map<string, Set<string>>()
  const schemaFieldDefs = new Map<string, Map<string, FieldDef>>()
  if (!isObj(output_schemas) || Object.keys(output_schemas).length === 0) { err('output_schemas_missing', 'output_schemas must be a non-empty object', '/output_schemas'); return { schemaNames, schemaFields, schemaFieldDefs } }
  for (const [sname, sdef] of Object.entries(output_schemas)) {
    const p = `/output_schemas/${sname}`
    if (!SAFE_ID_RE.test(sname)) err('bad_schema_name', `output schema name is not a safe identifier: ${sname}`, p)
    schemaNames.add(sname)
    const fields = new Set<string>(); schemaFields.set(sname, fields)
    const defs = new Map<string, FieldDef>(); schemaFieldDefs.set(sname, defs)
    if (!isObj(sdef)) { err('bad_schema', 'output schema must be { fields: {...} }', p); continue }
    for (const k of Object.keys(sdef)) if (k !== 'fields') err('schema_unknown_field', `output schema allows only "fields": ${k}`, `${p}/${k}`)
    if (!isObj(sdef.fields)) { err('bad_schema', 'output schema must be { fields: {...} }', `${p}/fields`); continue }
    if (Object.keys(sdef.fields).length === 0) err('schema_no_fields', 'output schema fields must be non-empty', `${p}/fields`)
    for (const [fname, fdef] of Object.entries(sdef.fields as Record<string, unknown>)) {
      const fp = `${p}/fields/${fname}`
      fields.add(fname)
      if (!isObj(fdef)) { err('bad_schema_field', 'schema field must be an object', fp); continue }
      const ft = fdef.type
      const validType = isStr(ft) && ['string', 'number', 'boolean', 'string[]', 'enum'].includes(ft)
      if (!validType) err('bad_schema_field_type', 'field.type must be string|number|boolean|string[]|enum', `${fp}/type`)
      if (ft === 'enum') validateEnumValues(fdef.enum, `${fp}/enum`, err)
      else if (fdef.enum !== undefined) err('enum_on_non_enum_field', 'enum is only allowed on type "enum"', `${fp}/enum`)
      if (fdef.required !== undefined && typeof fdef.required !== 'boolean') err('bad_field_type', 'field.required must be boolean', `${fp}/required`)
      if (fdef.description !== undefined && !isStr(fdef.description)) err('bad_field_type', 'field.description must be a string', `${fp}/description`)
      for (const k of Object.keys(fdef)) if (!['type', 'required', 'enum', 'description'].includes(k)) err('schema_field_unknown_field', `unknown schema-field key: ${k}`, `${fp}/${k}`)
      if (validType) defs.set(fname, { type: ft as SchemaFieldType, enum: Array.isArray(fdef.enum) ? (fdef.enum as string[]) : undefined, required: fdef.required === true })
    }
  }
  return { schemaNames, schemaFields, schemaFieldDefs }
}

function validateEnumValues(en: unknown, path: string, err: Err): void {
  if (!Array.isArray(en) || en.length === 0) { err('bad_enum', 'enum field requires a non-empty string enum[]', path); return }
  if (en.length > MAX_ENUM_VALUES) err('enum_too_many', `enum has more than ${MAX_ENUM_VALUES} values`, path)
  const seen = new Set<string>()
  for (const v of en) {
    if (typeof v !== 'string' || v === '') { err('enum_value_invalid', 'enum values must be non-empty strings', path); continue }
    if (v.length > MAX_ENUM_VALUE_LENGTH) err('enum_value_invalid', `enum value exceeds ${MAX_ENUM_VALUE_LENGTH} chars`, path)
    if (seen.has(v)) err('enum_duplicate_values', 'enum values must be unique', path)
    seen.add(v)
  }
}

// ── steps ──────────────────────────────────────────────────────────────────────

/** Structural compatibility of a bound step's output schema with a destination
 *  context slot: every declared output field must belong to the destination shape,
 *  and the core `status` + `summary` fields must be present and required (so a
 *  successful output can always replace the slot deterministically). */
function checkContextBindingCompat(group: ContextGroup, schemaName: string | undefined, defs: Map<string, FieldDef> | undefined, path: string, err: Err): void {
  const allowed = CONTEXT_FIELDS[group]
  if (!schemaName || !defs) return // an unknown schema is already reported elsewhere
  for (const fname of defs.keys()) {
    if (!allowed.includes(fname)) err('context_binding_incompatible_schema', `output field "${fname}" is not part of context.${group}; bound output schema must be structurally compatible`, path)
  }
  for (const core of ['status', 'summary']) {
    const d = defs.get(core)
    if (!d || !d.required) err('context_binding_incompatible_schema', `context.${group} binding requires a required "${core}" output field`, path)
  }
}

const MAX_PAUSE_PROMPT = 2000
const MAX_PAUSE_CHOICES = 50
const MAX_PAUSE_CHOICE_LEN = 200

/** Validate a step's optional `pause_before` human-pause gate (bounded). */
function validatePauseGate(gate: unknown, p: string, err: Err): void {
  if (!isObj(gate)) { err('bad_pause_before', 'pause_before must be an object', p); return }
  if (gate.kind !== 'input' && gate.kind !== 'approval') err('bad_pause_kind', 'pause_before.kind must be "input" or "approval"', `${p}/kind`)
  if (!isStr(gate.prompt) || gate.prompt.length === 0 || gate.prompt.length > MAX_PAUSE_PROMPT) err('bad_pause_prompt', `pause_before.prompt must be a non-empty string ≤ ${MAX_PAUSE_PROMPT} chars`, `${p}/prompt`)
  if (gate.choices !== undefined) {
    if (!Array.isArray(gate.choices) || gate.choices.length > MAX_PAUSE_CHOICES || !gate.choices.every((c) => isStr(c) && (c as string).length > 0 && (c as string).length <= MAX_PAUSE_CHOICE_LEN)) {
      err('bad_pause_choices', `pause_before.choices must be an array of ≤ ${MAX_PAUSE_CHOICES} non-empty strings (≤ ${MAX_PAUSE_CHOICE_LEN} chars each)`, `${p}/choices`)
    }
  }
  for (const k of Object.keys(gate)) if (!['kind', 'prompt', 'choices'].includes(k)) err('pause_unknown_field', `unknown pause_before field: ${k}`, `${p}/${k}`)
}

function validateSteps(steps: unknown, agentRoles: Set<string>, schemaNames: Set<string>, schemaFieldDefs: Map<string, Map<string, FieldDef>>, err: Err): { stepIds: Set<string>; stepOutputSchema: Map<string, string> } {
  const stepIds = new Set<string>()
  const stepOutputSchema = new Map<string, string>()
  if (!Array.isArray(steps) || steps.length === 0) { err('steps_missing', 'steps must be a non-empty array', '/steps'); return { stepIds, stepOutputSchema } }
  steps.forEach((step, i) => {
    const p = `/steps/${i}`
    if (!isObj(step)) { err('bad_step', 'step must be an object', p); return }
    const id = step.id
    if (!isStr(id) || !SAFE_ID_RE.test(id)) err('bad_step_id', 'step.id must be a safe identifier', `${p}/id`)
    else { if (stepIds.has(id)) err('duplicate_step_id', `duplicate step id: ${id}`, `${p}/id`); stepIds.add(id) }
    if (step.type !== 'agent_task') err('unsupported_step_type', 'v1 supports only type "agent_task"', `${p}/type`)
    if (!isStr(step.agent_role) || !agentRoles.has(step.agent_role)) err('unknown_agent_role', `step.agent_role does not reference a defined role: ${String(step.agent_role)}`, `${p}/agent_role`)
    if (!isStr(step.output_schema) || !schemaNames.has(step.output_schema)) err('unknown_output_schema', `step.output_schema does not reference a defined schema: ${String(step.output_schema)}`, `${p}/output_schema`)
    else if (isStr(id)) stepOutputSchema.set(id, step.output_schema)
    if (step.permission_mode !== undefined && step.permission_mode !== 'default' && step.permission_mode !== 'unsafe-skip') err('bad_permission_mode', 'permission_mode must be "default" or "unsafe-skip"', `${p}/permission_mode`)
    if (!isStr(step.prompt_template)) err('bad_prompt_template', 'prompt_template must be a string', `${p}/prompt_template`)
    if (step.workspace_key_template !== undefined && !isStr(step.workspace_key_template)) err('bad_workspace_key_template', 'workspace_key_template must be a string', `${p}/workspace_key_template`)
    if (step.context_binding !== undefined) {
      if (!isStr(step.context_binding) || !CONTEXT_GROUPS.includes(step.context_binding as ContextGroup)) err('bad_context_binding', `context_binding must be one of: ${CONTEXT_GROUPS.join(', ')}`, `${p}/context_binding`)
      else if (isStr(step.output_schema)) checkContextBindingCompat(step.context_binding as ContextGroup, step.output_schema, schemaFieldDefs.get(step.output_schema), `${p}/context_binding`, err)
    }
    if (step.label !== undefined && !isStr(step.label)) err('bad_field_type', 'step.label must be a string', `${p}/label`)
    if (step.description !== undefined && !isStr(step.description)) err('bad_field_type', 'step.description must be a string', `${p}/description`)
    if (step.pause_before !== undefined) validatePauseGate(step.pause_before, `${p}/pause_before`, err)
    for (const k of Object.keys(step)) if (!['id', 'type', 'agent_role', 'prompt_template', 'output_schema', 'permission_mode', 'workspace_key_template', 'context_binding', 'pause_before', 'label', 'description'].includes(k)) err('step_unknown_field', `unknown step field: ${k}`, `${p}/${k}`)
  })
  return { stepIds, stepOutputSchema }
}

// ── limits ─────────────────────────────────────────────────────────────────────

function validateLimits(limits: unknown, hasLoopEdge: boolean, err: Err): void {
  if (!isObj(limits)) { err('limits_missing', 'limits must be an object', '/limits'); return }
  const required: Array<keyof typeof LIMIT_MAXIMA> = ['max_tasks', 'max_runtime_seconds', 'max_step_attempts', 'max_failures']
  for (const key of required) {
    const v = limits[key]; const p = `/limits/${key}`
    if (v === undefined) err('limit_missing', `limits.${key} is required`, p)
    else if (!isPosInt(v)) err('limit_invalid', `limits.${key} must be a positive integer`, p)
    else if (v > LIMIT_MAXIMA[key]) err('limit_exceeds_max', `limits.${key} exceeds the maximum (${LIMIT_MAXIMA[key]})`, p)
  }
  if (limits.max_rounds !== undefined) {
    if (!isPosInt(limits.max_rounds)) err('limit_invalid', 'limits.max_rounds must be a positive integer', '/limits/max_rounds')
    else if (limits.max_rounds > LIMIT_MAXIMA.max_rounds) err('limit_exceeds_max', `limits.max_rounds exceeds the maximum (${LIMIT_MAXIMA.max_rounds})`, '/limits/max_rounds')
  }
  if (hasLoopEdge && !isPosInt(limits.max_rounds)) err('loop_requires_max_rounds', 'a workflow with loop edges must define a positive limits.max_rounds', '/limits/max_rounds')
  if (limits.budget !== undefined) {
    if (!isObj(limits.budget)) err('bad_budget', 'limits.budget must be an object (reserved; must be empty in v1)', '/limits/budget')
    else for (const k of Object.keys(limits.budget)) err('budget_unknown_field', `limits.budget must be empty in v1: ${k}`, `/limits/budget/${k}`)
  }
  for (const k of Object.keys(limits)) if (!['max_rounds', 'max_tasks', 'max_runtime_seconds', 'max_step_attempts', 'max_failures', 'budget'].includes(k)) err('limit_unknown_field', `unknown limits field: ${k}`, `/limits/${k}`)
}

// ── edges + graph ────────────────────────────────────────────────────────────

interface Graph {
  normalAdj: Map<string, string[]>   // step → step, loop edges removed (for dominators + cycle)
  allAdj: Map<string, string[]>      // step → step, all edges (for reachability)
  outgoing: Map<string, Array<{ condition?: unknown; kind: unknown; idx: number }>>
  anyTerminalEdge: boolean
}

function validateEdges(spec: Record<string, unknown>, stepIds: Set<string>, stepOutputSchema: Map<string, string>, schemaFields: Map<string, Set<string>>, err: Err): Graph {
  const normalAdj = new Map<string, string[]>()
  const allAdj = new Map<string, string[]>()
  const outgoing = new Map<string, Array<{ condition?: unknown; kind: unknown; idx: number }>>()
  const seenEdgeKeys = new Set<string>()
  let anyTerminalEdge = false
  if (!Array.isArray(spec.edges)) { err('edges_missing', 'edges must be an array', '/edges'); return { normalAdj, allAdj, outgoing, anyTerminalEdge } }

  spec.edges.forEach((edge, i) => {
    const p = `/edges/${i}`
    if (!isObj(edge)) { err('bad_edge', 'edge must be an object', p); return }
    const from = edge.from, to = edge.to, kind = edge.kind
    if (!isStr(from) || !stepIds.has(from)) err('edge_bad_source', `edge.from must reference a step id: ${String(from)}`, `${p}/from`)
    const toIsTerminal = isStr(to) && isTerminalTarget(to)
    const toIsStep = isStr(to) && stepIds.has(to)
    if (!toIsTerminal && !toIsStep) err('edge_bad_target', `edge.to must be a step id or a reserved terminal (${TERMINAL_TARGETS.join(', ')}): ${String(to)}`, `${p}/to`)
    if (kind !== 'normal' && kind !== 'loop') err('edge_bad_kind', 'edge.kind must be "normal" or "loop"', `${p}/kind`)
    for (const k of Object.keys(edge)) if (!['from', 'to', 'condition', 'kind'].includes(k)) err('edge_unknown_field', `unknown edge field: ${k}`, `${p}/${k}`)

    if (edge.condition !== undefined) {
      const codes = checkConditionShape(edge.condition)
      for (const c of codes) err(c, `invalid edge condition (${c})`, `${p}/condition`)
      if (codes.length === 0 && isStr(from)) {
        const cond = edge.condition as { path: string }
        const parsed = parseConditionPath(cond.path)
        if (parsed && parsed.namespace === 'output') {
          const schema = stepOutputSchema.get(from)
          const flds = schema ? schemaFields.get(schema) : undefined
          if (flds && !flds.has(parsed.key)) err('condition_unknown_output_field', `condition references unknown output field: output.${parsed.key}`, `${p}/condition`)
        }
      }
    }

    const key = `${String(from)}→${String(to)}|${String(kind)}|${edge.condition ? JSON.stringify(edge.condition) : '∅'}`
    if (seenEdgeKeys.has(key)) err('duplicate_edge', 'duplicate equivalent edge', p)
    seenEdgeKeys.add(key)

    if (isStr(from) && stepIds.has(from)) {
      outgoing.set(from, [...(outgoing.get(from) ?? []), { condition: edge.condition, kind, idx: i }])
      if (toIsTerminal) anyTerminalEdge = true
      if (toIsStep) {
        allAdj.set(from, [...(allAdj.get(from) ?? []), to as string])
        if (kind !== 'loop') normalAdj.set(from, [...(normalAdj.get(from) ?? []), to as string])
      }
    }
  })
  return { normalAdj, allAdj, outgoing, anyTerminalEdge }
}

function analyzeGraph(spec: Record<string, unknown>, stepIds: Set<string>, entry: string | undefined, graph: Graph, err: Err): { reachable: Set<string>; doms: Map<string, Set<string>> } {
  if (!graph.anyTerminalEdge && Array.isArray(spec.edges)) err('no_terminal_reachable', 'no edge routes to a terminal target ($complete/$failed/$blocked)', '/edges')

  const reachable = new Set<string>()
  if (entry) {
    reachable.add(entry)
    const stack = [entry]
    while (stack.length) { const cur = stack.pop() as string; for (const nxt of graph.allAdj.get(cur) ?? []) if (!reachable.has(nxt)) { reachable.add(nxt); stack.push(nxt) } }
    for (const s of stepIds) if (!reachable.has(s)) err('unreachable_step', `step "${s}" is not reachable from entry_step`, '/steps')
  }

  const cycle = findCycle(stepIds, graph.normalAdj)
  if (cycle) err('unmarked_cycle', `cycle among non-loop edges (mark an intentional back-edge kind:"loop"): ${cycle.join(' → ')}`, '/edges')

  const doms = entry ? computeDominators(entry, reachable, graph.normalAdj) : new Map<string, Set<string>>()
  return { reachable, doms }
}

/** Iterative dominators over the loop-removed DAG, restricted to reachable nodes. */
function computeDominators(entry: string, reachable: Set<string>, normalAdj: Map<string, string[]>): Map<string, Set<string>> {
  const nodes = [...reachable]
  const preds = new Map<string, string[]>()
  for (const n of nodes) preds.set(n, [])
  for (const [u, vs] of normalAdj) if (reachable.has(u)) for (const v of vs) if (reachable.has(v)) preds.get(v)!.push(u)
  const dom = new Map<string, Set<string>>()
  for (const n of nodes) dom.set(n, n === entry ? new Set([entry]) : new Set(nodes))
  let changed = true
  while (changed) {
    changed = false
    for (const n of nodes) {
      if (n === entry) continue
      const ps = preds.get(n)!
      let inter: Set<string> | null = null
      for (const p of ps) {
        const dp = dom.get(p)!
        if (inter === null) inter = new Set(dp)
        else { const nx = new Set<string>(); for (const x of inter) if (dp.has(x)) nx.add(x); inter = nx }
      }
      const next = new Set<string>(inter ?? []); next.add(n)
      const cur = dom.get(n)!
      if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) { dom.set(n, next); changed = true }
    }
  }
  return dom
}

function findCycle(nodes: Set<string>, adj: Map<string, string[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  for (const n of nodes) color.set(n, WHITE)
  const path: string[] = []
  const dfs = (u: string): string[] | null => {
    color.set(u, GRAY); path.push(u)
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) return [...path.slice(path.indexOf(v)), v]
      if (color.get(v) === WHITE) { const c = dfs(v); if (c) return c }
    }
    color.set(u, BLACK); path.pop(); return null
  }
  for (const n of nodes) if (color.get(n) === WHITE) { const c = dfs(n); if (c) return c }
  return null
}

// ── templates ──────────────────────────────────────────────────────────────────

function validateTemplates(
  steps: unknown, inputTypes: Map<string, WorkflowInputType>, stepIds: Set<string>, stepOutputSchema: Map<string, string>,
  schemaFields: Map<string, Set<string>>, reachable: Set<string>, doms: Map<string, Set<string>>, err: Err,
): void {
  if (!Array.isArray(steps)) return
  steps.forEach((step, i) => {
    if (!isObj(step)) return
    const p = `/steps/${i}`
    const stepId = isStr(step.id) ? step.id : undefined
    const hasInputPause = isObj(step.pause_before) && (step.pause_before as Record<string, unknown>).kind === 'input'
    if (isStr(step.prompt_template)) {
      const parsed = parseTemplateReferences(step.prompt_template)
      for (const code of parsed.errors) err(code, `invalid template reference (${code})`, `${p}/prompt_template`)
      for (const ref of parsed.refs) checkPromptRef(ref, `${p}/prompt_template`, stepId, hasInputPause, inputTypes, stepIds, stepOutputSchema, schemaFields, reachable, doms, err)
    }
    if (isStr(step.workspace_key_template)) validateWorkspaceKey(step.workspace_key_template, `${p}/workspace_key_template`, inputTypes, err)
  })
}

function checkPromptRef(
  ref: TemplateRef, path: string, currentStep: string | undefined, hasInputPause: boolean, inputTypes: Map<string, WorkflowInputType>,
  stepIds: Set<string>, stepOutputSchema: Map<string, string>, schemaFields: Map<string, Set<string>>,
  reachable: Set<string>, doms: Map<string, Set<string>>, err: Err,
): void {
  if (ref.kind === 'pause') {
    // pause.response is valid ONLY on a step whose pause_before is an input gate.
    if (!hasInputPause) err('template_pause_without_input_gate', 'pause.response requires this step to declare pause_before.kind = "input"', path)
  } else if (ref.kind === 'input') {
    if (!inputTypes.has(ref.name)) err('template_unknown_input', `template references unknown input: ${ref.name}`, path)
  } else if (ref.kind === 'context') {
    const fields = CONTEXT_FIELDS[ref.group]
    if (!fields || !fields.includes(ref.field)) err('template_unknown_context_field', `unknown context field: context.${ref.group}.${ref.field}`, path)
  } else if (ref.kind === 'step_output') {
    if (!stepIds.has(ref.step)) { err('template_unknown_step', `template references unknown step: ${ref.step}`, path); return }
    const schema = stepOutputSchema.get(ref.step)
    const flds = schema ? schemaFields.get(schema) : undefined
    if (flds && !flds.has(ref.field)) err('template_unknown_output_field', `template references unknown output field: ${ref.step}.output.${ref.field}`, path)
    // availability: the referenced step must be guaranteed to have run — i.e. it
    // must strictly dominate the referencing step in the loop-removed DAG. Use
    // context.* for cross-round latest-value handoffs instead.
    if (currentStep && reachable.has(currentStep)) {
      if (ref.step === currentStep) err('template_self_reference', `a step may not reference its own output: ${ref.step}`, path)
      else if (!(doms.get(currentStep)?.has(ref.step))) err('template_step_not_guaranteed', `step "${ref.step}" is not guaranteed to run before "${currentStep}" (not a dominator); use context.* for cross-round handoffs`, path)
    }
  }
}

function validateWorkspaceKey(wk: string, path: string, inputTypes: Map<string, WorkflowInputType>, err: Err): void {
  if (!wk.includes('{{')) { if (!WORKSPACE_KEY_RE.test(wk)) err('bad_workspace_key', 'workspace_key_template must be a safe opaque key or exactly one {{ inputs.<name> }} reference', path); return }
  const parsed = parseTemplateReferences(wk)
  for (const code of parsed.errors) err(code, `invalid template reference (${code})`, path)
  const single = parsed.refs.length === 1 && parsed.refs[0].kind === 'input' && wk.trim() === parsed.refs[0].raw
  if (!single) { err('workspace_key_bad_reference', 'workspace_key_template must be exactly one {{ inputs.<name> }} reference (no other text)', path); return }
  const name = (parsed.refs[0] as { name: string }).name
  if (!inputTypes.has(name)) { err('template_unknown_input', `workspace_key_template references unknown input: ${name}`, path); return }
  if (inputTypes.get(name) !== 'string') err('workspace_key_input_not_string', `workspace_key input "${name}" must be type string`, path)
}

// ── deterministic + exhaustive routing ───────────────────────────────────────

type Selector = { kind: 'round' } | { kind: 'field'; field: string; def?: FieldDef } | { kind: 'unknown' }

function selectorOf(cond: unknown, from: string, stepOutputSchema: Map<string, string>, schemaFieldDefs: Map<string, Map<string, FieldDef>>): Selector {
  if (!isObj(cond) || !isStr(cond.path)) return { kind: 'unknown' }
  const parsed = parseConditionPath(cond.path)
  if (!parsed) return { kind: 'unknown' }
  if (parsed.namespace === 'workflow') return { kind: 'round' }
  const schema = stepOutputSchema.get(from)
  const def = schema ? schemaFieldDefs.get(schema)?.get(parsed.key) : undefined
  return { kind: 'field', field: parsed.key, def }
}

function validateRouting(outgoing: Map<string, Array<{ condition?: unknown; kind: unknown; idx: number }>>, stepOutputSchema: Map<string, string>, schemaFieldDefs: Map<string, Map<string, FieldDef>>, err: Err): void {
  for (const [from, edges] of outgoing) {
    const conditional = edges.filter((e) => e.condition !== undefined)
    const fallbacks = edges.filter((e) => e.condition === undefined)
    if (fallbacks.length >= 2) err('ambiguous_unconditional_edges', `step "${from}" has ${fallbacks.length} unconditional outgoing edges`, '/edges')

    // per-edge value/type checks (only for well-formed conditions).
    for (const e of conditional) {
      if (checkConditionShape(e.condition).length !== 0) continue
      const sel = selectorOf(e.condition, from, stepOutputSchema, schemaFieldDefs)
      for (const c of conditionValueTypeIssues(e.condition as { op: string; value?: unknown }, sel)) err(c, `edge condition value is incompatible with the selected field (${c})`, `/edges/${e.idx}/condition`)
    }

    if (conditional.length < 2) {
      // single conditional (or none): still enforce enum exhaustiveness below.
    } else {
      // multi-branch: require ONE selector path, ops eq/in only, pairwise-disjoint.
      const sels = conditional.map((e) => (isObj(e.condition) && isStr((e.condition as { path?: unknown }).path)) ? (e.condition as { path: string }).path : '?')
      const uniquePaths = new Set(sels)
      if (uniquePaths.size !== 1 || sels.includes('?')) { err('routing_mixed_selectors', `step "${from}" branches on multiple/ambiguous selectors; multi-branch routing must share one selector path`, '/edges'); continue }
      const ops = conditional.map((e) => (e.condition as { op: string }).op)
      if (!ops.every((o) => o === 'eq' || o === 'in')) { err('routing_not_provably_disjoint', `step "${from}" multi-branch conditions must use only eq/in (neq/exists cannot be proven disjoint)`, '/edges'); continue }
      const seen = new Set<unknown>(); let overlap = false
      for (const e of conditional) {
        const c = e.condition as { op: string; value?: unknown }
        const vals = c.op === 'in' ? (Array.isArray(c.value) ? c.value : []) : [c.value]
        for (const v of vals) { if (seen.has(v)) overlap = true; seen.add(v) }
      }
      if (overlap) err('routing_overlapping_values', `step "${from}" has overlapping eq/in condition values across branches`, '/edges')
    }

    // enum exhaustiveness: a REQUIRED enum selector must be fully routed (or a
    // single fallback covers the remainder).
    if (conditional.length >= 1) {
      const sel = selectorOf(conditional[0].condition, from, stepOutputSchema, schemaFieldDefs)
      const sameField = conditional.every((e) => {
        const s = selectorOf(e.condition, from, stepOutputSchema, schemaFieldDefs)
        return sel.kind === 'field' && s.kind === 'field' && s.field === sel.field
      })
      if (sameField && sel.kind === 'field' && sel.def?.type === 'enum' && Array.isArray(sel.def.enum)) {
        const covered = new Set<unknown>()
        for (const e of conditional) {
          const c = e.condition as { op: string; value?: unknown }
          if (c.op === 'eq') covered.add(c.value)
          else if (c.op === 'in' && Array.isArray(c.value)) for (const v of c.value) covered.add(v)
        }
        // Exhaustiveness applies to REQUIRED enum selectors (an optional field may
        // be absent at runtime, so a fallback is not statically mandatory).
        if (sel.def.required && fallbacks.length === 0) for (const v of sel.def.enum) if (!covered.has(v)) err('enum_outcome_unrouted', `step "${from}" leaves enum outcome "${v}" of "${sel.field}" unrouted`, '/edges')
      }
    }
  }
}

function conditionValueTypeIssues(cond: { op: string; value?: unknown }, sel: Selector): string[] {
  const out: string[] = []
  const isScalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  const matchesField = (v: unknown, def?: FieldDef): boolean => {
    if (!def) return true // unresolved field — cannot statically check
    switch (def.type) {
      case 'string': return typeof v === 'string'
      case 'number': return typeof v === 'number'
      case 'boolean': return typeof v === 'boolean'
      case 'enum': return typeof v === 'string' && !!def.enum && def.enum.includes(v)
      case 'string[]': return false // scalar comparisons unsupported on array fields
    }
  }
  if (cond.op === 'exists') return out
  if (sel.kind === 'round') {
    const vals = cond.op === 'in' ? (Array.isArray(cond.value) ? cond.value : []) : [cond.value]
    if (!vals.every((v) => typeof v === 'number')) out.push('condition_round_needs_number')
    return out
  }
  if (sel.kind !== 'field') return out
  if (sel.def?.type === 'string[]') { out.push('condition_op_not_allowed_for_type'); return out }
  const vals = cond.op === 'in' ? (Array.isArray(cond.value) ? cond.value : []) : [cond.value]
  for (const v of vals) {
    if (!isScalar(v)) { out.push('condition_value_type_mismatch'); continue }
    if (!matchesField(v, sel.def)) out.push(sel.def?.type === 'enum' ? 'condition_value_not_in_enum' : 'condition_value_type_mismatch')
  }
  return out
}

// ── secrets ────────────────────────────────────────────────────────────────────

function scanSecretFields(node: unknown, path: string, err: Err): void {
  if (Array.isArray(node)) { node.forEach((v, i) => scanSecretFields(v, `${path}/${i}`, err)); return }
  if (!isObj(node)) return
  for (const [k, v] of Object.entries(node)) {
    if (isSecretKey(k)) err('secret_field_forbidden', `credential-like field name is not allowed: ${k}`, `${path}/${k}`)
    scanSecretFields(v, `${path}/${k}`, err)
  }
}
