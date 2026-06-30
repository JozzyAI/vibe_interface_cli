/**
 * Readiness preflight for the remote run path (`vibe run doctor`).
 *
 * A read-only check an orchestrator runs before dispatching work: is the relay
 * reachable, is the token accepted, is the target node online, and (optionally)
 * does it advertise the requested agent? It starts/stops nothing.
 *
 * This module is pure (no relay/fs/process) so it is fully unit-testable: the
 * command layer performs the single `fetchRemoteNodes` round trip and feeds the
 * result (a node list, or a classified failure) into the builders here.
 *
 * The result is a NEW readiness envelope `{ ok, checks, code?, ts }` — distinct
 * from the #36 run-error envelope `{ error, code, message, run_id, ts }` — but it
 * REUSES the #36 stable {@link RunErrorCode} vocabulary for `code` so a caller
 * branches on the same code names it already knows from run failures.
 */
import type { VibeNode } from '../types.js'
import type { RunErrorCode } from './run-error.js'

export type ReadinessCheckName = 'relay' | 'auth' | 'node' | 'agent'

export interface ReadinessCheck {
  name: ReadinessCheckName
  ok: boolean
  /** Human-readable reason, present on a failed (and some skipped) checks. */
  detail?: string
}

export interface ReadinessReport {
  ok: boolean
  checks: ReadinessCheck[]
  /** Stable code for the first failing check; absent when ok. */
  code?: RunErrorCode
  ts: string
}

/**
 * Build a readiness report from a successfully fetched node list (so relay +
 * auth already passed). Evaluates the target node's online status and, when
 * `agent` is given, whether the node advertises it. The `agent` check is
 * included only when `agent` is provided. `code` is the code of the first
 * failing check, in order relay > auth > node > agent.
 */
export function evaluateNodeReadiness(
  nodes: VibeNode[],
  nodeId: string,
  agent?: string,
  ts: string = new Date().toISOString(),
): ReadinessReport {
  const checks: ReadinessCheck[] = [
    { name: 'relay', ok: true },
    { name: 'auth', ok: true },
  ]

  const node = nodes.find((n) => n.node_id === nodeId)
  const nodeOnline = Boolean(node) && node!.status === 'online'
  checks.push({
    name: 'node',
    ok: nodeOnline,
    ...(nodeOnline
      ? {}
      : { detail: node ? `node ${nodeId} is offline` : `node ${nodeId} is not registered on the relay` }),
  })

  if (agent !== undefined) {
    const advertised = nodeOnline && node!.agents.includes(agent)
    checks.push({
      name: 'agent',
      ok: advertised,
      ...(advertised
        ? {}
        : {
            detail: nodeOnline
              ? `node ${nodeId} does not advertise agent ${agent}`
              : `node ${nodeId} is not online — agent ${agent} advertisement not verified`,
          }),
    })
  }

  return finalize(checks, ts)
}

/**
 * Build a readiness report when the relay round trip itself failed (relay
 * unreachable or token rejected) — node/agent cannot be evaluated, so only the
 * checks we have evidence for are included. `code` is the classified failure
 * (expected: `relay_unavailable` or `unauthorized`); `detail` is a token-free
 * message.
 */
export function relayFailureReport(
  code: RunErrorCode,
  detail: string,
  ts: string = new Date().toISOString(),
): ReadinessReport {
  const reachable = code !== 'relay_unavailable'
  const checks: ReadinessCheck[] = [
    { name: 'relay', ok: reachable, ...(reachable ? {} : { detail }) },
  ]
  // The relay accepted the connection but rejected the credential: report auth.
  if (reachable) checks.push({ name: 'auth', ok: false, detail })
  return { ok: false, checks, code, ts }
}

/** Map an ordered check list to overall ok + the first failing check's code. */
function finalize(checks: ReadinessCheck[], ts: string): ReadinessReport {
  const failed = checks.find((c) => !c.ok)
  const ok = failed === undefined
  return {
    ok,
    checks,
    ...(ok ? {} : { code: codeForCheck(failed!.name) }),
    ts,
  }
}

/** Stable RunErrorCode for a failing check name (reusing the #36 vocabulary). */
function codeForCheck(name: ReadinessCheckName): RunErrorCode {
  switch (name) {
    case 'relay': return 'relay_unavailable'
    case 'auth': return 'unauthorized'
    case 'node': return 'node_offline'
    case 'agent': return 'agent_not_supported'
  }
}
