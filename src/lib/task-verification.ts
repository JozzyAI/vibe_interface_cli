/**
 * Durable, Harness-owned **task verification** contract (PURE).
 *
 * A verification is a TRUSTED, system-run test command executed by the Node/Harness
 * AFTER the Agent process exits and BEFORE the AgentTaskResult is finalized. Its
 * outcome is the ONLY authoritative source of `tests_passed` / `tests_failed`
 * evidence for the completion policy. It is NEVER inferred from the Agent's JSON,
 * `tests_run`, logs, or prose.
 *
 * This module holds only types, bounds, and total validators — no process
 * execution (see `src/runtime/verifier.ts`) and no completion-policy knowledge.
 *
 * Security shape of the CONFIG: an argv vector (never a shell string). There is no
 * `cwd`, `env`, `shell`, `network`, or timeout override field — those are fixed by
 * the harness (leased workspace cwd, scrubbed env, bounded runtime/output), so a
 * spec author cannot widen the sandbox.
 */
import crypto from 'crypto'

export const TASK_VERIFICATION_SCHEMA_VERSION = '1'

/** Bounds — a verifier config/record stays small and cannot be used to smuggle
 *  a large payload into the durable result. */
export const MAX_VERIFY_ARGV_ITEMS = 32
export const MAX_VERIFY_ARGV_ITEM_LEN = 4 * 1024
/** Captured verifier stdout+stderr is bounded before hashing (the hash is over the
 *  bounded capture, so it is stable + replayable). */
export const MAX_VERIFY_OUTPUT_BYTES = 256 * 1024
/** Hard wall-clock cap for a verifier run, enforced by the runner. */
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const HEX64_RE = /^[0-9a-f]{64}$/
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

/** The bounded, argv-only verification CONFIG declared on a workflow step and
 *  threaded (unchanged) to the Node/Harness. `argv[0]` is the program; there is no
 *  shell, so no expansion, globbing, pipes, redirection, or `&&` is possible. */
export interface TaskVerifyConfig {
  argv: string[]
}

/** The two authoritative verification outcomes. `tests_passed` ⇔ the trusted
 *  command exited 0; `tests_failed` ⇔ it exited non-zero (or could not run). */
export type VerificationKind = 'tests_passed' | 'tests_failed'

/** The durable, structured verification evidence embedded in the AgentTaskResult. */
export interface TaskVerificationV1 {
  schema_version: '1'
  kind: VerificationKind
  /** The exact argv the harness executed (echoed for audit; never re-parsed). */
  argv: string[]
  /** The verifier process exit code (0 ⇒ tests_passed). */
  exit_code: number
  started_at: string
  finished_at: string
  /** sha256 hex of the bounded captured stdout+stderr — integrity + idempotency.
   *  It is DELIBERATELY not parsed: success is decided by the exit code, never by
   *  scraping this output. */
  content_hash: string
}

export type VerifyConfigValidation =
  | { ok: true; value: TaskVerifyConfig }
  | { ok: false; code: 'not_object' | 'bad_argv' | 'empty_argv' | 'argv_too_long' | 'argv_item_too_long' | 'argv_item_not_string' | 'unknown_field'; message: string }

/** Validate an untrusted verifier config: a non-empty, bounded array of strings,
 *  with no other fields. Programs with a shell-metacharacter-laden argv are still
 *  allowed as literal args because there is NO shell — they are passed verbatim. */
export function validateTaskVerifyConfig(input: unknown): VerifyConfigValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'not_object', message: 'verify must be an object { argv: string[] }' }
  const o = input as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'argv') return { ok: false, code: 'unknown_field', message: `unknown verify field: ${k}` }
  const argv = o.argv
  if (!Array.isArray(argv)) return { ok: false, code: 'bad_argv', message: 'verify.argv must be an array of strings' }
  if (argv.length === 0) return { ok: false, code: 'empty_argv', message: 'verify.argv must have at least one element (the program)' }
  if (argv.length > MAX_VERIFY_ARGV_ITEMS) return { ok: false, code: 'argv_too_long', message: `verify.argv may have at most ${MAX_VERIFY_ARGV_ITEMS} elements` }
  for (const a of argv) {
    if (typeof a !== 'string') return { ok: false, code: 'argv_item_not_string', message: 'every verify.argv element must be a string' }
    if (byteLen(a) > MAX_VERIFY_ARGV_ITEM_LEN) return { ok: false, code: 'argv_item_too_long', message: 'a verify.argv element exceeds the size limit' }
  }
  return { ok: true, value: { argv: [...(argv as string[])] } }
}

