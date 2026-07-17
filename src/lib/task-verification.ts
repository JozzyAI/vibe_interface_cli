/**
 * Durable, Harness-owned **task verification** contract (PURE).
 *
 * A verification is a TRUSTED, Node-policy-owned test command executed by the
 * Node/Harness AFTER the Agent process exits and BEFORE the AgentTaskResult is
 * finalized. Its outcome is the ONLY authoritative source of `tests_passed` /
 * `tests_failed` evidence for the completion policy. It is NEVER inferred from the
 * Agent's JSON, `tests_run`, logs, or prose.
 *
 * SECURITY SHAPE OF THE CONFIG: a workflow step selects a verifier by an opaque
 * PROFILE ID only (e.g. `node-test`). It CANNOT supply an argv, an interpreter,
 * arguments, a cwd, env, or a shell. The Node owns the exact executable+argv for
 * each profile (see `src/runtime/verifier-profiles.ts`); the resolved command is
 * never taken from spec/LLM/user text. This module holds only types, bounds, and
 * total validators — no process execution and no profile→argv resolution.
 */
import crypto from 'crypto'
import { isKnownVerifierProfile } from '../runtime/verifier-profiles.js'

export const TASK_VERIFICATION_SCHEMA_VERSION = '1'

/** Bounds — a verification record stays small. */
export const MAX_VERIFY_ARGV_ITEMS = 32
export const MAX_VERIFY_ARGV_ITEM_LEN = 4 * 1024
export const MAX_VERIFY_PROFILE_LEN = 128
/** Captured verifier stdout+stderr is bounded before hashing. */
export const MAX_VERIFY_OUTPUT_BYTES = 256 * 1024
/** Hard wall-clock cap for a verifier run, enforced by the runner. */
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const HEX64_RE = /^[0-9a-f]{64}$/
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

/** The verification CONFIG declared on a workflow step: ONLY an advertised profile
 *  ID. No argv/shell/cwd/env — the Node policy owns the command. */
export interface TaskVerifyConfig {
  profile: string
}

/** The two authoritative verification outcomes. */
export type VerificationKind = 'tests_passed' | 'tests_failed'

/** The durable, structured verification evidence embedded in the AgentTaskResult. */
export interface TaskVerificationV1 {
  schema_version: '1'
  kind: VerificationKind
  /** The selected profile ID (Node-owned command was resolved from this). */
  profile: string
  /** The exact argv the Node resolved + executed (safe + bounded: it is policy-owned,
   *  never user/LLM text). Echoed for audit; never re-parsed. */
  argv: string[]
  /** sha256 of the canonicalized resolved argv — proves WHICH command ran. */
  resolved_command_hash: string
  /** The verifier process exit code (0 => tests_passed). */
  exit_code: number
  started_at: string
  finished_at: string
  /** sha256 hex of the bounded captured stdout+stderr. DELIBERATELY not parsed:
   *  success is decided by the exit code, never by scraping this output. */
  content_hash: string
}

export type VerifyConfigValidation =
  | { ok: true; value: TaskVerifyConfig }
  | { ok: false; code: 'not_object' | 'missing_profile' | 'bad_profile' | 'unknown_profile' | 'unknown_field'; message: string }

/**
 * Validate an untrusted verifier config: an object with ONLY a `profile` string that
 * names an advertised, Node-owned profile. A raw `argv` (or any other field) is
 * REJECTED — a spec can never supply a command.
 */
export function validateTaskVerifyConfig(input: unknown): VerifyConfigValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'not_object', message: 'verify must be an object { profile: string }' }
  const o = input as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'profile') return { ok: false, code: 'unknown_field', message: `unknown verify field: ${k} (only "profile" is allowed; raw argv/commands are not permitted)` }
  if (o.profile === undefined) return { ok: false, code: 'missing_profile', message: 'verify.profile is required' }
  if (typeof o.profile !== 'string' || o.profile.length > MAX_VERIFY_PROFILE_LEN || !PROFILE_ID_RE.test(o.profile)) return { ok: false, code: 'bad_profile', message: 'verify.profile must be a short lowercase profile id' }
  if (!isKnownVerifierProfile(o.profile)) return { ok: false, code: 'unknown_profile', message: `verify.profile is not an advertised profile: ${o.profile}` }
  return { ok: true, value: { profile: o.profile } }
}

/** Deterministic content hash of the bounded verifier output (sha256 hex). */
export function computeVerificationContentHash(output: string): string {
  return crypto.createHash('sha256').update(output, 'utf8').digest('hex')
}

/** Deterministic hash of the resolved argv (sha256 hex of a canonical JSON array). */
export function computeResolvedCommandHash(argv: readonly string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify([...argv]), 'utf8').digest('hex')
}

export interface BuildVerificationInput {
  profile: string
  argv: readonly string[]
  exitCode: number
  startedAt: string
  finishedAt: string
  /** The bounded captured stdout+stderr; the hash is computed over it. */
  output: string
}

