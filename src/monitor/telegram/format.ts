/**
 * Pure message formatting — turns snapshots/changes into the short,
 * emoji-prefixed Telegram messages the user specified. No I/O: every function
 * here is a string transform, so message shape can be tested without a bot.
 */
import type {
  LinearSnapshot,
  MonitorState,
  NodeChange,
  NodeSnapshot,
  RelayChange,
  RelaySnapshot,
  RunChange,
  RunSnapshot,
  SymphonySnapshot,
} from './types.js'

const ONLINE = '🟢'
const OFFLINE = '🔴'
const ALERT = '⚠️'
const FAIL = '❌'
const OK = '✅'
const RUN = '🏃'
const DONE = '🏁'
const BLOCK = '🟡'

function shortId(id: string, length = 12): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`
}

// ── Node changes ─────────────────────────────────────────────────────────────

export function formatNodeChange(change: NodeChange): string {
  switch (change.kind) {
    case 'new_node':
      return [
        `${ONLINE} New node registered`,
        `name: ${change.node.name}`,
        `id: ${shortId(change.node.node_id)}`,
        `agents: ${change.node.agents.join(', ') || 'none'}`,
      ].join('\n')

    case 'status_change':
      if (change.to === 'online') {
        return [
          `${ONLINE} Node online`,
          `name: ${change.name}`,
          `id: ${shortId(change.node_id)}`,
        ].join('\n')
      }
      return [
        `${OFFLINE} Node offline`,
        `name: ${change.name}`,
        `id: ${shortId(change.node_id)}`,
        `last seen: ${change.last_seen ?? 'unknown'}`,
      ].join('\n')

    case 'active_runs_change':
      return [
        `${ALERT} Active runs changed`,
        `name: ${change.name}`,
        `id: ${shortId(change.node_id)}`,
        `${change.from} → ${change.to}`,
      ].join('\n')

    case 'agents_change':
      return [
        `${ALERT} Agents changed`,
        `name: ${change.name}`,
        `id: ${shortId(change.node_id)}`,
        `${change.from.join(', ') || 'none'} → ${change.to.join(', ') || 'none'}`,
      ].join('\n')
  }
}

// ── Run changes ──────────────────────────────────────────────────────────────

const RUN_CHANGE_HEADER: Record<RunChange['kind'], string> = {
  run_started: `${RUN} Run started`,
  run_completed: `${DONE} Run completed`,
  run_failed: `${FAIL} Run failed`,
  run_stopped: `${OFFLINE} Run stopped`,
  run_approval_required: `${BLOCK} Run needs approval`,
}

export function formatRunChange(change: RunChange): string {
  const lines = [
    RUN_CHANGE_HEADER[change.kind],
    `run: ${shortId(change.run.run_id)}`,
    `node: ${shortId(change.run.node_id)}`,
    `agent: ${change.run.agent}`,
  ]
  if (change.run.issue_id) lines.push(`issue: ${change.run.issue_id}`)
  return lines.join('\n')
}

// ── Relay changes ────────────────────────────────────────────────────────────

export function formatRelayChange(change: RelayChange): string {
  if (change.kind === 'relay_recovery') {
    return [`${OK} Relay recovered`, `relay: ${change.hostname}`].join('\n')
  }
  if (change.reason === 'auth_failed') {
    return [
      `${FAIL} Relay auth failed`,
      `relay: ${change.hostname}`,
      'action: check VIBE_RELAY_TOKEN env',
    ].join('\n')
  }
  return [
    `${FAIL} Relay unreachable`,
    `relay: ${change.hostname}`,
    'action: check VIBE_RELAY_URL / network',
  ].join('\n')
}

// ── On-demand command output ─────────────────────────────────────────────────

export function formatStatusSummary(state: MonitorState, relay: RelaySnapshot): string {
  const nodes = Object.values(state.nodes)
  const online = nodes.filter((n) => n.status === 'online').length
  const activeRuns = nodes.reduce((sum, n) => sum + n.active_runs, 0)
  const blockedRuns = Object.values(state.runs).filter((r) => r.approval_required).length

  const relayLine = relay.reachable && relay.authOk !== false
    ? `${OK} relay: ${relay.hostname} (ok)`
    : `${FAIL} relay: ${relay.hostname} (${relay.authOk === false ? 'auth failed' : 'unreachable'})`

  return [
    '📊 Status',
    relayLine,
    `nodes: ${online}/${nodes.length} online`,
    `active runs: ${activeRuns}`,
    `awaiting approval: ${blockedRuns}`,
    `updated: ${state.updated_at}`,
  ].join('\n')
}

export function formatNodesList(nodes: NodeSnapshot[]): string {
  if (nodes.length === 0) return '📡 Nodes\n(none registered)'

  const lines = nodes.map((n) => {
    const dot = n.status === 'online' ? ONLINE : OFFLINE
    return [
      `${dot} ${n.name} (${shortId(n.node_id)})`,
      `   agents: ${n.agents.join(', ') || 'none'} · active: ${n.active_runs} · last seen: ${n.last_seen ?? 'unknown'}`,
    ].join('\n')
  })

  return ['📡 Nodes', ...lines].join('\n')
}

export function formatRunsList(runs: RunSnapshot[], limit = 10): string {
  if (runs.length === 0) return '🗂 Runs\n(none found)'

  const statusEmoji: Record<RunSnapshot['status'], string> = {
    queued: '⏳',
    running: RUN,
    completed: DONE,
    failed: FAIL,
    stopped: OFFLINE,
    cancelled: OFFLINE,
    blocked: BLOCK,
  }

  const lines = runs.slice(0, limit).map((r) => {
    const issue = r.issue_id ? ` · issue: ${r.issue_id}` : ''
    return [
      `${statusEmoji[r.status]} ${shortId(r.run_id)} · ${r.status}`,
      `   node: ${shortId(r.node_id)} · agent: ${r.agent}${issue} · updated: ${r.updated_at}`,
    ].join('\n')
  })

  const suffix = runs.length > limit ? `\n…and ${runs.length - limit} more` : ''
  return ['🗂 Runs', ...lines].join('\n') + suffix
}

export function formatSymphonyStatus(snapshot: SymphonySnapshot | null): string {
  if (!snapshot) return '🎼 Symphony\n(SYMPHONY_WORKDIR not configured)'

  const tmux = snapshot.tmux_session_running ? `${OK} running` : `${OFFLINE} not running`
  const states = snapshot.active_states && snapshot.active_states.length > 0
    ? snapshot.active_states.join(', ')
    : 'unknown'

  return [
    '🎼 Symphony',
    `tmux session: ${tmux}`,
    `last log activity: ${snapshot.last_log_at ?? 'unknown'}`,
    `active states: ${states}`,
  ].join('\n')
}

export function formatLinearStatus(snapshot: LinearSnapshot | null): string {
  if (!snapshot) return '📋 Linear\n(unavailable — check LINEAR_API_KEY or network)'

  const lines = ['📋 Linear', `active issues: ${snapshot.active_count ?? 'unknown'}`]

  const section = (title: string, items: LinearSnapshot['human_review']) => {
    if (items.length === 0) return
    lines.push(`${title}:`)
    for (const issue of items) lines.push(`  ${issue.identifier} · ${issue.title} (${issue.state})`)
  }

  section('Human Review', snapshot.human_review)
  section('Merging', snapshot.merging)
  section('Recent JOZ', snapshot.recent_joz)

  return lines.join('\n')
}

export function formatHelp(): string {
  return [
    '🤖 Vibe Telegram Monitor — read-only status reporter',
    '',
    '/status — relay, node, and run summary',
    '/nodes — list known nodes and their state',
    '/runs — list recent runs',
    '/symphony — local Symphony workdir status (if configured)',
    '/linear — Linear issue summary (if configured)',
    '/help — this message',
    '',
    'This bot is strictly read-only: it cannot approve, deny, merge,',
    'start/stop runs, change Linear issues, or run shell commands.',
  ].join('\n')
}
