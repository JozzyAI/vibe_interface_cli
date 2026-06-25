/**
 * Runner router — picks which agent backend a run should use, distinct from
 * (and upstream of) the Meta-Agent Runtime's mid-run fallback in
 * `supervisor.ts`. The router decides *before* anything is spawned, based on
 * availability (binary present); the supervisor decides *during* a run,
 * based on a classified failure. They compose: the router's pick becomes the
 * policy's `primary`, and the supervisor's own `fallbacks` chain (if any)
 * still applies after that.
 */
import type { AgentBackend } from '../types.js'
import { binaryExists } from '../agent-registry.js'

/** Priority order `--agent auto` tries, highest first. `mock` is last so a
 *  real agent is always preferred when one is available. */
export const DEFAULT_RUNNER_PRIORITY: AgentBackend[] = ['claude-code', 'codex', 'opencode', 'mock']

/** The real CLI binary each backend spawns (used by `defaultAvailability`). */
const BACKEND_BINARY: Record<AgentBackend, string | undefined> = {
  mock: undefined, // always available — no external binary
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
}

export type RunnerAvailability = (agent: AgentBackend) => boolean

export type RouterResult =
  | { ok: true; agent: AgentBackend; tried: AgentBackend[] }
  | { ok: false; code: 'no_runner_available'; message: string; tried: AgentBackend[] }

/**
 * Resolve `requested` to a concrete backend.
 * - An explicit backend (not `'auto'`) is returned as-is, untried — the
 *   caller asked for it by name, so availability is the caller's problem
 *   (e.g. the existing `agent_not_supported` node-capability check).
 * - `'auto'` walks `priority` in order and returns the first available one.
 * - If none are available, returns a structured `no_runner_available` error
 *   listing every backend that was tried.
 */
export function selectRunner(
  requested: AgentBackend | 'auto',
  isAvailable: RunnerAvailability,
  priority: AgentBackend[] = DEFAULT_RUNNER_PRIORITY,
): RouterResult {
  if (requested !== 'auto') {
    return { ok: true, agent: requested, tried: [] }
  }

  const tried: AgentBackend[] = []
  for (const candidate of priority) {
    tried.push(candidate)
    if (isAvailable(candidate)) {
      return { ok: true, agent: candidate, tried }
    }
  }

  return {
    ok: false,
    code: 'no_runner_available',
    message: `no available runner in priority order [${priority.join(', ')}]`,
    tried,
  }
}

/** Production availability check: mock is always available; real backends
 *  need their CLI binary in PATH. No network/relay/Symphony calls. */
export function defaultAvailability(agent: AgentBackend): boolean {
  const binary = BACKEND_BINARY[agent]
  if (!binary) return true
  return binaryExists(binary)
}
