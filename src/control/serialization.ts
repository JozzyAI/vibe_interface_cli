/**
 * Safe (de)serialization for the durable control store. ALL JSON read back from
 * SQLite is treated as UNTRUSTED persisted input: it is parsed defensively,
 * bounded in size, validated against the record contracts, and NEVER evaluated.
 * Nothing is trusted merely because this process previously wrote it.
 */
import { ControlStoreError } from './records.js'

// ── size bounds (bytes of the JSON text) ─────────────────────────────────────
export const SIZE_LIMITS = {
  input_text: 64 * 1024,
  metadata_json: 16 * 1024,
  task_event_payload: 64 * 1024,
  spec_json: 256 * 1024,
  context_json: 128 * 1024,
  step_output_json: 64 * 1024,
  step_error_json: 16 * 1024,
  workflow_event_payload: 64 * 1024,
  error_message: 4 * 1024,
} as const

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/** Current instant as an ISO-8601 UTC timestamp (the store's only time format). */
export function nowIso(): string { return new Date().toISOString() }

export function isIsoUtc(s: unknown): s is string { return typeof s === 'string' && ISO_UTC_RE.test(s) }

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

/**
 * Serialize a value to bounded JSON. Throws `too_large` past `maxBytes`. The
 * label — never the value — appears in the error (no sensitive-payload echo).
 */
export function encodeJson(value: unknown, maxBytes: number, label: string): string {
  let text: string
  try { text = JSON.stringify(value) } catch { throw new ControlStoreError('invalid_record', `${label}: value is not JSON-serializable`) }
  if (text === undefined) throw new ControlStoreError('invalid_record', `${label}: value is not JSON-serializable`)
  if (byteLen(text) > maxBytes) throw new ControlStoreError('too_large', `${label}: exceeds ${maxBytes} bytes`)
  return text
}

/** Bound a plain string column; throws `too_large` past `maxBytes`. */
export function boundString(value: string, maxBytes: number, label: string): string {
  if (byteLen(value) > maxBytes) throw new ControlStoreError('too_large', `${label}: exceeds ${maxBytes} bytes`)
  return value
}

/**
 * Parse persisted JSON defensively. Bounds the raw text, rejects non-JSON, and
 * (when `expectObject`) requires a plain object. Failures are `corruption`
 * errors that never echo the payload.
 */
export function decodeJson(text: string | null, maxBytes: number, label: string, expectObject = false): unknown {
  if (text === null) return null
  if (byteLen(text) > maxBytes) throw new ControlStoreError('corruption', `${label}: persisted JSON exceeds ${maxBytes} bytes`)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ControlStoreError('corruption', `${label}: persisted JSON is malformed`) }
  if (expectObject && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) throw new ControlStoreError('corruption', `${label}: persisted JSON is not an object`)
  return parsed
}

// ── context-bundle validation (fail closed; reject secrets) ───────────────────

const CONTEXT_ALLOWED_KEYS = new Set([
  'objective', 'current_round', 'latest_planner_decision', 'latest_executor_handoff',
  'decisions', 'open_questions', 'verified_evidence', 'prior_task_ids', 'history_summaries',
])
const SECRET_TOKENS = ['token', 'secret', 'password', 'passwd', 'apikey', 'bearer', 'credential', 'privatekey', 'encryptionkey', 'accesskey', 'sessionhistory', 'processid']
function isForbiddenKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (norm === 'pid') return true
  return SECRET_TOKENS.some((t) => norm.includes(t))
}

/** Recursively reject credential/token/key/PID/native-session field NAMES. */
export function assertNoForbiddenFields(node: unknown, label: string): void {
  if (Array.isArray(node)) { for (const v of node) assertNoForbiddenFields(v, label) ; return }
  if (typeof node !== 'object' || node === null) return
  for (const [k, v] of Object.entries(node)) {
    if (isForbiddenKey(k)) throw new ControlStoreError('forbidden_field', `${label}: forbidden field name "${k}" (no credentials/tokens/keys/PIDs/sessions)`)
    assertNoForbiddenFields(v, label)
  }
}

/**
 * Validate a WorkflowContextBundle for persistence: a plain object, fail-closed
 * on unknown top-level keys, and no forbidden field names anywhere.
 */
export function assertValidContext(ctx: unknown, label: string): void {
  if (typeof ctx !== 'object' || ctx === null || Array.isArray(ctx)) throw new ControlStoreError('invalid_record', `${label}: context must be an object`)
  for (const k of Object.keys(ctx)) if (!CONTEXT_ALLOWED_KEYS.has(k)) throw new ControlStoreError('forbidden_field', `${label}: unknown context field "${k}" (fail closed)`)
  assertNoForbiddenFields(ctx, label)
}
