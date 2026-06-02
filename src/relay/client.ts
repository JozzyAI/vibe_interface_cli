/**
 * Relay client helpers — used by `vibe node daemon --relay` and
 * `vibe node list --remote` and `vibe run start --node <remote>`.
 */
import os from 'os'
import fs from 'fs'
import path from 'path'
import { WebSocket } from 'ws'
import { resolveConfig, vibeDir } from '../config.js'
import { getHeartbeatMs } from '../node-state.js'
import { generateRunId, updateRun, writeRun } from '../store.js'
import { mockBackend } from '../backends/mock.js'
import { isTerminal } from '../types.js'
import type { AgentBackend, PermissionMode, RunEvent, RunRecord, VibeNode } from '../types.js'
import type { RelayMessage, RunStartMsg } from './types.js'

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

async function handleRunStart(ws: WebSocket, nodeId: string, config: ReturnType<typeof resolveConfig>, msg: RunStartMsg): Promise<void> {
  // Only mock is supported for remote execution. claude-code and others require 3D-2C+.
  if (msg.agent !== 'mock') {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_start_ack', req_id: msg.req_id, ok: false,
      error: `Remote agent not supported: ${msg.agent}. Only mock is available in relay mode.`,
      code: 'agent_not_supported',
    })
    return
  }

  const runId = generateRunId()
  const workspaceKey = msg.workspace_key ?? runId
  const workspacePath = path.join(config.workspace_root, workspaceKey)
  fs.mkdirSync(workspacePath, { recursive: true })

  const now = t()
  const record: RunRecord = {
    run_id: runId,
    session_id: '',
    node_id: nodeId,
    node_selector: nodeId,
    agent: msg.agent,
    status: 'queued',
    workspace_path: workspacePath,
    ...(msg.repo_url && { repo_url: msg.repo_url }),
    ...(msg.branch && { branch: msg.branch }),
    ...(msg.prompt_file && { prompt_file: msg.prompt_file }),
    ...(msg.permission_mode && { permission_mode: msg.permission_mode }),
    ...(msg.metadata && { metadata: msg.metadata }),
    created_at: now,
    updated_at: now,
  }
  writeRun(record)

  // Reuse the same local mock backend — spawns _mock-runner as a detached process.
  const result = await mockBackend.start(record, {})
  const runningRecord = updateRun(runId, { session_id: result.session_id, status: 'running' })

  sendMsg(ws, {
    version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
    type: 'run_start_ack', req_id: msg.req_id, ok: true, record: runningRecord,
  })

  // Tail the event log and forward each event to relay as run_event (background).
  tailRunEvents(ws, nodeId, runId).catch((err) => {
    process.stderr.write(`[vibe-node] event tail error for ${runId}: ${err.message}\n`)
  })
}

/**
 * Poll the run's JSONL event log and forward each new event to the relay as run_event.
 * Mirrors the `streamEvents` polling approach from events.ts.
 * Resolves after a terminal event or a 2-minute safety timeout.
 */
function tailRunEvents(ws: WebSocket, nodeId: string, runId: string): Promise<void> {
  const eventsFile = path.join(vibeDir(), 'events', `${runId}.jsonl`)
  let offset = 0

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setInterval>
    let safetyTimer: ReturnType<typeof setTimeout>

    const flush = (): boolean => {
      try {
        const stat = fs.statSync(eventsFile)
        if (stat.size <= offset) return false

        const fd = fs.openSync(eventsFile, 'r')
        const buf = Buffer.alloc(stat.size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        offset = stat.size

        const lines = buf.toString('utf8').split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as RunEvent
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
              type: 'run_event', run_id: runId, event,
            })
            if (isTerminal(event)) {
              clearInterval(timer)
              clearTimeout(safetyTimer)
              resolve()
              return true
            }
          } catch {}
        }
      } catch {}
      return false
    }

    if (flush()) return

    timer = setInterval(() => { if (flush()) clearInterval(timer) }, 250)
    safetyTimer = setTimeout(() => { clearInterval(timer); resolve() }, 120_000)
  })
}