/** Deterministic content hash of the bounded verifier output (sha256 hex). */
export function computeVerificationContentHash(output: string): string {
  return crypto.createHash('sha256').update(output, 'utf8').digest('hex')
}

export interface BuildVerificationInput {
  argv: string[]
  exitCode: number
  startedAt: string
  finishedAt: string
  /** The bounded captured stdout+stderr; the hash is computed over it. */
  output: string
}

/** Build the durable verification record. `kind` is derived SOLELY from the exit
 *  code (0 ⇒ tests_passed, else tests_failed) — never from the output text. */
export function buildTaskVerification(input: BuildVerificationInput): TaskVerificationV1 {
  return {
    schema_version: '1',
    kind: input.exitCode === 0 ? 'tests_passed' : 'tests_failed',
    argv: [...input.argv],
    exit_code: input.exitCode,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    content_hash: computeVerificationContentHash(input.output),
  }
}

export type VerificationValidation =
  | { ok: true; value: TaskVerificationV1 }
  | { ok: false; code: 'invalid_verification' | 'unsupported_schema_version'; message: string }

/** Validate a parsed/persisted verification record (untrusted). A newer schema
 *  version fails CLOSED. `kind` must be consistent with `exit_code`. */
export function validateTaskVerification(obj: unknown): VerificationValidation {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: 'invalid_verification', message: 'verification must be a JSON object' }
  const o = obj as Record<string, unknown>
  if (o.schema_version !== TASK_VERIFICATION_SCHEMA_VERSION) {
    if (typeof o.schema_version === 'string' && o.schema_version > TASK_VERIFICATION_SCHEMA_VERSION) return { ok: false, code: 'unsupported_schema_version', message: `unsupported verification schema_version ${o.schema_version}` }
    return { ok: false, code: 'invalid_verification', message: 'invalid verification schema_version' }
  }
  if (o.kind !== 'tests_passed' && o.kind !== 'tests_failed') return { ok: false, code: 'invalid_verification', message: 'verification.kind must be tests_passed | tests_failed' }
  if (typeof o.exit_code !== 'number' || !Number.isInteger(o.exit_code)) return { ok: false, code: 'invalid_verification', message: 'verification.exit_code must be an integer' }
  // kind is a pure function of exit_code — reject any record where they disagree.
  if ((o.exit_code === 0) !== (o.kind === 'tests_passed')) return { ok: false, code: 'invalid_verification', message: 'verification.kind is inconsistent with exit_code' }
  const cfg = validateTaskVerifyConfig({ argv: o.argv })
  if (!cfg.ok) return { ok: false, code: 'invalid_verification', message: `verification.argv invalid: ${cfg.message}` }
  if (typeof o.started_at !== 'string' || !ISO_UTC_RE.test(o.started_at)) return { ok: false, code: 'invalid_verification', message: 'verification.started_at must be ISO-8601 UTC' }
  if (typeof o.finished_at !== 'string' || !ISO_UTC_RE.test(o.finished_at)) return { ok: false, code: 'invalid_verification', message: 'verification.finished_at must be ISO-8601 UTC' }
  if (typeof o.content_hash !== 'string' || !HEX64_RE.test(o.content_hash)) return { ok: false, code: 'invalid_verification', message: 'verification.content_hash must be a sha256 hex digest' }
  return { ok: true, value: { schema_version: '1', kind: o.kind, argv: cfg.value.argv, exit_code: o.exit_code, started_at: o.started_at, finished_at: o.finished_at, content_hash: o.content_hash } }
}

/** The completion-policy view of a result's verification: true (passed), false
 *  (failed — a conflict), or null (no verification was run → not observed). This is
 *  the ONLY function the policy uses to learn about tests. */
export function verificationTestsResult(v: TaskVerificationV1 | null | undefined): boolean | null {
  if (!v) return null
  return v.kind === 'tests_passed'
}

/** Idempotency equality for two verification records. */
export function verificationsEquivalent(a: TaskVerificationV1 | null | undefined, b: TaskVerificationV1 | null | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.exit_code === b.exit_code && a.content_hash === b.content_hash && a.started_at === b.started_at && a.finished_at === b.finished_at && a.argv.length === b.argv.length && a.argv.every((x, i) => x === b.argv[i])
}
