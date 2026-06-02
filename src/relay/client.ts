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
import { generateRunId, tryReadRun, updateRun, writeRun } from '../store.js'
import { appendEvent } from '../events.js'
import { mockBackend } from '../backends/mock.js'
import { claudeCodeBackend } from '../backends/claude-code.js'
import { isTerminal } from '../types.js'
import type { AgentBackend, PermissionMode, RunEvent, RunRecord, VibeNode } from '../types.js'
import type { RelayMessage, RunStartMsg, RunStopRequestMsg, EncryptedRunStartMsg, RunStartPayload } from './types.js'
import { ensureIdentity, toPublicIdentity, type IdentityFile } from '../identity.js'
import { signEnvelope, encryptPayload, decryptPayload, type EnvelopeSignature } from '../crypto.js'

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

/**
 * Build and send a signed relay message.
 * The signature covers canonical(envelope-without-signature).
 */
function sendSigned(ws: WebSocket, msg: RelayMessage, identity: IdentityFile): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const { signature: _drop, ...withoutSig } = msg as unknown as Record<string, unknown>
  const sig: EnvelopeSignature = signEnvelope(identity.signing.private_key, identity.id, withoutSig)
  ws.send(JSON.stringify({ ...msg, signature: sig }))
}

function t(): string { return new Date().toISOString() }

async function handleRunStart(ws: WebSocket, nodeId: string, config: ReturnType<typeof resolveConfig>, msg: RunStartMsg): Promise<void> {
  if (msg.agent !== 'mock' && msg.agent !== 'claude-code') {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_start_ack', req_id: msg.req_id, ok: false,
      error: `Remote agent not supported: ${msg.agent}. Supported: mock, claude-code.`,
      code: 'agent_not_supported',
    })
    return
  }

  const runId = generateRunId()
  const workspaceKey = msg.workspace_key ?? runId
  const workspacePath = path.join(config.workspace_root, workspaceKey)
  fs.mkdirSync(workspacePath, { recursive: true })

  // Write prompt content to a node-local temp file. The controller sends the
  // file's text content over the relay so the node never needs the controller's path.
  let promptFile: string | undefined
  if (msg.prompt_content !== undefined) {
    promptFile = path.join(os.tmpdir(), `vibe-prompt-${runId}.md`)
    fs.writeFileSync(promptFile, msg.prompt_content, 'utf8')
  }

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
    ...(promptFile && { prompt_file: promptFile }),
    ...(msg.permission_mode && { permission_mode: msg.permission_mode }),
    ...(msg.metadata && { metadata: msg.metadata }),
    created_at: now,
    updated_at: now,
  }
  writeRun(record)

  const backend = msg.agent === 'claude-code' ? claudeCodeBackend : mockBackend
  const result = await backend.start(record, {})
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
 * Handle an encrypted run_start envelope (MVP 4B).
 * Decrypts the payload using the node's X25519 private key, then
 * calls the existing handleRunStart with a synthetic RunStartMsg.
 */
