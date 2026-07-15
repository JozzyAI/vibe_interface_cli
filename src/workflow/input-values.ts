/**
 * Validate + normalize workflow INPUT VALUES against a validated WorkflowSpec's
 * input declarations. PURE. The normalized values are persisted immutably by the
 * runtime and become the `inputs.<name>` render scope.
 *
 * Fail closed: reject unknown input names, missing required values, and type
 * mismatches; apply declared defaults deterministically; reject credential/token/
 * key field names (a workflow description must never smuggle a secret through an
 * input value).
 */
import type { WorkflowSpec, WorkflowInputType } from './contract.js'

export type NormalizeResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; code: string; message: string; name?: string }

const SECRET_TOKENS = ['token', 'secret', 'password', 'passwd', 'apikey', 'bearer', 'credential', 'privatekey', 'encryptionkey', 'accesskey', 'signingkey']
function isSecretName(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return norm === 'pid' || SECRET_TOKENS.some((t) => norm.includes(t))
}

function matchesType(v: unknown, t: WorkflowInputType): boolean {
  switch (t) {
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'string[]': return Array.isArray(v) && v.every((x) => typeof x === 'string')
  }
}

/**
 * Normalize `provided` input values against `spec.inputs`. Unknown names and type
 * mismatches fail; missing required values fail; declared defaults fill absent
 * optionals; optional inputs with no value/default are omitted (absent). Never
 * mutates `provided`.
 */
export function normalizeInputValues(spec: WorkflowSpec, provided: unknown): NormalizeResult {
  if (provided !== undefined && (typeof provided !== 'object' || provided === null || Array.isArray(provided))) {
    return { ok: false, code: 'invalid_input_values', message: 'input values must be a JSON object' }
  }
  const given = (provided ?? {}) as Record<string, unknown>
  const defs = spec.inputs ?? {}

  for (const name of Object.keys(given)) {
    if (isSecretName(name)) return { ok: false, code: 'invalid_input_values', message: `input value "${name}" uses a reserved credential-like name`, name }
    if (!Object.prototype.hasOwnProperty.call(defs, name)) return { ok: false, code: 'invalid_input_values', message: `unknown input name: ${name}`, name }
  }

  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(defs)) {
    const has = Object.prototype.hasOwnProperty.call(given, name)
    if (has) {
      if (!matchesType(given[name], def.type)) return { ok: false, code: 'invalid_input_values', message: `input "${name}" does not match declared type ${def.type}`, name }
      out[name] = given[name]
    } else if (def.default !== undefined) {
      out[name] = def.default
    } else if (def.required) {
      return { ok: false, code: 'invalid_input_values', message: `missing required input: ${name}`, name }
    }
  }
  return { ok: true, values: out }
}
