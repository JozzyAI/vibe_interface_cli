/**
 * Pure diff functions — compare a previous snapshot to a freshly collected one
 * and describe what changed. No I/O, no formatting, no Telegram calls: this is
 * what makes "node status diff detection" etc. testable without mocks.
 */
import type {
  NodeChange,
  NodeSnapshot,
  RelayChange,
  RelaySnapshot,
  RunChange,
  RunSnapshot,
} from './types.js'

function sameAgents(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/**
 * Compare previous node snapshots (keyed by node_id) against the current
 * fetch. Detects: new nodes, online↔offline transitions, active_runs changes,
 * and agent-list changes. Nodes that disappear from the relay's response are
 * left as-is in state (the relay only reports nodes it currently knows about;
 * a vanished node looks identical to "still offline" from the client's view).
 */
export function diffNodes(previous: Record<string, NodeSnapshot>, current: NodeSnapshot[]): NodeChange[] {
  const changes: NodeChange[] = []

  for (const node of current) {
    const prior = previous[node.node_id]

    if (!prior) {
      changes.push({ kind: 'new_node', node })
      continue
    }

    if (prior.status !== node.status) {
      changes.push({
        kind: 'status_change',
        node_id: node.node_id,
        name: node.name,
        from: prior.status,
        to: node.status,
        last_seen: node.last_seen,
      })
    }

    if (prior.active_runs !== node.active_runs) {
      changes.push({
        kind: 'active_runs_change',
        node_id: node.node_id,
        name: node.name,
        from: prior.active_runs,
        to: node.active_runs,
      })
    }

    if (!sameAgents(prior.agents, node.agents)) {
      changes.push({
        kind: 'agents_change',
        node_id: node.node_id,
        name: node.name,
        from: prior.agents,
        to: node.agents,
      })
    }
  }

  return changes
}

const TERMINAL_CHANGE_KIND: Partial<Record<RunSnapshot['status'], RunChange['kind']>> = {
  completed: 'run_completed',
  failed: 'run_failed',
  stopped: 'run_stopped',
}

/**
 * Compare previous run snapshots (keyed by run_id) against the current read of
 * ~/.vibe/runs. Detects: a run starting (queued/blocked → running), a run
 * reaching a terminal state, and a run newly requiring approval (status
 * transitions to 'blocked' — the only signal RunRecord exposes for this).
 */
export function diffRuns(previous: Record<string, RunSnapshot>, current: RunSnapshot[]): RunChange[] {
  const changes: RunChange[] = []

  for (const run of current) {
    const prior = previous[run.run_id]
    if (!prior) continue // first observation — nothing to compare against yet
    if (prior.status === run.status) continue

    if (run.status === 'running' && prior.status !== 'running') {
      changes.push({ kind: 'run_started', run })
    } else if (run.status === 'blocked' && prior.status !== 'blocked') {
      changes.push({ kind: 'run_approval_required', run })
    } else {
      const kind = TERMINAL_CHANGE_KIND[run.status]
      if (kind) changes.push({ kind, run })
    }
  }

  return changes
}

/**
 * Compare previous and current relay snapshots. Fires once on the transition
 * into failure (not on every poll while still down) and once on recovery.
 */
export function diffRelay(previous: RelaySnapshot | null, current: RelaySnapshot): RelayChange | null {
  const wasHealthy = previous ? previous.reachable && previous.authOk !== false : true
  const isHealthy = current.reachable && current.authOk !== false

  if (wasHealthy && !isHealthy) {
    const reason = current.authOk === false ? 'auth_failed' : 'unreachable'
    return { kind: 'relay_failure', hostname: current.hostname, reason }
  }
  if (!wasHealthy && isHealthy) {
    return { kind: 'relay_recovery', hostname: current.hostname }
  }
  return null
}
