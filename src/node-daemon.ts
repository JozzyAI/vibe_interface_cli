/**
 * Local Vibe Node daemon.
 *
 * Writes a heartbeat to the daemon state file every VIBE_NODE_HEARTBEAT_MS ms
 * (default 5000). Removed cleanly on SIGINT/SIGTERM.
 *
 * Future: remote node daemons will use the same lifecycle model but write
 * state via the relay rather than a local file.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveConfig } from './config.js'
import {
  getDaemonStatePath,
  getHeartbeatMs,
  writeDaemonState,
  removeDaemonState,
} from './node-state.js'
import type { NodeDaemonState } from './types.js'

const RUNS_DIR = path.join(os.homedir(), '.vibe', 'runs')

function countActiveRuns(): number {
  try {
    let count = 0
    for (const f of fs.readdirSync(RUNS_DIR)) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'))
        if (rec.status === 'running') count++
      } catch {}
    }
    return count
  } catch {
    return 0
  }
}

export async function runLocalDaemon(): Promise<void> {
  const config = resolveConfig()
  const heartbeatMs = getHeartbeatMs()
  const statePath = getDaemonStatePath()
  const now = new Date().toISOString()

  const state: NodeDaemonState = {
    node_id: 'local',
    name: 'Local Machine',
    status: 'online',
    transport: 'local',
    capabilities: ['run', 'stream', 'stop', 'workspace'],
    agents: ['mock', 'claude-code'],
    active_runs: countActiveRuns(),
    max_runs: 4,
    workspace_roots: [config.workspace_root],
    pid: process.pid,
    started_at: now,
    last_heartbeat_at: now,
  }

  writeDaemonState(state)

  process.stderr.write(
    `[vibe-node] daemon started — node_id=local pid=${process.pid}\n` +
    `[vibe-node] state: ${statePath}\n` +
    `[vibe-node] heartbeat every ${heartbeatMs}ms — Ctrl-C to stop\n`,
  )

  const timer = setInterval(() => {
    state.last_heartbeat_at = new Date().toISOString()
    state.active_runs = countActiveRuns()
    writeDaemonState(state)
  }, heartbeatMs)

  function shutdown(signal: string): void {
    process.stderr.write(`\n[vibe-node] received ${signal}, shutting down\n`)
    clearInterval(timer)
    removeDaemonState()
    process.stderr.write('[vibe-node] state removed, exiting\n')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Keep the process alive until a signal arrives.
  await new Promise<never>(() => {})
}
