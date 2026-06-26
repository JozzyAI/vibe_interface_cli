import { execSync } from 'child_process'
import type { AgentBackend } from './types.js'

/** Every agent backend the runtime knows about — the validation universe for
 *  the advertise allowlist. */
const KNOWN_AGENTS: AgentBackend[] = ['mock', 'claude-code', 'codex', 'opencode']

/** Thrown by resolveAdvertisedAgents on an invalid or empty allowlist. Carries a
 *  structured `code` so callers can emit a machine-readable error and exit. */
export class AdvertiseAllowlistError extends Error {
  readonly code: 'advertise_allowlist_empty' | 'advertise_agent_invalid'
  readonly invalid?: string[]
  constructor(code: 'advertise_allowlist_empty' | 'advertise_agent_invalid', message: string, invalid?: string[]) {
    super(message)
    this.name = 'AdvertiseAllowlistError'
    this.code = code
    this.invalid = invalid
  }
}

/** Split a repeatable / comma / space separated allowlist into trimmed tokens. */
function parseAdvertiseList(input: string[] | string): string[] {
  const raw = Array.isArray(input) ? input : [input]
  return raw
    .flatMap((s) => s.split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean)
}

export function binaryExists(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Returns the list of agent backends this node should advertise.
 * Always includes mock and claude-code.
 * Includes codex only when VIBE_ENABLE_CODEX=1 and the codex binary is in PATH.
 */
export function resolveAgents(): string[] {
  const agents: string[] = ['mock', 'claude-code']

  if (process.env.VIBE_ENABLE_CODEX === '1') {
    if (binaryExists('codex')) {
      agents.push('codex')
    } else {
      process.stderr.write(
        '[vibe-node] VIBE_ENABLE_CODEX=1 but codex binary not found in PATH — codex agent will NOT be advertised\n',
      )
    }
  }

  return agents
}

/**
 * Resolve the agent list this node ADVERTISES to a relay.
 *
 * This is a safety valve, separate from {@link resolveAgents} (which decides
 * what the node can actually RUN). When an allowlist is configured — via the
 * `allowlist` argument (CLI `--advertise-agent`) or the
 * `VIBE_NODE_ADVERTISE_AGENTS` env — the node publishes EXACTLY that set to the
 * relay, so a production orchestrator can only dispatch those agents to it
 * (e.g. set it to `mock` before a live-relay smoke so no paid claude-code job
 * can ever be assigned). It does NOT change which agents the node can run
 * locally; only the advertised payload.
 *
 * Precedence: explicit `allowlist` arg > `VIBE_NODE_ADVERTISE_AGENTS` env >
 * default. When neither is set, behaviour is identical to `resolveAgents()`.
 *
 * @throws {AdvertiseAllowlistError} when the configured allowlist is empty
 *   (`advertise_allowlist_empty`) or contains an unknown agent name
 *   (`advertise_agent_invalid`).
 */
export function resolveAdvertisedAgents(allowlist?: string[] | string): string[] {
  const source = allowlist ?? process.env.VIBE_NODE_ADVERTISE_AGENTS
  // Unset → unchanged default behaviour.
  if (source === undefined) return resolveAgents()

  const requested = parseAdvertiseList(source)
  if (requested.length === 0) {
    throw new AdvertiseAllowlistError(
      'advertise_allowlist_empty',
      'Advertise allowlist is empty: set VIBE_NODE_ADVERTISE_AGENTS or --advertise-agent to at least one agent (e.g. "mock").',
    )
  }

  const invalid = requested.filter((a) => !(KNOWN_AGENTS as string[]).includes(a))
  if (invalid.length > 0) {
    throw new AdvertiseAllowlistError(
      'advertise_agent_invalid',
      `Unknown advertise agent(s): ${invalid.join(', ')}. Valid agents: ${KNOWN_AGENTS.join(', ')}.`,
      invalid,
    )
  }

  // De-dupe while preserving the configured order.
  return [...new Set(requested)]
}