/** Build the durable verification record. `kind` is derived SOLELY from the exit
 *  code (0 => tests_passed) — never from the output text. */
export function buildTaskVerification(input: BuildVerificationInput): TaskVerificationV1 {
  return {
    schema_version: '1',
    kind: input.exitCode === 0 ? 'tests_passed' : 'tests_failed',
    profile: input.profile,
    argv: [...input.argv],
    resolved_command_hash: computeResolvedCommandHash(input.argv),
    exit_code: input.exitCode,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    content_hash: computeVerificationContentHash(input.output),
  }
}

export type VerificationValidation =
  | { ok: true; value: TaskVerificationV1 }
  | { ok: false; code: 'invalid_verification' | 'unsupported_schema_version'; message: string }

/** Validate a parsed/persisted verification record (untrusted). Newer schema fails
 *  closed. `kind` must agree with `exit_code`; the resolved-command hash must match
 *  the recorded argv; the profile must still be advertised. */
export function validateTaskVerification(obj: unknown): VerificationValidation {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: 'invalid_verification', message: 'verification must be a JSON object' }
  const o = obj as Record<string, unknown>
  if (o.schema_version !== TASK_VERIFICATION_SCHEMA_VERSION) {
    if (typeof o.schema_version === 'string' && o.schema_version > TASK_VERIFICATION_SCHEMA_VERSION) return { ok: false, code: 'unsupported_schema_version', message: `unsupported verification schema_version ${o.schema_version}` }
    return { ok: false, code: 'invalid_verification', message: 'invalid verification schema_version' }
  }
  if (o.kind !== 'tests_passed' && o.kind !== 'tests_failed') return { ok: false, code: 'invalid_verification', message: 'verification.kind must be tests_passed | tests_failed' }
  if (typeof o.exit_code !== 'number' || !Number.isInteger(o.exit_code)) return { ok: false, code: 'invalid_verification', message: 'verification.exit_code must be an integer' }
  if ((o.exit_code === 0) !== (o.kind === 'tests_passed')) return { ok: false, code: 'invalid_verification', message: 'verification.kind is inconsistent with exit_code' }
  if (typeof o.profile !== 'string' || !PROFILE_ID_RE.test(o.profile) || !isKnownVerifierProfile(o.profile)) return { ok: false, code: 'invalid_verification', message: 'verification.profile must be an advertised profile id' }
  if (!Array.isArray(o.argv) || o.argv.length === 0 || o.argv.length > MAX_VERIFY_ARGV_ITEMS || !o.argv.every((a) => typeof a === 'string' && byteLen(a) <= MAX_VERIFY_ARGV_ITEM_LEN)) return { ok: false, code: 'invalid_verification', message: 'verification.argv must be a bounded array of strings' }
  if (typeof o.resolved_command_hash !== 'string' || !HEX64_RE.test(o.resolved_command_hash) || o.resolved_command_hash !== computeResolvedCommandHash(o.argv as string[])) return { ok: false, code: 'invalid_verification', message: 'verification.resolved_command_hash must match argv' }
  if (typeof o.started_at !== 'string' || !ISO_UTC_RE.test(o.started_at)) return { ok: false, code: 'invalid_verification', message: 'verification.started_at must be ISO-8601 UTC' }
  if (typeof o.finished_at !== 'string' || !ISO_UTC_RE.test(o.finished_at)) return { ok: false, code: 'invalid_verification', message: 'verification.finished_at must be ISO-8601 UTC' }
  if (typeof o.content_hash !== 'string' || !HEX64_RE.test(o.content_hash)) return { ok: false, code: 'invalid_verification', message: 'verification.content_hash must be a sha256 hex digest' }
  return { ok: true, value: { schema_version: '1', kind: o.kind, profile: o.profile, argv: [...(o.argv as string[])], resolved_command_hash: o.resolved_command_hash, exit_code: o.exit_code, started_at: o.started_at, finished_at: o.finished_at, content_hash: o.content_hash } }
}

/** The completion-policy view: true (passed), false (failed — a conflict), or null
 *  (no verification observed). The ONLY function the policy uses to learn about tests. */
export function verificationTestsResult(v: TaskVerificationV1 | null | undefined): boolean | null {
  if (!v) return null
  return v.kind === 'tests_passed'
}

/** Idempotency equality for two verification records. */
export function verificationsEquivalent(a: TaskVerificationV1 | null | undefined, b: TaskVerificationV1 | null | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.profile === b.profile && a.exit_code === b.exit_code && a.content_hash === b.content_hash && a.resolved_command_hash === b.resolved_command_hash && a.started_at === b.started_at && a.finished_at === b.finished_at && a.argv.length === b.argv.length && a.argv.every((x, i) => x === b.argv[i])
}
