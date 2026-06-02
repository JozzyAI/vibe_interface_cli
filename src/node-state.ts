/**
 * Daemon state file — ~/.vibe/node-local.json (or VIBE_NODE_STATE_FILE override).
 *
 * All reads and writes go through this module. The VIBE_NODE_STATE_FILE env
 * var allows tests to point at a temp path without touching the live file.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { NodeDaemonState, VibeNode } from './types.js'

const VIBE_DIR = path.join(os.homedir(), '.vibe')

export function getDaemonStatePath(): string {
  return process.env.VIBE_NODE_STATE_FILE ?? path.join(VIBE_DIR, 'node-local.json')
}

export function getHeartbeatMs(): number {
  const v = parseInt(process.env.VIBE_NODE_HEARTBEAT_MS ?? '', 10)
  return isNaN(v) || v <= 0 ? 5000 : v
}

export function getStaleMs(): number {
  const v = parseInt(process.env.VIBE_NODE_STALE_MS ?? '', 10)
  return isNaN(v) || v <= 0 ? 15000 : v
}

export function readDaemonState(): NodeDaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(getDaemonStatePath(), 'utf8')) as NodeDaemonState
  } catch {
    return null
  }
}

export function writeDaemonState(state: NodeDaemonState): void {
  const p = getDaemonStatePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, p)
}

export function removeDaemonState(): void {
  try { fs.unlinkSync(getDaemonStatePath()) } catch {}
}

export function isDaemonFresh(state: NodeDaemonState): boolean {
  return Date.now() - new Date(state.last_heartbeat_at).getTime() < getStaleMs()
}

/** Map a NodeDaemonState to the public VibeNode shape, marking stale daemons offline. */
export function daemonStateToNode(state: NodeDaemonState): VibeNode {
  return {
    node_id: state.node_id,
    name: state.name,
    status: isDaemonFresh(state) ? state.status : 'offline',
    transport: state.transport,
    capabilities: state.capabilities,
    agents: state.agents,
    active_runs: state.active_runs,
    max_runs: state.max_runs,
    workspace_roots: state.workspace_roots,
    created_at: state.started_at,
    updated_at: state.last_heartbeat_at,
  }
}