/** Connect to relay as a node daemon: register, send heartbeats, handle run_start, exit on signal/close. */
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
          process.stderr.write(`[vibe-node] registered ✓ node_id=${msg.node_id}\n`)
          process.stderr.write(`[vibe-node] heartbeat every ${heartbeatMs}ms — Ctrl-C to stop\n`)
        } else if (msg.type === 'run_start') {
          const reqId = msg.req_id
          handleRunStart(ws, nodeId, config, msg).catch((err: Error) => {
            process.stderr.write(`[vibe-node] run_start error: ${err.message}\n`)
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
              type: 'run_start_ack', req_id: reqId, ok: false,
              error: err.message, code: 'internal_error',
            })
          })
        } else if (msg.type === 'relay_error') {
          process.stderr.write(`[vibe-node] relay error: ${msg.code} — ${msg.message}\n`)
          ws.close()
          done(new Error(msg.message))
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
          done(msg.nodes)
        } else if (msg.type === 'relay_error') {
          ws.terminate()
          done(undefined, new Error(`${msg.code}: ${msg.message}`))
        }
      } catch {}
    })

    ws.on('close', () => done(undefined, new Error('Relay connection closed before response')))
    ws.on('error', (err) => done(undefined, err))
  })
}

export interface RemoteRunStartOpts {
  agent: AgentBackend
  workspaceKey?: string
  repoUrl?: string
  branch?: string
  promptFile?: string
  permissionMode?: PermissionMode
  metadata?: Record<string, unknown>
}

/** One-shot: connect to relay, send run_start to a remote node, return RunRecord (status: queued). */
export async function remoteRunStart(
  relay: string,
  token: string,
  nodeId: string,
  opts: RemoteRunStartOpts,
): Promise<RunRecord> {
  return new Promise<RunRecord>((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))
    const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`

    let settled = false
    const done = (record?: RunRecord, err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      record ? resolve(record) : reject(err!)
    }

    const timeout = setTimeout(() => {
      ws.terminate()
      done(undefined, new Error('Timeout waiting for run_start_ack from relay'))
    }, 10_000)

    ws.on('open', () => {
      sendMsg(ws, {
        version: 1, kind: 'plaintext', from: 'cli', to: nodeId, ts: t(),
        type: 'run_start',
        req_id: reqId,
        agent: opts.agent,
        ...(opts.workspaceKey && { workspace_key: opts.workspaceKey }),
        ...(opts.repoUrl && { repo_url: opts.repoUrl }),
        ...(opts.branch && { branch: opts.branch }),
        ...(opts.promptFile && { prompt_file: opts.promptFile }),
        ...(opts.permissionMode && { permission_mode: opts.permissionMode }),
        ...(opts.metadata && { metadata: opts.metadata }),
      })
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_start_ack' && msg.req_id === reqId) {
          ws.close()
          if (msg.ok && msg.record) {
            done(msg.record)
          } else {
            done(undefined, new Error(msg.error ?? 'run_start failed (ok=false)'))
          }
        }
      } catch {}
    })

    ws.on('close', () => done(undefined, new Error('Relay connection closed before run_start_ack')))
    ws.on('error', (err) => done(undefined, err))
  })
}

/**
 * Connect to relay, subscribe to a run's event stream, print each event as JSONL to stdout.
 * Exits when a terminal event is received or the relay closes the connection.
 *
 * Note: the relay does not buffer past events. Subscribing after some events have already
 * been forwarded will miss those events. Callers should subscribe immediately after run_start.
 */
export async function remoteStream(relay: string, token: string, runId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))

    ws.on('open', () => {
      sendMsg(ws, {
        version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(),
        type: 'run_stream_subscribe', run_id: runId,
      })
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_event' && msg.run_id === runId) {
          process.stdout.write(JSON.stringify(msg.event) + '\n')
          if (isTerminal(msg.event)) {
            ws.close()
            resolve()
          }
        } else if (msg.type === 'relay_error') {
          ws.terminate()
          reject(new Error(`${msg.code}: ${msg.message}`))
        }
        // run_stream_subscribe_ack is silently accepted — no action needed
      } catch {}
    })

    ws.on('close', () => resolve())
    ws.on('error', (err) => reject(err))
  })
}
