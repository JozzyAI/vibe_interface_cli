/**
 * Read-only collectors — gather runtime info from the relay, local Vibe state,
 * Symphony's workdir, and Linear. Nothing here writes, mutates, or controls
 * anything; every function only reads and returns plain snapshots.
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { vibeDir } from '../../config.js'
import { redactSecrets, relayHostname } from './secrets.js'
import type {
  LinearIssueSummary,
  LinearSnapshot,
  NodeSnapshot,
  RelaySnapshot,
  RunSnapshot,
  SymphonySnapshot,
} from './types.js'
import type { RunRecord, VibeNode } from '../../types.js'

// ── Relay + nodes (one connection serves both) ──────────────────────────────

export interface RelayPollResult {
  relay: RelaySnapshot
  /** null when the relay could not be reached/authenticated this poll — callers should keep prior node snapshots rather than wipe them */
  nodes: VibeNode[] | null
}

/**
 * Connect to the relay once, classify reachability/auth, and fetch the node
 * registry in the same round trip. fetchRemoteNodes throws on both connection
 * failures and auth failures (the dev relay rejects bad tokens at the HTTP
 * upgrade with 401, surfaced by `ws` as "Unexpected server response: 401"),
 * so we distinguish them by inspecting the (redacted) error message.
 */
export async function pollRelay(relayUrl: string, relayToken: string, now: () => string = () => new Date().toISOString()): Promise<RelayPollResult> {
  const hostname = relayHostname(relayUrl)

  try {
    const { fetchRemoteNodes } = await import('../../relay/client.js')
    const nodes = await fetchRemoteNodes(relayUrl, relayToken)
    return {
      relay: { reachable: true, authOk: true, hostname, last_success_at: now() },
      nodes,
    }
  } catch (err) {
    const message = redactSecrets((err as Error).message ?? String(err), [relayToken])
    const authFailed = /\b401\b|unauthorized|unexpected server response/i.test(message)
    return {
      relay: { reachable: authFailed, authOk: authFailed ? false : null, hostname, last_success_at: null },
      nodes: null,
    }
  }
}

export function nodeToSnapshot(node: VibeNode, previous: NodeSnapshot | undefined, now: string): NodeSnapshot {
  return {
    node_id: node.node_id,
    name: node.name,
    status: node.status,
    agents: [...node.agents].sort(),
    active_runs: node.active_runs,
    last_seen: node.status === 'online' ? now : (previous?.last_seen ?? null),
  }
}

// ── Local runs (~/.vibe/runs) ────────────────────────────────────────────────

function runRecordToSnapshot(record: RunRecord): RunSnapshot {
  const metadata = record.metadata ?? {}
  const issueId = typeof metadata.issue_id === 'string' ? metadata.issue_id : undefined
  return {
    run_id: record.run_id,
    status: record.status,
    node_id: record.node_id,
    agent: record.agent,
    repo_url: record.repo_url,
    issue_id: issueId,
    workspace_key: record.workspace_path ? path.basename(record.workspace_path) : undefined,
    created_at: record.created_at,
    updated_at: record.updated_at,
    approval_required: record.status === 'blocked',
  }
}

/** Read every run record from ~/.vibe/runs, most recently updated first. */
export function collectLocalRuns(limit = 30): RunSnapshot[] {
  const dir = path.join(vibeDir(), 'runs')
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const records: RunRecord[] = []
  for (const file of files) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as RunRecord)
    } catch {
      // skip unreadable/malformed run files
    }
  }

  records.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
  return records.slice(0, limit).map(runRecordToSnapshot)
}

// ── Symphony local status (optional — only when SYMPHONY_WORKDIR is set) ────

function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const LOG_CANDIDATES = ['log/symphony.log', 'log/symphony.log.1']
const WORKFLOW_CANDIDATES = ['WORKFLOW.md', 'elixir/WORKFLOW.md']

