/**
 * Deterministic canonicalization + hashing for the Workflow Compiler.
 *
 * A canonical hash is a SHA-256 over stable canonical JSON (object keys sorted
 * recursively; array order preserved). Two structurally-identical values hash the
 * same; ANY change to the spec / policy summary / inventory changes the hash. Hashes
 * bind an approval to the EXACT inspected artifacts.
 */
import crypto from 'crypto'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = canonicalize((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

/** Stable canonical JSON string (sorted keys). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** SHA-256 (hex) over the canonical JSON of `value`. */
export function canonicalHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
