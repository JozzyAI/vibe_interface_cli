/**
 * Validate a parsed agent-output object against a declared {@link OutputSchema}.
 *
 * Strict and PURE: required fields must be present with the declared type, enum
 * values must be members of the declared set, UNKNOWN fields are rejected (fail
 * closed), and strings/arrays/total size are bounded. Never coerces values.
 * Diagnostics are bounded and never echo the offending value.
 */
import type { OutputSchema, SchemaField } from './contract.js'

export const MAX_OUTPUT_STRING_LEN = 16 * 1024
export const MAX_OUTPUT_ARRAY_LEN = 512
export const MAX_OUTPUT_SERIALIZED_BYTES = 128 * 1024

export type SchemaValidateResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; message: string; field?: string }

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

function matchesType(v: unknown, f: SchemaField): boolean {
  switch (f.type) {
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'string[]': return Array.isArray(v) && v.every((x) => typeof x === 'string')
    case 'enum': return typeof v === 'string' && Array.isArray(f.enum) && f.enum.includes(v)
  }
}

/** Validate `obj` against `schema`. Returns the (unchanged) object on success. */
export function validateAgainstSchema(obj: Record<string, unknown>, schema: OutputSchema): SchemaValidateResult {
  const fields = schema.fields
  // Fail closed on unknown fields.
  for (const k of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) return { ok: false, code: 'output_unknown_field', message: `output has an unknown field: ${k}`, field: k }
  }
  for (const [name, def] of Object.entries(fields)) {
    const present = Object.prototype.hasOwnProperty.call(obj, name)
    if (!present) {
      if (def.required) return { ok: false, code: 'output_missing_required', message: `output is missing required field: ${name}`, field: name }
      continue
    }
    const v = obj[name]
    if (!matchesType(v, def)) {
      const code = def.type === 'enum' ? 'output_enum_invalid' : 'output_type_mismatch'
      return { ok: false, code, message: `output field "${name}" does not satisfy its declared ${def.type === 'enum' ? 'enum' : `type ${def.type}`}`, field: name }
    }
    // Bounded strings/arrays (do not echo the value).
    if (def.type === 'string' && byteLen(v as string) > MAX_OUTPUT_STRING_LEN) return { ok: false, code: 'output_string_too_long', message: `output field "${name}" exceeds the string size limit`, field: name }
    if (def.type === 'string[]') {
      const arr = v as string[]
      if (arr.length > MAX_OUTPUT_ARRAY_LEN) return { ok: false, code: 'output_array_too_long', message: `output field "${name}" exceeds the array length limit`, field: name }
      for (const s of arr) if (byteLen(s) > MAX_OUTPUT_STRING_LEN) return { ok: false, code: 'output_string_too_long', message: `an element of output field "${name}" exceeds the string size limit`, field: name }
    }
  }
  // Bounded total serialized size.
  let serialized: string
  try { serialized = JSON.stringify(obj) } catch { return { ok: false, code: 'output_not_serializable', message: 'output is not JSON-serializable' } }
  if (byteLen(serialized) > MAX_OUTPUT_SERIALIZED_BYTES) return { ok: false, code: 'output_too_large', message: 'output exceeds the total serialized size limit' }
  return { ok: true, value: obj }
}