async function handleEncryptedRunStart(
  ws: WebSocket,
  nodeId: string,
  config: ReturnType<typeof resolveConfig>,
  identity: IdentityFile | null,
  enc: EncryptedRunStartMsg,
): Promise<void> {
  if (!identity) {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_start_ack', req_id: enc.req_id, ok: false,
      error: 'Node has no identity — cannot decrypt run_start payload',
      code: 'no_identity',
    })
    return
  }

  let payload: RunStartPayload
  try {
    payload = decryptPayload(identity.encryption.private_key, {
      ephemeralPublicKey: enc.ephemeral_public_key,
      nonce: enc.nonce,
      ciphertext: enc.ciphertext,
    }) as unknown as RunStartPayload
  } catch {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_start_ack', req_id: enc.req_id, ok: false,
      error: 'Failed to decrypt run_start payload — wrong key or tampered ciphertext',
      code: 'decrypt_failed',
    })
    return
  }

  // Reconstruct a synthetic RunStartMsg and call the existing handler
  const synthetic: RunStartMsg = {
    version: 1,
    kind: 'plaintext',
    from: enc.from,
    to: enc.to,
    ts: enc.ts,
    type: 'run_start',
    req_id: enc.req_id,
    agent: payload.agent,
    ...(payload.workspace_key && { workspace_key: payload.workspace_key }),
    ...(payload.repo_url && { repo_url: payload.repo_url }),
    ...(payload.branch && { branch: payload.branch }),
    ...(payload.prompt_content !== undefined && { prompt_content: payload.prompt_content }),
    ...(payload.permission_mode && { permission_mode: payload.permission_mode }),
    ...(payload.metadata && { metadata: payload.metadata }),
  }

  return handleRunStart(ws, nodeId, config, synthetic)
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

  // Load identity; if available and no --node-id override, use identity id as node_id.
  let identity: IdentityFile | null = null
  try { identity = ensureIdentity() } catch { /* non-fatal — fall back to hostname-derived id */ }
  const nodeId = nodeIdOverride ?? identity?.id ?? deriveNodeId()

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
    ...(identity && { encryption_public_key: identity.encryption.public_key }),
  }

  process.stderr.write(`[vibe-node] connecting to relay: ${relay}\n`)
  const ws = new WebSocket(relayUrl(relay, token))

  let timer: ReturnType<typeof setInterval> | null = null

  const send = (msg: RelayMessage) => identity ? sendSigned(ws, msg, identity) : sendMsg(ws, msg)

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
      send({ version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'node_register', node })

      timer = setInterval(() => {
        send({
          version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
          type: 'node_heartbeat', node_id: nodeId,
          active_runs: countActiveRuns(), last_heartbeat_at: t(),
        })
      }, heartbeatMs)
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        const rawKind = (msg as { kind?: string }).kind

        if (msg.type === 'node_register_ack') {
          process.stderr.write(`[vibe-node] registered ✓ node_id=${msg.node_id}\n`)
          process.stderr.write(`[vibe-node] heartbeat every ${heartbeatMs}ms — Ctrl-C to stop\n`)
        } else if (rawKind === 'encrypted' && (msg as { type?: string }).type === 'run_start') {
          const enc = msg as EncryptedRunStartMsg
          const reqId = enc.req_id
          handleEncryptedRunStart(ws, nodeId, config, identity, enc).catch((err: Error) => {
            process.stderr.write(`[vibe-node] encrypted run_start error: ${err.message}\n`)
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
              type: 'run_start_ack', req_id: reqId, ok: false,
              error: err.message, code: 'internal_error',
            })
          })
        } else if (msg.type === 'run_start' && (msg as { kind?: string }).kind === 'plaintext') {
          const reqId = (msg as RunStartMsg).req_id
          handleRunStart(ws, nodeId, config, msg as RunStartMsg).catch((err: Error) => {
            process.stderr.write(`[vibe-node] run_start error: ${err.message}\n`)
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
              type: 'run_start_ack', req_id: reqId, ok: false,
              error: err.message, code: 'internal_error',
            })
          })
        } else if (msg.type === 'run_stop_request') {
          const reqId = msg.req_id
          const runId = msg.run_id
          handleRunStop(ws, nodeId, msg).catch((err: Error) => {
            process.stderr.write(`[vibe-node] run_stop error: ${err.message}\n`)
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
              type: 'run_stop_ack', req_id: reqId, run_id: runId, ok: false,
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

/**
 * Stop a run on the node: kill the runner process, append stopped event, update RunRecord.
 * Uses tryReadRun (no process.exit) so it is safe to call from a long-running daemon.
 */
async function handleRunStop(ws: WebSocket, nodeId: string, msg: RunStopRequestMsg): Promise<void> {
  const record = tryReadRun(msg.run_id)
  if (!record) {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_stop_ack', req_id: msg.req_id, run_id: msg.run_id, ok: false,
      error: `Run not found: ${msg.run_id}`, code: 'run_not_found',
    })
    return
  }

  const TERMINAL = ['completed', 'failed', 'stopped', 'cancelled']
  if (TERMINAL.includes(record.status)) {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_stop_ack', req_id: msg.req_id, run_id: msg.run_id, ok: false,
      error: `Run is already terminal: ${record.status}`, code: 'already_terminal',
    })
    return
  }

  // Kill the runner process (same logic as local stopRun in run-actions.ts)
  if (record.session_id) {
    const pid = parseInt(record.session_id, 10)
    if (!isNaN(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
  }
  if (record.child_pid) {
    try { process.kill(-record.child_pid, 'SIGTERM') } catch {}
    try { process.kill(record.child_pid, 'SIGTERM') } catch {}
  }

  appendEvent({ type: 'status', run_id: msg.run_id, session_id: record.session_id, status: 'stopped', ts: t() })
  const updated = updateRun(msg.run_id, { status: 'stopped' })

  sendMsg(ws, {
    version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
    type: 'run_stop_ack', req_id: msg.req_id, run_id: msg.run_id, ok: true, record: updated,
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
  promptFile?: string     // controller-local path; content is read here and sent as prompt_content
  permissionMode?: PermissionMode
  metadata?: Record<string, unknown>
  /** When set, encrypt the run_start payload for the target node. */
  encryptionPublicKey?: string  // target node's X25519 encryption_public_key (base64)
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
      // Read prompt file locally — send content, not path, so the remote node
      // doesn't need access to the controller's filesystem.
      let promptContent: string | undefined
      if (opts.promptFile) {
        try { promptContent = fs.readFileSync(opts.promptFile, 'utf8') } catch {}
      }

      if (opts.encryptionPublicKey) {
        // MVP 4B: encrypt the sensitive payload; relay only sees routing metadata.
        const payload = {
          agent: opts.agent,
          ...(opts.workspaceKey && { workspace_key: opts.workspaceKey }),
          ...(opts.repoUrl && { repo_url: opts.repoUrl }),
          ...(opts.branch && { branch: opts.branch }),
          ...(promptContent !== undefined && { prompt_content: promptContent }),
          ...(opts.permissionMode && { permission_mode: opts.permissionMode }),
          ...(opts.metadata && { metadata: opts.metadata }),
        }
        const enc = encryptPayload(opts.encryptionPublicKey, payload)
        // TODO(4E): sign outer envelope with controller identity once client identity is implemented.
        // Payload integrity is guaranteed by AES-256-GCM auth tag; outer fields are currently unsigned.
        ws.send(JSON.stringify({
          version: 1,
          kind: 'encrypted',
          from: 'cli',
          to: nodeId,
          ts: t(),
          req_id: reqId,
          type: 'run_start',
          key_id: nodeId,
          ephemeral_public_key: enc.ephemeralPublicKey,
          nonce: enc.nonce,
          ciphertext: enc.ciphertext,
        } satisfies EncryptedRunStartMsg))
      } else {
        sendMsg(ws, {
          version: 1, kind: 'plaintext', from: 'cli', to: nodeId, ts: t(),
          type: 'run_start',
          req_id: reqId,
          agent: opts.agent,
          ...(opts.workspaceKey && { workspace_key: opts.workspaceKey }),
          ...(opts.repoUrl && { repo_url: opts.repoUrl }),
          ...(opts.branch && { branch: opts.branch }),
          ...(promptContent !== undefined && { prompt_content: promptContent }),
          ...(opts.permissionMode && { permission_mode: opts.permissionMode }),
          ...(opts.metadata && { metadata: opts.metadata }),
        })
      }
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_start_ack' && msg.req_id === reqId) {
          ws.close()
          if (msg.ok && msg.record) {
            done(msg.record)
          } else {
            done(undefined, new Error(`${msg.code ?? 'run_start_failed'}: ${msg.error ?? 'unknown error'}`))
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

export interface PairedRelayRecord {
  relay_url: string
  paired_at: string
  node_id: string
  relay_id: string | null
  relay_signing_public_key: string | null
  status: 'paired'
}

export interface PairedRelaysFile {
  relays: PairedRelayRecord[]
}

function pairedRelaysPath(): string {
  return path.join(vibeDir(), 'paired_relays.json')
}

function loadPairedRelays(): PairedRelaysFile {
  try { return JSON.parse(fs.readFileSync(pairedRelaysPath(), 'utf8')) as PairedRelaysFile } catch {}
  return { relays: [] }
}

function savePairedRelays(file: PairedRelaysFile): void {
  const p = pairedRelaysPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(file, null, 2))
}

/**
 * Pair this node with a relay: send our public identity, relay stores it.
 * Writes ~/.vibe/paired_relays.json on success.
 */
export async function relayNodePair(relay: string, token: string): Promise<PairedRelayRecord> {
  const identity = ensureIdentity()
  const pub = toPublicIdentity(identity)

  return new Promise<PairedRelayRecord>((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))

    let settled = false
    const done = (record?: PairedRelayRecord, err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      record ? resolve(record) : reject(err!)
    }

    const timeout = setTimeout(() => {
      ws.terminate()
      done(undefined, new Error('Timeout waiting for node_pair_ack from relay'))
    }, 10_000)

    ws.on('open', () => {
      sendMsg(ws, {
        version: 1, kind: 'plaintext', from: pub.id, to: 'relay', ts: t(),
        type: 'node_pair_request', identity: pub,
      })
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'node_pair_ack') {
          ws.close()
          if (msg.ok) {
            const record: PairedRelayRecord = {
              relay_url: relay,
              paired_at: new Date().toISOString(),
              node_id: pub.id,
              relay_id: null,
              relay_signing_public_key: null,
              status: 'paired',
            }
            const stored = loadPairedRelays()
            stored.relays = stored.relays.filter(r => r.relay_url !== relay)
            stored.relays.push(record)
            savePairedRelays(stored)
            done(record)
          } else {
            done(undefined, new Error(`${msg.code ?? 'pair_failed'}: ${msg.error ?? 'unknown error'}`))
          }
        }
      } catch {}
    })

    ws.on('close', () => done(undefined, new Error('Relay connection closed before node_pair_ack')))
    ws.on('error', (err) => done(undefined, err))
  })
}

/** One-shot: connect to relay, send run_stop_request to owning node, return updated RunRecord. */
export async function remoteStop(relay: string, token: string, runId: string): Promise<RunRecord> {
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
      done(undefined, new Error('Timeout waiting for run_stop_ack from relay'))
    }, 10_000)

    ws.on('open', () => {
      sendMsg(ws, {
        version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(),
        type: 'run_stop_request', req_id: reqId, run_id: runId, reason: 'requested_by_user',
      })
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_stop_ack' && msg.req_id === reqId) {
          ws.close()
          if (msg.ok && msg.record) {
            done(msg.record)
          } else {
            done(undefined, new Error(`${msg.code ?? 'stop_failed'}: ${msg.error ?? 'unknown error'}`))
          }
        }
      } catch {}
    })

    ws.on('close', () => done(undefined, new Error('Relay connection closed before run_stop_ack')))
    ws.on('error', (err) => done(undefined, err))
  })
}
