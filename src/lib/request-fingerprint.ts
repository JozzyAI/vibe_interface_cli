/**
 * Deterministic fingerprint of a normalized, validated task-creation request.
 *
 * Idempotent task creation compares this fingerprint to detect a same-key request
 * whose EXECUTION SEMANTICS changed (→ conflict). It is a bounded cryptographic
 * digest over stable canonical JSON — NOT a second copy of the prompt, and it is
 * NEVER logged. The canonical input (and thus the prompt text) is hashed and
 * discarded; only the hex digest is persisted.
 */
import crypto from 'crypto'
import type { CreateTaskRequest } from './agent-task-contract.js'

/** Stable canonical form: object keys sorted recursively; array order preserved.
 *  Guarantees two semantically-identical requests serialize byte-for-byte alike. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/**
 * SHA-256 (hex) over the normalized semantic request, EXCLUDING idempotency_key
 * itself. Includes every field that can change what actually executes: agent,
 * node_id, input.text, workspace.workspace_key, execution.permission_mode, and
 * metadata (metadata is accepted as part of the canonical request). Absent
 * optional fields normalize to `null` so `{}` and an omitted field agree.
 */
export function computeRequestFingerprint(req: CreateTaskRequest): string {
  const semantic = {
    agent: req.agent,
    node_id: req.node_id ?? null,
    input_text: req.input.text,
    workspace_key: req.workspace?.workspace_key ?? null,
    permission_mode: req.execution?.permission_mode ?? null,
    workspace_write: req.execution?.workspace_write ?? null,
    workspace_lease_id: req.workspace_lease_id ?? null,
    metadata: req.metadata ?? null,
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(semantic)), 'utf8').digest('hex')
}
