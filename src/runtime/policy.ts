/**
 * Agent policy resolution.
 *
 * The CLI packs fallback configuration into `record.metadata.agent_policy`
 * (a plain, serializable shape that survives the relay to the detached
 * supervisor). `resolveAgentPolicy` turns that — plus the record's primary
 * `agent` — into a concrete AgentPolicy, applying v1 defaults. When no policy
 * metadata is present the result has no fallbacks, so behaviour is identical to
 * today (full backward compatibility).
 */
import type { AgentBackend, RunRecord } from '../types.js'
import { DEFAULT_SWITCH_ON, type AgentPolicy, type FailureReason } from './types.js'

const KNOWN_AGENTS: AgentBackend[] = ['mock', 'claude-code', 'codex', 'opencode']

const KNOWN_REASONS: FailureReason[] = [
  'session_limit', 'usage_limit', 'quota_exceeded', 'rate_limited', 'context_limit', 'auth_expired',
  'tests_failed', 'merge_conflict', 'repo_not_found', 'permission_denied', 'unknown_repo', 'invalid_task',
]

/** Stored, serializable policy shape (lives in record.metadata.agent_policy). */
export interface AgentPolicyMetadata {
  fallbacks?: string[]
  switch_on?: string[]
  preserve_workspace?: boolean
  handoff_on_switch?: boolean
}

/** Split a repeatable/comma/space separated CLI list into trimmed tokens. */
export function parseList(input: string[] | string | undefined): string[] {
  if (!input) return []
  const raw = Array.isArray(input) ? input : [input]
  return raw
    .flatMap((s) => s.split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Build the metadata blob from parsed CLI options. Returns undefined when no
 * fallback was requested, so the run record stays byte-identical to today.
 */
export function buildAgentPolicyMetadata(opts: {
  fallbackAgents?: string[] | string
  switchOn?: string[] | string
  handoffOnFailure?: boolean
  preserveWorkspace?: boolean
}): AgentPolicyMetadata | undefined {
  const fallbacks = parseList(opts.fallbackAgents).filter((a): a is AgentBackend => KNOWN_AGENTS.includes(a as AgentBackend))
  if (fallbacks.length === 0) return undefined

  const switch_on = parseList(opts.switchOn).filter((r): r is FailureReason => KNOWN_REASONS.includes(r as FailureReason))

  return {
    fallbacks,
    ...(switch_on.length > 0 && { switch_on }),
    ...(opts.handoffOnFailure !== undefined && { handoff_on_switch: opts.handoffOnFailure }),
    ...(opts.preserveWorkspace !== undefined && { preserve_workspace: opts.preserveWorkspace }),
  }
}

/** Resolve the concrete policy the supervisor will follow for this run. */
export function resolveAgentPolicy(record: RunRecord): AgentPolicy {
  const meta = (record.metadata?.agent_policy ?? undefined) as AgentPolicyMetadata | undefined

  const fallbacks = (meta?.fallbacks ?? [])
    .filter((a): a is AgentBackend => KNOWN_AGENTS.includes(a as AgentBackend))

  const switchOn = (meta?.switch_on && meta.switch_on.length > 0)
    ? meta.switch_on.filter((r): r is FailureReason => KNOWN_REASONS.includes(r as FailureReason))
    : [...DEFAULT_SWITCH_ON]

  return {
    primary: record.agent,
    fallbacks,
    switchOn,
    // Default both on when a fallback is configured; harmless when no fallback exists.
    preserveWorkspace: meta?.preserve_workspace ?? true,
    handoffOnSwitch: meta?.handoff_on_switch ?? true,
  }
}
