/**
 * Local Vibe Node daemon.
 *
 * Two modes:
 *   - Local file mode (default): writes heartbeat to ~/.vibe/node-local.json
 *   - Relay mode (--relay URL): connects to relay WS, sends heartbeats there
 *
 * Future: remote node daemons use the relay model exclusively.
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
import { resolveAgents } from './agent-registry.js'
import type { NodeDaemonState } from './types.js'

const RUNS_DIR = path.join(os.homedir(), '.vibe', 'runs')

export function countActiveRuns(): number {
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

export interface DaemonOpts {
  /** WebSocket relay URL (relay mode). If absent: local file mode. */
  relay?: string
  /** Auth token for relay. Required if relay is set. */
  token?: string
  /** Override node ID. Default: 'local' (file mode) or hostname (relay mode). */
  nodeId?: string
  /** Allowlist of agents to ADVERTISE to the relay (CLI --advertise-agent /
   *  VIBE_NODE_ADVERTISE_AGENTS). Relay mode only; does not affect local runs. */
  advertiseAgents?: string[]
}

export async function runLocalDaemon(opts: DaemonOpts = {}): Promise<void> {
  if (opts.relay) {
    const { relayNodeDaemon } = await import('./relay/client.js')
    return relayNodeDaemon(opts.relay, opts.token ?? '', opts.nodeId, undefined, opts.advertiseAgents)
  }
  return runFileModeDaemon(opts.nodeId)
}

async function runFileModeDaemon(nodeIdOverride?: string): Promise<void> {
  const config = resolveConfig()
  const heartbeatMs = getHeartbeatMs()
  const statePath = getDaemonStatePath()
  const now = new Date().toISOString()

  const state: NodeDaemonState = {
    node_id: nodeIdOverride ?? 'local',
    name: 'Local Machine',
    status: 'online',
    transport: 'local',
    capabilities: ['run', 'stream', 'stop', 'workspace'],
    agents: resolveAgents(),
    active_runs: countActiveRuns(),
    max_runs: 4,
    workspace_roots: [config.workspace_root],
    pid: process.pid,
    started_at: now,
    last_heartbeat_at: now,
  }

  writeDaemonState(state)

  process.stderr.write(
    `[vibe-node] daemon started — node_id=${state.node_id} pid=${process.pid}\n` +
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

  await new Promise<never>(() => {})
}
