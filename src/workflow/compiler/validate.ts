/**
 * Trusted validation of a compiler `status:ready` result. The compiler LLM is never
 * authoritative — every generated assignment, permission, workspace, and limit is
 * re-checked here against the existing WorkflowSpec validator, the inventory, and
 * system policy, and secret/credential-like fields are rejected.
 */
import { validateWorkflowSpec } from '../validator.js'
import { normalizeInputValues } from '../input-values.js'
import { isCompletableSpec } from '../completion-policy.js'
import type { WorkflowSpec, WorkflowAgentRole } from '../contract.js'
import { findPlacement, type Inventory } from './inventory.js'

/** Bounded, trusted system policy (caps + allowed modes). */
export interface SystemPolicy {
  max_tasks_cap: number
  max_runtime_cap_seconds: number
  max_rounds_cap: number
  allowed_permission_modes: string[]
}
export const DEFAULT_SYSTEM_POLICY: SystemPolicy = { max_tasks_cap: 200, max_runtime_cap_seconds: 21_600, max_rounds_cap: 50, allowed_permission_modes: ['default'] }

export interface ValidationIssue { code: string; message: string; path?: string }
export type CompilerValidation =
  | { ok: true; spec: WorkflowSpec; input_values: Record<string, unknown> }
  | { ok: false; issues: ValidationIssue[] }

const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key|bearer|access[_-]?key)/i

/** Recursively reject secret/credential-like FIELD NAMES (bounded depth). */
function scanSecrets(node: unknown, path: string, issues: ValidationIssue[], depth = 0): void {
  if (depth > 12 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((v, i) => scanSecrets(v, `${path}/${i}`, issues, depth + 1)); return }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) issues.push({ code: 'secret_field_rejected', message: `secret/credential-like field is not allowed: ${k}`, path: `${path}/${k}` })
    scanSecrets(v, `${path}/${k}`, issues, depth + 1)
  }
}

export function validateReady(specInput: unknown, inputValuesInput: unknown, inventory: Inventory, policy: SystemPolicy = DEFAULT_SYSTEM_POLICY): CompilerValidation {
  const issues: ValidationIssue[] = []
  // (10) secrets first — never let a credential-like field slip through even if other checks fail.
  scanSecrets(specInput, '/workflow_spec', issues)
  scanSecrets(inputValuesInput, '/input_values', issues)

  // (2) the existing WorkflowSpec validator is authoritative on structure.
  const v = validateWorkflowSpec(specInput)
  if (!v.valid) { for (const i of v.issues.filter((x) => x.severity === 'error').slice(0, 25)) issues.push({ code: i.code, message: i.message, path: i.path }); return { ok: false, issues } }
  const spec = specInput as WorkflowSpec

  // (3) input values normalize against the spec inputs.
  const norm = normalizeInputValues(spec, inputValuesInput)
  if (!norm.ok) { issues.push({ code: 'invalid_input_values', message: norm.message, ...(norm.name ? { path: `/input_values/${norm.name}` } : {}) }); return { ok: false, issues } }

  // (4-7) every role's placement is supported by the inventory + enforceable perms/workspace.
  const roles = spec.agents as Record<string, WorkflowAgentRole>
  const permByRole = new Map<string, Set<string>>()
  const wsByRole = new Set<string>()
  const verifyProfilesByRole = new Map<string, Set<string>>()
  for (const step of spec.steps) {
    const s = step as { agent_role?: string; permission_mode?: string; workspace_key_template?: string; verify?: { profile?: string } }
    if (s.agent_role) {
      if (s.permission_mode) { const set = permByRole.get(s.agent_role) ?? new Set(); set.add(s.permission_mode); permByRole.set(s.agent_role, set) }
      if (s.workspace_key_template !== undefined) wsByRole.add(s.agent_role)
      if (s.verify && typeof s.verify.profile === 'string') { const set = verifyProfilesByRole.get(s.agent_role) ?? new Set(); set.add(s.verify.profile); verifyProfilesByRole.set(s.agent_role, set) }
    }
  }
  for (const [roleName, role] of Object.entries(roles)) {
    const placement = findPlacement(inventory, role.agent, role.node_id)
    if (!placement) { issues.push({ code: 'agent_not_in_inventory', message: `agent "${role.agent}"${role.node_id ? ` on node ${role.node_id}` : ''} is not available in the inventory`, path: `/agents/${roleName}` }); continue }
    for (const mode of permByRole.get(roleName) ?? []) if (!placement.permission_modes.includes(mode) || !policy.allowed_permission_modes.includes(mode)) issues.push({ code: 'permission_not_enforceable', message: `permission_mode "${mode}" is not enforceable for role ${roleName}`, path: `/agents/${roleName}` })
    if (wsByRole.has(roleName) && !placement.workspace_supported) issues.push({ code: 'workspace_not_supported', message: `role ${roleName} requires a workspace but its placement does not support one`, path: `/agents/${roleName}` })
    // A verifier profile must be ADVERTISED by the placement's Node (i.e. the Node
    // can enforce the verifier sandbox). Node policy owns the command; the spec only
    // names a profile the Node already offers.
    const advertised = new Set(placement.verifier_profiles ?? [])
    for (const profile of verifyProfilesByRole.get(roleName) ?? []) if (!advertised.has(profile)) issues.push({ code: 'verifier_profile_not_advertised', message: `verifier profile "${profile}" is not advertised by the placement for role ${roleName} (the Node cannot enforce it)`, path: `/agents/${roleName}` })
  }

  // (8) enforce workflow limits + system policy caps.
  const lim = spec.limits
  if (lim.max_tasks > policy.max_tasks_cap) issues.push({ code: 'limit_exceeds_policy', message: `max_tasks ${lim.max_tasks} exceeds cap ${policy.max_tasks_cap}`, path: '/limits/max_tasks' })
  if (lim.max_runtime_seconds > policy.max_runtime_cap_seconds) issues.push({ code: 'limit_exceeds_policy', message: `max_runtime_seconds exceeds cap`, path: '/limits/max_runtime_seconds' })
  if ((lim.max_rounds ?? 0) > policy.max_rounds_cap) issues.push({ code: 'limit_exceeds_policy', message: `max_rounds exceeds cap`, path: '/limits/max_rounds' })

  // (9) a completable spec MUST declare a completion_policy (mirrors the runtime rule).
  if (isCompletableSpec(spec) && spec.completion_policy === undefined) issues.push({ code: 'completion_policy_required', message: 'a completable workflow must declare a completion_policy', path: '/completion_policy' })

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, spec, input_values: norm.values }
}
