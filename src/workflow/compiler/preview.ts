/**
 * Deterministic, TRUSTED-CODE preview + policy summary for a validated WorkflowSpec.
 * Built entirely from the validated spec — never from LLM prose. The policy summary
 * captures the security-relevant surface (assignments, permissions, workspace,
 * limits, completion/stall policy, side effects) and is hashed so an approval binds
 * to exactly what was inspected.
 */
import type { WorkflowSpec, WorkflowAgentRole } from '../contract.js'

export interface RolePlacement { role: string; agent: string; node_id: string | null }
export interface PolicySummary {
  roles: RolePlacement[]
  permissions: Array<{ step: string; role: string; permission_mode: string }>
  workspace_access: Array<{ step: string; role: string; node_id: string | null }>
  network_capable: boolean
  limits: { max_tasks: number; max_runtime_seconds: number; max_rounds: number | null; max_step_attempts: number; max_failures: number }
  completion_policy: unknown | null
  requires_verified_tests: boolean
  stall_policy: unknown | null
  external_side_effect_warnings: string[]
}

export interface WorkflowPreview {
  name: string
  /** The declared entry step id — the authoritative start of the graph (additive). */
  entry_step: string
  policy_summary: PolicySummary
  steps: Array<{ id: string; role: string | null; agent: string | null; node_id: string | null; workspace: boolean; workspace_write: boolean; verify: string | null; permission_mode: string | null; pause: string | null }>
  edges: Array<{ from: string; to: string; kind: string; loop: boolean; terminal: boolean; cond: string | null }>
  loop_edges: number
  terminal_routes: string[]
  graph_text: string
}

/** The trusted policy summary — the security-relevant surface only. */
export function buildPolicySummary(spec: WorkflowSpec): PolicySummary {
  const roles: RolePlacement[] = Object.entries(spec.agents as Record<string, WorkflowAgentRole>).map(([role, r]) => ({ role, agent: r.agent, node_id: r.node_id ?? null }))
  const permissions: PolicySummary['permissions'] = []
  const workspace_access: PolicySummary['workspace_access'] = []
  const warnings = new Set<string>()
  for (const step of spec.steps) {
    const s = step as { id: string; agent_role?: string; permission_mode?: string; workspace_key_template?: string }
    const role = s.agent_role ? (spec.agents as Record<string, WorkflowAgentRole>)[s.agent_role] : undefined
    if (s.permission_mode) {
      permissions.push({ step: s.id, role: s.agent_role ?? '', permission_mode: s.permission_mode })
      if (s.permission_mode === 'unsafe-skip') warnings.add(`step "${s.id}" runs with unsafe-skip permissions (bypasses approval prompts)`)
    }
    if (s.workspace_key_template !== undefined) {
      workspace_access.push({ step: s.id, role: s.agent_role ?? '', node_id: role?.node_id ?? null })
      warnings.add(`step "${s.id}" writes a Node workspace (${role?.node_id ?? 'unrouted'})`)
    }
  }
  const cp = spec.completion_policy ?? null
  return {
    roles, permissions, workspace_access,
    network_capable: false, // v1 workflow steps have no network/HTTP capability
    limits: { max_tasks: spec.limits.max_tasks, max_runtime_seconds: spec.limits.max_runtime_seconds, max_rounds: spec.limits.max_rounds ?? null, max_step_attempts: spec.limits.max_step_attempts, max_failures: spec.limits.max_failures },
    completion_policy: cp,
    requires_verified_tests: !!(cp && typeof cp === 'object' && (cp as { require_tests_passed?: unknown }).require_tests_passed === true),
    stall_policy: spec.stall_policy ?? null,
    external_side_effect_warnings: [...warnings].sort(),
  }
}

/** The full deterministic preview (policy summary + steps + edges + a text graph). */
export function buildPreview(spec: WorkflowSpec): WorkflowPreview {
  const summary = buildPolicySummary(spec)
  const steps = spec.steps.map((step) => {
    const s = step as { id: string; agent_role?: string; permission_mode?: string; workspace_key_template?: string; workspace_write?: boolean; verify?: { profile?: string }; pause_before?: { kind?: string } }
    const role = s.agent_role ? (spec.agents as Record<string, WorkflowAgentRole>)[s.agent_role] : undefined
    return { id: s.id, role: s.agent_role ?? null, agent: role?.agent ?? null, node_id: role?.node_id ?? null, workspace: s.workspace_key_template !== undefined, workspace_write: s.workspace_write === true, verify: s.verify?.profile ?? null, permission_mode: s.permission_mode ?? null, pause: s.pause_before?.kind ?? null }
  })
  const edges = spec.edges.map((e) => {
    const ce = e as { from: string; to: string; kind: string; condition?: { path?: string; op?: string; value?: unknown } }
    const c = ce.condition
    const cond = c && typeof c.path === 'string' ? `${c.path} ${c.op ?? ''} ${c.value !== undefined ? JSON.stringify(c.value) : ''}`.trim() : null
    return { from: e.from, to: e.to, kind: e.kind, loop: e.kind === 'loop', terminal: e.to.startsWith('$'), cond }
  })
  const terminal_routes = [...new Set(edges.filter((e) => e.terminal).map((e) => e.to))].sort()
  const lines: string[] = [`workflow ${spec.name} (entry: ${spec.entry_step})`]
  for (const st of steps) lines.push(`  step ${st.id}: ${st.agent ?? '—'}${st.node_id ? '@' + st.node_id : ''}${st.workspace ? ' [workspace]' : ''}${st.permission_mode ? ' perm=' + st.permission_mode : ''}${st.pause ? ' pause=' + st.pause : ''}`)
  for (const e of edges) lines.push(`  edge ${e.from} -${e.loop ? 'loop→' : '→'} ${e.to}`)
  lines.push(`  limits: tasks≤${summary.limits.max_tasks} runtime≤${summary.limits.max_runtime_seconds}s rounds≤${summary.limits.max_rounds ?? '—'}`)
  lines.push(`  completion_policy: ${summary.completion_policy ? JSON.stringify(summary.completion_policy) : 'none'}  stall_policy: ${summary.stall_policy ? JSON.stringify(summary.stall_policy) : 'none'}`)
  if (summary.external_side_effect_warnings.length) lines.push(`  warnings: ${summary.external_side_effect_warnings.join('; ')}`)
  return { name: spec.name, entry_step: spec.entry_step, policy_summary: summary, steps, edges, loop_edges: edges.filter((e) => e.loop).length, terminal_routes, graph_text: lines.join('\n') }
}
