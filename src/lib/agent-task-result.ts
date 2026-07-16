/**
 * First-class, durable **AgentTaskResult** — the authoritative control result of
 * an Agent Task. This is PURE: a versioned JSON contract, a content hash, and
 * total validators. There is NO event-history scanning here and NO workflow-schema
 * knowledge (the Workflow Runtime parses `final_output.text` into a step schema
 * separately).
 *
 * Separation of concerns:
 *   - Task events   → streaming / UI / replay / audit / debugging
 *   - AgentTaskResult → the stable FINAL result produced by the Agent Task Harness
 *   - Workflow step output → AgentTaskResult.final_output after strict workflow-schema validation
 *
 * `result_status = available` means ONLY that the Agent Task produced a stable
 * final output. It is NOT proof that code is correct, tests passed, or the
 * workflow objective is complete.
 */
import crypto from 'crypto'

export const AGENT_TASK_RESULT_SCHEMA_VERSION = '1'

/** Result availability — control-plane state, NOT event-history inference.
 *  - `pending`   : the backend has not finalized a result yet.
 *  - `available` : a stable bounded result is durably persisted.
 *  - `missing`   : the backend ended but produced no authoritative final result.
 *  - `invalid`   : the result envelope itself was malformed / corrupted. */
export type TaskResultStatus = 'pending' | 'available' | 'missing' | 'invalid'

export const TASK_RESULT_STATUSES: readonly TaskResultStatus[] = ['pending', 'available', 'missing', 'invalid']

/** Runtime-derived, bounded evidence pointer (never agent claims of correctness). */
export interface EvidenceRef { kind: string; summary?: string; ref?: string }
/** Bounded pointer to a produced artifact (e.g. a PR url). */
export interface ArtifactRef { kind: string; ref: string; summary?: string }

export interface AgentTaskResultV1 {
  schema_version: '1'
  final_output: { kind: 'text'; text: string }
  /** Process/adapter exit status when the backend has one (0 = clean exit). */
  process_exit_code?: number | null
  finalized_at: string
  /** Deterministic digest of `final_output.text` (integrity + idempotency). */
  content_hash: string
  evidence_refs: EvidenceRef[]
  artifact_refs: ArtifactRef[]
}

// ── bounds ───────────────────────────────────────────────────────────────────
export const MAX_FINAL_OUTPUT_BYTES = 256 * 1024
export const MAX_REFS = 64
const MAX_REF_STR = 4 * 1024
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const HEX64_RE = /^[0-9a-f]{64}$/
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

/** Deterministic content hash of the final output text (sha256 hex). */
export function computeResultContentHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface BuildResultInput {
  text: string
  processExitCode?: number | null
  finalizedAt?: string
  evidenceRefs?: EvidenceRef[]
  artifactRefs?: ArtifactRef[]
}

/** Build a well-formed AgentTaskResultV1 (computes the content hash). The caller
 *  is responsible for bounding `text` before persistence (validate enforces it). */
export function buildTaskResult(input: BuildResultInput): AgentTaskResultV1 {
  return {
    schema_version: '1',
    final_output: { kind: 'text', text: input.text },
    process_exit_code: input.processExitCode ?? null,
    finalized_at: input.finalizedAt ?? new Date().toISOString(),
    content_hash: computeResultContentHash(input.text),
    evidence_refs: input.evidenceRefs ?? [],
    artifact_refs: input.artifactRefs ?? [],
  }
}

export type ResultValidateResult =
  | { ok: true; value: AgentTaskResultV1 }
  | { ok: false; code: 'unsupported_schema_version' | 'invalid_result' | 'result_too_large' | 'content_hash_mismatch'; message: string }

function boundedRefs(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > MAX_REFS) return false
  return v.every((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false
    for (const [k, val] of Object.entries(r)) { if (typeof k !== 'string') return false; if (val !== undefined && (typeof val !== 'string' || byteLen(val) > MAX_REF_STR)) return false }
    return typeof (r as { kind?: unknown }).kind === 'string'
  })
}

/**
 * Validate a parsed/persisted result envelope (untrusted). An unknown NEWER
 * schema version fails closed. Verifies the content hash matches the text. Never
 * echoes the output text in an error message.
 */
export function validateTaskResult(obj: unknown): ResultValidateResult {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: 'invalid_result', message: 'result must be a JSON object' }
  const o = obj as Record<string, unknown>
  if (o.schema_version !== AGENT_TASK_RESULT_SCHEMA_VERSION) {
    // A recognizably-newer string version fails CLOSED as unsupported.
    if (typeof o.schema_version === 'string' && o.schema_version > AGENT_TASK_RESULT_SCHEMA_VERSION) return { ok: false, code: 'unsupported_schema_version', message: `unsupported result schema_version ${o.schema_version}` }
    return { ok: false, code: 'invalid_result', message: 'invalid result schema_version' }
  }
  const fo = o.final_output
  if (!fo || typeof fo !== 'object' || Array.isArray(fo) || (fo as { kind?: unknown }).kind !== 'text' || typeof (fo as { text?: unknown }).text !== 'string') return { ok: false, code: 'invalid_result', message: 'final_output must be { kind:"text", text:string }' }
  const text = (fo as { text: string }).text
  if (byteLen(text) > MAX_FINAL_OUTPUT_BYTES) return { ok: false, code: 'result_too_large', message: 'final_output.text exceeds the size limit' }
  if (o.process_exit_code !== undefined && o.process_exit_code !== null && (typeof o.process_exit_code !== 'number' || !Number.isInteger(o.process_exit_code))) return { ok: false, code: 'invalid_result', message: 'process_exit_code must be an integer or null' }
  if (typeof o.finalized_at !== 'string' || !ISO_UTC_RE.test(o.finalized_at)) return { ok: false, code: 'invalid_result', message: 'finalized_at must be ISO-8601 UTC' }
  if (typeof o.content_hash !== 'string' || !HEX64_RE.test(o.content_hash)) return { ok: false, code: 'invalid_result', message: 'content_hash must be a sha256 hex digest' }
  if (o.content_hash !== computeResultContentHash(text)) return { ok: false, code: 'content_hash_mismatch', message: 'content_hash does not match final_output.text' }
  if (!boundedRefs(o.evidence_refs)) return { ok: false, code: 'invalid_result', message: 'evidence_refs must be a bounded array of {kind,...}' }
  if (!boundedRefs(o.artifact_refs)) return { ok: false, code: 'invalid_result', message: 'artifact_refs must be a bounded array of {kind,ref,...}' }
  return {
    ok: true,
    value: {
      schema_version: '1', final_output: { kind: 'text', text },
      process_exit_code: (o.process_exit_code as number | null | undefined) ?? null,
      finalized_at: o.finalized_at, content_hash: o.content_hash,
      evidence_refs: o.evidence_refs as EvidenceRef[], artifact_refs: o.artifact_refs as ArtifactRef[],
    },
  }
}

/** True when two results are byte-equivalent for idempotency (same hash + text +
 *  exit code). Used to distinguish an idempotent duplicate from a corruption
 *  conflict on re-persist. */
export function resultsEquivalent(a: AgentTaskResultV1, b: AgentTaskResultV1): boolean {
  return a.content_hash === b.content_hash && a.final_output.text === b.final_output.text && (a.process_exit_code ?? null) === (b.process_exit_code ?? null)
}
