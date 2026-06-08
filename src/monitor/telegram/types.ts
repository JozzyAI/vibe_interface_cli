/**
 * Shared types for the read-only Telegram runtime monitor.
 *
 * Snapshots are the non-secret, persisted view of the world (written to
 * ~/.vibe/telegram-monitor-state.json and diffed across polls). Changes are
 * the pure output of diffing two snapshots — independent of how they are
 * formatted into Telegram messages, so diff logic and message formatting can
 * be tested in isolation.
 */
import type { AgentBackend, RunStatus } from '../../types.js'

// ── Snapshots ────────────────────────────────────────────────────────────────

export interface RelaySnapshot {
  reachable: boolean
  /** null = could not be determined (e.g. connection failed before auth was attempted) */
  authOk: boolean | null
  /** hostname only — never the relay URL's token/credentials */
  hostname: string
  last_success_at: string | null
}

export type NodeStatus = 'online' | 'offline'

export interface NodeSnapshot {
  node_id: string
  name: string
  status: NodeStatus
  agents: string[]
  active_runs: number
  /**
   * ISO timestamp of the last poll where this node was observed online.
   * Derived locally — the relay does not expose heartbeat history to clients,
   * so this is the most honest "last seen" signal available.
   */
  last_seen: string | null
}

export interface RunSnapshot {
  run_id: string
  status: RunStatus
  node_id: string
  agent: AgentBackend
  repo_url?: string
  issue_id?: string
  workspace_key?: string
  created_at: string
  updated_at: string
  approval_required: boolean
}

export interface MonitorState {
  version: 1
  relay: RelaySnapshot | null
  nodes: Record<string, NodeSnapshot>
  runs: Record<string, RunSnapshot>
  updated_at: string
}

// ── Optional collectors ──────────────────────────────────────────────────────

export interface SymphonySnapshot {
  tmux_session_running: boolean
  last_log_at: string | null
  active_states: string[] | null
}

export interface LinearIssueSummary {
  identifier: string
  title: string
  state: string
}

export interface LinearSnapshot {
  active_count: number | null
  human_review: LinearIssueSummary[]
  merging: LinearIssueSummary[]
  recent_joz: LinearIssueSummary[]
}

// ── Diff results ─────────────────────────────────────────────────────────────
//
// Pure descriptions of "what changed" — produced by diff.ts, consumed by
// format.ts. Keeping these separate from message strings is what makes both
// sides independently testable.

export type NodeChange =
  | { kind: 'new_node'; node: NodeSnapshot }
  | {
      kind: 'status_change'
      node_id: string
      name: string
      from: NodeStatus
      to: NodeStatus
      last_seen: string | null
    }
  | { kind: 'active_runs_change'; node_id: string; name: string; from: number; to: number }
  | { kind: 'agents_change'; node_id: string; name: string; from: string[]; to: string[] }

export type RunChangeKind =
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'run_stopped'
  | 'run_approval_required'

export interface RunChange {
  kind: RunChangeKind
  run: RunSnapshot
}

export type RelayChange =
  | { kind: 'relay_failure'; hostname: string; reason: 'unreachable' | 'auth_failed' }
  | { kind: 'relay_recovery'; hostname: string }
