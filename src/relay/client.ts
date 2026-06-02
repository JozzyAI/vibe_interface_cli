/**
 * Relay client helpers — used by `vibe node daemon --relay` and
 * `vibe node list --remote`.
 */
import os from 'os'
import fs from 'fs'
import path from 'path'
import { WebSocket } from 'ws'
import { resolveConfig } from '../config.js'
import { getHeartbeatMs } from '../node-state.js'
import type { VibeNode } from '../types.js'
import type { RelayMessage } from './types.js'

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
  } catch { return 0 }
}

export function deriveNodeId(override?: string): string {
  if (override) return override
  const h = os.hostname()
  return /^[a-zA-Z0-9][-a-zA-Z0-9.]{0,62}$/.test(h) ? h : 'local'
}

function relayUrl(base: string, token: string): string {
  const u = new URL(base)
  u.searchParams.set('token', token)
  return u.toString()
}

function sendMsg(ws: WebSocket, msg: RelayMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function t(): string { return new Date().toISOString() }

/** Connect to relay as a node daemon: register, send heartbeats, exit on signal/close. */
export async function relayNodeDaemon(
  relay: string,
  token: string,
  nodeIdOverride?: string,
): Promise<void> {
  const config = resolveConfig()
  const heartbeatMs = getHeartbeatMs()
  const nodeId = deriveNodeId(nodeIdOverride)

  const node: VibeNode = {
    node_id: nodeId,
    name: os.hostname(),
    status: 'online',
    transport: 'relay',
    capabilities: ['run', 'stream', 'stop', 'workspace'],
    agents: ['mock', 'claude-code'],
    active_runs: 0,
    max_runs: 4,
    workspace_roots: [config.workspace_root],
    created_at: t(),
    updated_at: t(),
  }

  process.stderr.write(`[vibe-node] connecting to relay: ${relay}\n`)
  const ws = new WebSocket(relayUrl(relay, token))

  let timer: ReturnType<typeof setInterval> | null = null

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      err ? reject(err) : resolve()
    }

    ws.on('open', () => {
      process.stderr.write(`[vibe-node] connected — registering node_id=${nodeId}\n`)
      sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'node_register', node })

      timer = setInterval(() => {
        sendMsg(ws, {
          version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
          type: 'node_heartbeat', node_id: nodeId,
          active_runs: countActiveRuns(), last_heartbeat_at: t(),
        })
      }, heartbeatMs)
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'node_register_ack') {
          process.stderr.write(`[vibe-node] registered ✓ node_id=${(msg as any).node_id}\n`)
          process.stderr.write(`[vibe-node] heartbeat every ${heartbeatMs}ms — Ctrl-C to stop\n`)
        } else if (msg.type === 'relay_error') {
          process.stderr.write(`[vibe-node] relay error: ${(msg as any).code} — ${(msg as any).message}\n`)
          ws.close()
          done(new Error((msg as any).message))
        }
      } catch {}
    })

    ws.on('close', () => {
      process.stderr.write('[vibe-node] relay connection closed\n')
      done()
    })

    ws.on('error', (err) => {
      process.stderr.write(`[vibe-node] connection error: ${err.message}\n`)
      done(err)
    })

    function shutdown(signal: string): void {
      process.stderr.write(`\n[vibe-node] received ${signal}, shutting down\n`)
      ws.close()
      setTimeout(() => process.exit(0), 300)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  })
}

/** One-shot: connect to relay, request node list, return nodes, disconnect. */
export async function fetchRemoteNodes(relay: string, token: string): Promise<VibeNode[]> {
  return new Promise<VibeNode[]>((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))

    let settled = false
    const done = (nodes?: VibeNode[], err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      nodes ? resolve(nodes) : reject(err!)
    }

    const timeout = setTimeout(() => {
      ws.terminate()
      done(undefined, new Error('Timeout waiting for node list from relay'))
    }, 10_000)

    ws.on('open', () => {
      sendMsg(ws, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(), type: 'node_list_request' })
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'node_list_response') {
          ws.close()
          done((msg as any).nodes)
        } else if (msg.type === 'relay_error') {
          ws.terminate()
          done(undefined, new Error(`${(msg as any).code}: ${(msg as any).message}`))
        }
      } catch {}
    })

    ws.on('close', () => done(undefined, new Error('Relay connection closed before response')))
    ws.on('error', (err) => done(undefined, err))
  })
}