function findExisting(workdir: string, candidates: string[]): string | null {
  for (const rel of candidates) {
    const full = path.join(workdir, rel)
    if (fs.existsSync(full)) return full
  }
  return null
}

/**
 * Extract `tracker.active_states` from WORKFLOW.md's YAML front matter with a
 * small line-based scan — avoids pulling in a YAML parser for one list field.
 * Returns null if the shape isn't the expected "key:\n  - item" block.
 */
function parseActiveStates(workflowContent: string): string[] | null {
  const lines = workflowContent.split('\n')
  const headerIndex = lines.findIndex((line) => /^\s*active_states:\s*$/.test(line))
  if (headerIndex === -1) return null

  const states: string[] = []
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const match = lines[i].match(/^\s*-\s*(\S.*?)\s*$/)
    if (!match) break
    states.push(match[1])
  }
  return states.length > 0 ? states : null
}

export function collectSymphonyStatus(workdir: string): SymphonySnapshot {
  const tmuxRunning = tmuxSessionExists('symphony')

  let lastLogAt: string | null = null
  const logPath = findExisting(workdir, LOG_CANDIDATES)
  if (logPath) {
    try {
      lastLogAt = fs.statSync(logPath).mtime.toISOString()
    } catch {
      // unreadable — leave null
    }
  }

  let activeStates: string[] | null = null
  const workflowPath = findExisting(workdir, WORKFLOW_CANDIDATES)
  if (workflowPath) {
    try {
      activeStates = parseActiveStates(fs.readFileSync(workflowPath, 'utf8'))
    } catch {
      // unreadable — leave null
    }
  }

  return { tmux_session_running: tmuxRunning, last_log_at: lastLogAt, active_states: activeStates }
}

// ── Linear (optional — only when LINEAR_API_KEY is set) ─────────────────────

const LINEAR_ACTIVE_STATES = ['Todo', 'In Progress', 'Rework', 'Merging']

interface LinearIssueNode {
  identifier: string
  title: string
  state?: { name?: string } | null
}

interface LinearGraphQLResponse {
  data?: {
    active?: { totalCount?: number }
    humanReview?: { nodes?: LinearIssueNode[] }
    merging?: { nodes?: LinearIssueNode[] }
    recent?: { nodes?: LinearIssueNode[] }
  }
  errors?: Array<{ message: string }>
}

const LINEAR_QUERY = `
  query MonitorSnapshot($activeStates: [String!]!) {
    active: issues(filter: { state: { name: { in: $activeStates } } }) {
      totalCount
    }
    humanReview: issues(filter: { state: { name: { eq: "Human Review" } } }, first: 10) {
      nodes { identifier title state { name } }
    }
    merging: issues(filter: { state: { name: { eq: "Merging" } } }, first: 10) {
      nodes { identifier title state { name } }
    }
    recent: issues(filter: { identifier: { startsWith: "JOZ" } }, first: 5, orderBy: updatedAt) {
      nodes { identifier title state { name } }
    }
  }
`

function toIssueSummary(node: LinearIssueNode): LinearIssueSummary {
  return { identifier: node.identifier, title: node.title, state: node.state?.name ?? 'unknown' }
}

/** Lightweight Linear snapshot via a single GraphQL query. Read-only — no mutations are ever sent. */
export async function collectLinearStatus(apiKey: string): Promise<LinearSnapshot | null> {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query: LINEAR_QUERY, variables: { activeStates: LINEAR_ACTIVE_STATES } }),
    })
    if (!res.ok) return null

    const body = (await res.json()) as LinearGraphQLResponse
    if (!body.data || body.errors?.length) return null

    return {
      active_count: body.data.active?.totalCount ?? null,
      human_review: (body.data.humanReview?.nodes ?? []).map(toIssueSummary),
      merging: (body.data.merging?.nodes ?? []).map(toIssueSummary),
      recent_joz: (body.data.recent?.nodes ?? []).map(toIssueSummary),
    }
  } catch {
    return null
  }
}
