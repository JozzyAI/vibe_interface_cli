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
import { resolveContainedWorkspace } from '../workspace.js'
import { mockBackend } from '../backends/mock.js'
import { claudeCodeBackend } from '../backends/claude-code.js'
import { codexBackend } from '../backends/codex.js'
import { resolveAgents, resolveAdvertisedAgents } from '../agent-registry.js'
import { isTerminal } from '../types.js'
import type { AgentBackend, PermissionMode, RunEvent, RunRecord, VibeNode } from '../types.js'
import { openNodeJournal } from '../node-journal/sqlite-journal.js'
import { RUN_EVENT_REPLAY_CAPABILITY, RUN_RESULT_CAPABILITY, WORKSPACE_LEASE_CAPABILITY } from '../node-journal/contract.js'
import { withVerifierSandboxCapability } from '../runtime/sandbox.js'
import { handleWorkspaceLeaseRequest, handleWorkspaceRevisionRequest, isWorkspaceLeaseRequestType, isWorkspaceRevisionRequestType, workspaceLeaseCapability } from './node-lease-dispatch.js'
import { validateTaskResult, type AgentTaskResultV1 } from '../lib/agent-task-result.js'
import { WorkspaceLeaseError, observeWorkspaceRevision, type WorkspaceLeaseV1 } from '../lib/workspace-lease.js'
import { isIsoUtc as journalIsoOk, nowIso as journalNowIso } from '../node-journal/serialization.js'
import type { NodeJournal } from '../node-journal/store.js'

/** Node-local durable run-event journal (opened once per daemon; journal-BEFORE-
 *  publish for remote run events). Undefined when unavailable — the node then
 *  streams live-only (backward-compatible), never silently in-memory-journaling. */
let nodeJournal: NodeJournal | undefined
/** run_id → event AES key for ENCRYPTED runs, so journaled replay can be
 *  re-encrypted (the relay/journal never see plaintext for an encrypted run). */
const runEventKeys = new Map<string, string>()
/** subscriber_ref → open journal replay subscription (for run_replay_close). */
const replaySubs = new Map<string, { close(): void }>()
/** Status implied by a RunEvent, for journal run metadata. */
function journalStatusOf(ev: RunEvent): string | undefined { return ev.type === 'status' ? (ev as { status?: string }).status : undefined }
import type { RelayMessage, RunStartMsg, RunStopRequestMsg, RunStatusRequestMsg, EncryptedRunStartMsg, EncryptedRunEventMsg, EncryptedRunStopRequestMsg, EncryptedRunStopAckMsg, EncryptedApprovalResponseMsg, EncryptedApprovalResponseAckMsg, RunStartPayload, RunStopPayload, RunStopAckPayload, ApprovalResponsePayload, ApprovalResponseAckPayload } from './types.js'
import { ensureIdentity, toPublicIdentity, type IdentityFile } from '../identity.js'
import { signEnvelope, encryptPayload, decryptPayload, deriveRunEventKey, deriveRunStopKey, deriveApprovalKey, encryptEvent, decryptEvent, type EnvelopeSignature } from '../crypto.js'
import { nextBackoffMs, sleep } from './reconnect.js'
import { tmuxAvailable, tmuxHasSession, tmuxCapturePane, tmuxSendKeys, tmuxResizeWindow, isSafeSessionName, tmuxCreateOwnedSession, tmuxListOwnedSessions, tmuxKillOwnedSession } from '../lib/tmux.js'

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

async function handleRunStart(ws: WebSocket, nodeId: string, config: ReturnType<typeof resolveConfig>, msg: RunStartMsg, eventAesKey?: string, stopAesKey?: string, approvalAesKey?: string): Promise<void> {
  const supportedAgents = resolveAgents()
  if (!supportedAgents.includes(msg.agent)) {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_start_ack', req_id: msg.req_id, ok: false,
      error: `Agent not supported: ${msg.agent}. Supported: ${supportedAgents.join(', ')}.`,
      code: 'agent_not_supported',
    })
    return
  }

  const runId = generateRunId()
  // Remember the run's event key (encrypted runs) so journaled replay can be
  // re-encrypted per subscriber; cleared when the run's tailer finishes.
  if (eventAesKey) runEventKeys.set(runId, eventAesKey)
  // The node is the filesystem trust boundary for every relay client. Contain the
  // (untrusted) workspace_key within workspace_root BEFORE creating any directory,
  // writing the run record, or starting a backend. Omitting the key uses the safe
  // generated run_id. The error never echoes the submitted key.
  const workspaceKey = msg.workspace_key ?? runId
  const wsResolved = resolveContainedWorkspace(workspaceKey, config.workspace_root)
  if (!wsResolved.ok) {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_start_ack', req_id: msg.req_id, ok: false,
      error: wsResolved.message, // never contains the submitted key
      code: wsResolved.code,
    })
    return
  }
  const workspacePath = wsResolved.path

  // ── Workspace lease enforcement (workspace_lease_v1) ─────────────────────────
  // AFTER containment resolves the (untrusted) key, and BEFORE creating any
  // directory, writing the run record, writing a prompt file, or starting a
  // backend: if the workspace is leased, the run must present the exact matching
  // active lease; a lease-bound request on a node without lease storage is
  // unsupported. Sanitized codes — the message never echoes the key or a path.
  const presentedLeaseId = msg.workspace_lease_id ?? null
  if (presentedLeaseId && !nodeJournal) {
    sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'run_start_ack', req_id: msg.req_id, ok: false, error: 'this node cannot enforce workspace leases', code: 'workspace_lease_unsupported' })
    return
  }
  if (nodeJournal) {
    try { nodeJournal.validateWorkspaceLeaseForRun(nodeId, workspaceKey, presentedLeaseId) }
    catch (err) {
      if (err instanceof WorkspaceLeaseError) { sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'run_start_ack', req_id: msg.req_id, ok: false, error: 'workspace lease check failed', code: err.code }); return }
      throw err
    }
  }

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
    ...(msg.verify && { verify: msg.verify }),  // Harness-owned post-task verifier (Node-local; never forwarded to the provider)
    ...(msg.metadata && { metadata: msg.metadata }),
    ...(stopAesKey && { stop_aes_key: stopAesKey }),        // MVP 4D: stored for handleRunStop
    ...(approvalAesKey && { approval_aes_key: approvalAesKey }), // MVP 4F: stored for handleEncryptedApprovalResponse
    ...(presentedLeaseId && { workspace_lease_id: presentedLeaseId }), // Node-local; never forwarded to the provider
    created_at: now,
    updated_at: now,
  }
  writeRun(record)
  // Bind the run to its lease so the Node can refuse a lease release while this run
  // is still non-terminal (release protection). Immutable once set.
  if (nodeJournal && presentedLeaseId) { try { nodeJournal.bindRunToLease(runId, presentedLeaseId) } catch { /* validated above; best effort */ } }

  const backendMap: Record<string, import('../backends/types.js').Backend> = {
    'claude-code': claudeCodeBackend,
    'codex': codexBackend,
    'mock': mockBackend,
  }
  const backend = backendMap[msg.agent] ?? mockBackend
  const result = await backend.start(record, {})
  const runningRecord = updateRun(runId, { session_id: result.session_id, status: 'running' })

  sendMsg(ws, {
    version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
    type: 'run_start_ack', req_id: msg.req_id, ok: true, record: runningRecord,
  })

  // Tail the event log and forward each event to relay (encrypted if eventAesKey is set).
  tailRunEvents(ws, nodeId, runId, eventAesKey).catch((err) => {
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

  // Derive per-run keys from ECDH shared secret with domain-separated HKDF contexts.
  const eventAesKey    = deriveRunEventKey(identity.encryption.private_key, enc.ephemeral_public_key)  // MVP 4C
  const stopAesKey     = deriveRunStopKey(identity.encryption.private_key, enc.ephemeral_public_key)   // MVP 4D
  const approvalAesKey = deriveApprovalKey(identity.encryption.private_key, enc.ephemeral_public_key)  // MVP 4F

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
    ...(payload.workspace_lease_id && { workspace_lease_id: payload.workspace_lease_id }), // from the ENCRYPTED payload (relay never saw it)
    ...(payload.verify && { verify: payload.verify }), // from the ENCRYPTED payload (relay never saw it)
  }

  return handleRunStart(ws, nodeId, config, synthetic, eventAesKey, stopAesKey, approvalAesKey)
}

/**
 * Poll the run's JSONL event log and forward each new event to the relay.
 * If eventAesKey is provided (encrypted run), encrypts each event before sending
 * as encrypted_run_event. Otherwise sends plaintext run_event (backward-compatible).
 * Resolves after a terminal event or after IDLE_TIMEOUT_MS with no new events.
 */
/** Persist the authoritative AgentTaskResult for a terminal run into the node
 *  journal from the run record (written by the supervisor BEFORE the terminal
 *  event). Idempotent; never derived from event history. */
function persistTerminalResult(runId: string): void {
  if (!nodeJournal) return
  const rec = tryReadRun(runId) as (RunRecord & { result_status?: string; task_result?: unknown }) | undefined
  let rs = (rec?.result_status as string) ?? 'missing'
  let result: AgentTaskResultV1 | null = null
  if (rs === 'available' && rec?.task_result) { const v = validateTaskResult(rec.task_result); if (v.ok) result = v.value; else rs = 'invalid' }
  else if (rs === 'available') rs = 'missing'
  nodeJournal.persistRunResult(runId, rs, result)
}

/** Resolve a run's durable result on the node (journal first, then a best-effort
 *  terminal persist from the run record). */
function resolveNodeRunResult(runId: string): { result_status: string; result: AgentTaskResultV1 | null } {
  if (nodeJournal) {
    let nr = nodeJournal.getRunResult(runId)
    if (!nr) { try { persistTerminalResult(runId); nr = nodeJournal.getRunResult(runId) } catch { /* */ } }
    if (nr) return { result_status: nr.result_status, result: nr.result }
  }
  return { result_status: 'missing', result: null }
}

function tailRunEvents(ws: WebSocket, nodeId: string, runId: string, eventAesKey?: string): Promise<void> {
  const eventsFile = path.join(vibeDir(), 'events', `${runId}.jsonl`)
  let offset = 0

  // Stop tailing only after IDLE_TIMEOUT_MS with NO new events. A fixed wall-clock
  // cap (the previous 120s safety timeout) truncated forwarding mid-run for any
  // agent run longer than the cap: later events — including the terminal
  // completed/failed event — were never forwarded, so a remote controller saw the
  // run go quiet and false-stalled it. The timer is reset on every batch of new
  // bytes, so an active run forwards indefinitely until it emits a terminal event.
  // The idle window is comfortably larger than typical controller stall windows.
  const IDLE_TIMEOUT_MS = 600_000

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setInterval>
    let idleTimer: ReturnType<typeof setTimeout>

    const finish = () => {
      clearInterval(timer)
      clearTimeout(idleTimer)
      resolve()
    }
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(finish, IDLE_TIMEOUT_MS)
    }

    const flush = (): boolean => {
      try {
        const stat = fs.statSync(eventsFile)
        if (stat.size <= offset) return false

        const fd = fs.openSync(eventsFile, 'r')
        const buf = Buffer.alloc(stat.size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        offset = stat.size
        armIdle() // new bytes => run still active; extend the idle deadline

        const lines = buf.toString('utf8').split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as RunEvent
            // Journal BEFORE publish: durably append the NODE source event (the
            // journal assigns the contiguous per-run sequence), THEN send with that
            // source_sequence. On a journal failure do NOT publish an un-replayable
            // event (skip it).
            let sourceSeq: number | undefined
            if (nodeJournal) {
              try { sourceSeq = nodeJournal.append(runId, { type: event.type, timestamp: journalIsoOk(event.ts) ? event.ts : journalNowIso(), payload: event, terminal: isTerminal(event), status: journalStatusOf(event) }).sequence }
              catch { continue }
              // On the terminal event, durably persist the authoritative
              // AgentTaskResult from the run record (the supervisor wrote it BEFORE
              // this terminal event). Idempotent; never derived from event history.
              if (isTerminal(event)) { try { persistTerminalResult(runId) } catch { /* best effort; RunRecord retains it too */ } }
            }
            if (eventAesKey) {
              // MVP 4C: encrypt event payload — relay sees only routing metadata.
              const enc = encryptEvent(eventAesKey, event)
              ws.send(JSON.stringify({
                version: 1,
                kind: 'encrypted',
                from: nodeId,
                to: 'relay',
                ts: t(),
                type: 'encrypted_run_event',
                run_id: runId,
                key_id: nodeId,
                nonce: enc.nonce,
                ciphertext: enc.ciphertext,
              } satisfies EncryptedRunEventMsg))
            } else {
              sendMsg(ws, {
                version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
                type: 'run_event', run_id: runId, event,
                ...(sourceSeq !== undefined ? { source_sequence: sourceSeq } : {}),
              })
            }
            if (isTerminal(event)) {
              finish()
              return true
            }
          } catch {}
        }
      } catch {}
      return false
    }

    if (flush()) return

    timer = setInterval(() => { if (flush()) clearInterval(timer) }, 250)
    armIdle()
  })
}

/** Outcome of a single relay connection attempt. */
type ConnOutcome =
  | { kind: 'closed'; registered: boolean }
  | { kind: 'fatal'; reason: string }

/** Observable connection-lifecycle events (test hook; no-op in production). */
export type DaemonConnEvent =
  | 'connecting' | 'registered' | 'closed' | 'rejected' | 'auth_failed' | 'reconnect_scheduled'

/** Optional controls for {@link relayNodeDaemon}; defaults preserve production behaviour. */
export interface RelayDaemonControl {
  /** Stop the reconnect loop programmatically (used instead of process signals). */
  signal?: AbortSignal
  /** Reconnect backoff base/cap in ms (defaults 1000 / 30000). */
  backoffBaseMs?: number
  backoffCapMs?: number
  /** Called instead of process.exit when the loop ends fatally (auth/pairing). */
  onFatal?: (code: number, reason: string) => void
  /** Lifecycle observer (test hook). */
  onEvent?: (ev: DaemonConnEvent) => void
}

/**
 * Connect to relay as a node daemon: register, send heartbeats, handle run_start.
 *
 * Resilient to relay restarts — when the WebSocket closes (relay reload, network
 * blip) the daemon stays alive and reconnects with capped exponential backoff,
 * re-registering the SAME node_id each time. Pairing persistence on the relay
 * means no `vibe node pair` is needed across a restart. The loop only stops on:
 *   - an explicit shutdown (SIGINT/SIGTERM, or an aborted control.signal), or
 *   - a fatal auth/pairing rejection (401 / register rejected) — logged with the
 *     token redacted, then exit with an explicit non-zero status (no busy-loop).
 */
export async function relayNodeDaemon(
  relay: string,
  token: string,
  nodeIdOverride?: string,
  control?: RelayDaemonControl,
  advertiseAgents?: string[] | string,
): Promise<void> {
  const config = resolveConfig()
  const heartbeatMs = getHeartbeatMs()

  // What this node publishes to the relay. Resolved ONCE up front so an invalid
  // allowlist fails fast (before connecting) rather than throwing inside the
  // per-connection buildNode and risking a reconnect busy-loop.
  const advertisedAgents = resolveAdvertisedAgents(advertiseAgents)

  // Open the node-local run-event journal ONCE. On any open failure the node runs
  // live-only (no in-memory fallback) and does not advertise the replay capability.
  try { nodeJournal = openNodeJournal() } catch { nodeJournal = undefined }

  // Terminal session CREATION opt-in (default OFF). Creating a session spawns a
  // login shell on this node, so the operator must explicitly enable it via
  // VIBE_TERMINAL_ALLOW_CREATE=1 (or `vibe node daemon --allow-terminal-create`,
  // which sets that env). Attach/list/stop-of-owned do not need it.
  const allowTerminalCreate = process.env.VIBE_TERMINAL_ALLOW_CREATE === '1'

  // Load identity; if available and no --node-id override, use identity id as node_id.
  let identity: IdentityFile | null = null
  try { identity = ensureIdentity() } catch { /* non-fatal — fall back to hostname-derived id */ }
  const nodeId = nodeIdOverride ?? identity?.id ?? deriveNodeId()

  // Built fresh per connection so active_runs / updated_at reflect current state.
  const buildNode = (): VibeNode => ({
    node_id: nodeId,
    // Prefer the identity's persisted display name so a dedicated identity surfaces
    // under its friendly label in `node list`; falls back to the host name for nodes
    // without an identity (identity.display_name itself defaults to the host name).
    name: identity?.display_name ?? os.hostname(),
    status: 'online',
    transport: 'relay',
    // Advertise journaled replay only when the journal actually opened, so a
    // client can detect replay support (absence ⇒ live-only, older behavior).
    // `workspace_lease_v1` is derived from the SAME authority (nodeJournal) that backs
    // the TOTAL lease handlers via `workspaceLeaseCapability`, so the capability is
    // advertised only when the acquire/get/release handlers can run. NOTE: this proves
    // only LOCAL handler availability, NOT end-to-end relay reachability — a relay that
    // does not forward the request type still fails (fast + structured, not silently).
    // `verify-sandbox` is appended only when the enforcing verifier-sandbox probe
    // passes; evaluated once at register time (probe cached per process) → a
    // bubblewrap install/removal needs a Node restart to change the advertisement.
    capabilities: withVerifierSandboxCapability([
      'run', 'stream', 'stop', 'workspace',
      ...(nodeJournal ? [RUN_EVENT_REPLAY_CAPABILITY, RUN_RESULT_CAPABILITY] : []),
      ...(workspaceLeaseCapability(nodeJournal) ? [workspaceLeaseCapability(nodeJournal)!] : []),
    ]),
    agents: advertisedAgents,
    active_runs: countActiveRuns(),
    max_runs: 4,
    workspace_roots: [config.workspace_root],
    created_at: t(),
    updated_at: t(),
    ...(identity && { encryption_public_key: identity.encryption.public_key }),
  })

  const emit = (ev: DaemonConnEvent): void => control?.onEvent?.(ev)

  // Shutdown plumbing: an aborted control.signal (tests) OR process signals
  // (production) ends the loop. Process handlers are installed ONCE here, never
  // per-connection, so reconnects can't accumulate duplicate handlers.
  let stopped = false
  let activeWs: WebSocket | null = null
  const requestStop = (): void => {
    stopped = true
    if (activeWs) { try { activeWs.close() } catch { /* ignore */ } }
    try { nodeJournal?.close() } catch { /* ignore */ } finally { nodeJournal = undefined }
  }
  if (control?.signal) {
    if (control.signal.aborted) stopped = true
    else control.signal.addEventListener('abort', requestStop, { once: true })
  } else {
    const onSignal = (signal: string): void => {
      process.stderr.write(`\n[vibe-node] received ${signal}, shutting down\n`)
      requestStop()
      setTimeout(() => process.exit(0), 300)
    }
    process.on('SIGINT', () => onSignal('SIGINT'))
    process.on('SIGTERM', () => onSignal('SIGTERM'))
  }

  const connectOnce = (): Promise<ConnOutcome> => new Promise<ConnOutcome>((resolve) => {
    emit('connecting')
    process.stderr.write(`[vibe-node] connecting to relay: ${relay}\n`)
    const ws = new WebSocket(relayUrl(relay, token))
    activeWs = ws

    let hb: ReturnType<typeof setInterval> | null = null
    let registered = false
    let settled = false
    const send = (msg: RelayMessage): void => { identity ? sendSigned(ws, msg, identity) : sendMsg(ws, msg) }
    const finish = (outcome: ConnOutcome): void => {
      if (settled) return
      settled = true
      if (hb) clearInterval(hb)
      resolve(outcome)
    }

    ws.on('open', () => {
      process.stderr.write(`[vibe-node] connected — registering node_id=${nodeId}\n`)
      send({ version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'node_register', node: buildNode() })

      hb = setInterval(() => {
        send({
          version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
          type: 'node_heartbeat', node_id: nodeId,
          active_runs: countActiveRuns(), last_heartbeat_at: t(),
        })
      }, heartbeatMs)
    })

    // A 401 at the WS handshake is a definite auth failure — do not reconnect.
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        process.stderr.write('[vibe-node] relay rejected connection: 401 unauthorized — check VIBE_RELAY_TOKEN [token REDACTED]\n')
        emit('auth_failed')
        try { ws.terminate() } catch { /* ignore */ }
        finish({ kind: 'fatal', reason: 'relay returned 401 unauthorized (check token)' })
      }
      // other unexpected responses fall through to 'error'/'close' (transient)
    })

    // Remote-terminal bridges for THIS relay connection: session_id → bridge
    // state. Each attaches to an EXISTING tmux session via capture-pane polling
    // (out) + send-keys (in). We NEVER create, resize away, or kill the tmux
    // session/server; keystroke data is NEVER logged. Output strategy: full-pane
    // capture-pane redraw (TUI-safe for Claude Code's alt-screen).
    //
    // Polling is ADAPTIVE (self-scheduling, not a fixed interval): poll FAST for
    // a short window after any input or pane change (responsive typing), then
    // decay to SLOW when idle (spares the node + phone/VPN). Exact-snapshot
    // dedupe means an unchanged pane still sends nothing.
    interface TerminalBridge { session: string; timer?: NodeJS.Timeout; lastActivityAt: number; stopped: boolean; bump?: () => void }
    const terminalBridges = new Map<string, TerminalBridge>()
    const TERMINAL_POLL_FAST_MS = 90   // right after input / a pane change
    const TERMINAL_POLL_SLOW_MS = 700  // idle (no input or change for a while)
    const TERMINAL_ACTIVE_WINDOW_MS = 1500 // stay fast for this long after activity
    const stopTerminalBridge = (sessionId: string): void => {
      const b = terminalBridges.get(sessionId)
      if (b) { b.stopped = true; if (b.timer) clearTimeout(b.timer); terminalBridges.delete(sessionId) }
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        const rawKind = (msg as { kind?: string }).kind

        if (msg.type === 'node_register_ack') {
          const ack = msg as { node_id: string; ok?: boolean; error?: string; code?: string }
          if (ack.ok === false) {
            process.stderr.write(`[vibe-node] registration REJECTED node_id=${ack.node_id} error=${ack.error ?? ack.code ?? 'unknown'} — run \`vibe node pair\` to re-pair [token REDACTED]\n`)
            emit('rejected')
            try { ws.close() } catch { /* ignore */ }
            finish({ kind: 'fatal', reason: `relay rejected registration: ${ack.error ?? ack.code ?? 'unknown'}` })
          } else {
            registered = true
            emit('registered')
            process.stderr.write(`[vibe-node] registered ✓ node_id=${msg.node_id}\n`)
            process.stderr.write(`[vibe-node] heartbeat every ${heartbeatMs}ms — Ctrl-C to stop\n`)
          }
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
        } else if (rawKind === 'encrypted' && (msg as { type?: string }).type === 'encrypted_run_stop_request') {
          const enc = msg as EncryptedRunStopRequestMsg
          handleEncryptedRunStop(ws, nodeId, enc).catch((err: Error) => {
            process.stderr.write(`[vibe-node] encrypted run_stop error: ${err.message}\n`)
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
              type: 'run_stop_ack', req_id: enc.req_id, run_id: enc.run_id, ok: false,
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
        } else if (msg.type === 'run_status_request') {
          const reqId = msg.req_id
          const runId = msg.run_id
          handleRunStatus(ws, nodeId, msg).catch((err: Error) => {
            process.stderr.write(`[vibe-node] run_status error: ${err.message}\n`)
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
              type: 'run_status_ack', req_id: reqId, run_id: runId, ok: false,
              error: err.message, code: 'internal_error',
            })
          })
        } else if (msg.type === 'run_result_request') {
          // run_result_v1: serve the authoritative AgentTaskResult by exact run id.
          // For an ENCRYPTED run the result content is encrypted with the run event
          // key (relay never sees plaintext); an unencrypted run returns it plainly.
          const reqId = (msg as { req_id: string }).req_id
          const runId = (msg as { run_id: string }).run_id
          try {
            const { result_status, result } = resolveNodeRunResult(runId)
            const key = runEventKeys.get(runId)
            const base = { version: 1 as const, kind: 'plaintext' as const, from: nodeId, to: 'relay', ts: t(), type: 'run_result_ack' as const, req_id: reqId, run_id: runId, ok: true as const, result_status }
            if (result && key) { const enc = encryptEvent(key, result); sendMsg(ws, { ...base, encrypted: { nonce: enc.nonce, ciphertext: enc.ciphertext } }) }
            else if (result && !key) sendMsg(ws, { ...base, result }) // unencrypted run → plaintext ok
            else sendMsg(ws, base) // missing/invalid → status only, no content
          } catch (err) {
            sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'run_result_ack', req_id: reqId, run_id: runId, ok: false, error: (err as Error).message, code: 'internal_error' })
          }
        } else if (isWorkspaceLeaseRequestType((msg as { type?: string }).type)) {
          // workspace_lease_v1: the Node is the authority. The handler is TOTAL — it
          // ALWAYS yields exactly one structured ack (success or sanitized error), so a
          // lease request can never be silently dropped (the failure that stranded the
          // Gateway). Physical paths stay Node-local; only bounded opaque lease data
          // crosses. Deterministic lease_id idempotency + containment are unchanged.
          const reqId = (msg as { req_id: string }).req_id
          const body = handleWorkspaceLeaseRequest(msg as never, { nodeId, workspaceRoot: config.workspace_root, authority: nodeJournal })
          sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'workspace_lease_ack', req_id: reqId, ...body } as never)
        } else if (isWorkspaceRevisionRequestType((msg as { type?: string }).type)) {
          // workspace_lease_v1: a FRESH read-only revision observation, resolved locally.
          // TOTAL handler → always exactly one structured ack.
          const reqId = (msg as { req_id: string }).req_id
          const body = handleWorkspaceRevisionRequest(msg as never, { nodeId, workspaceRoot: config.workspace_root, authority: nodeJournal })
          sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'workspace_revision_ack', req_id: reqId, ...body } as never)
        } else if (msg.type === 'run_replay_open') {
          // Journaled replay (run_event_replay_v1): serve THIS subscriber replay+live
          // race-free from the node journal. Events for an ENCRYPTED run are
          // re-encrypted with the run's event key (never plaintext over the relay).
          // Failures are sanitized: a null metadata, no path/SQL/token/stack.
          const rid = (msg as { run_id: string }).run_id
          const subRef = (msg as { subscriber_ref: string }).subscriber_ref
          const afterSeq = (msg as { after_sequence?: number }).after_sequence ?? -1
          if (!nodeJournal) { sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'run_replay_meta', run_id: rid, subscriber_ref: subRef, metadata: null }); }
          else {
            try {
              const key = runEventKeys.get(rid)
              const sub = nodeJournal.subscribe(rid, {
                afterSequence: Number.isInteger(afterSeq) ? afterSeq : -1,
                onEstablished: (meta) => sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'run_replay_meta', run_id: rid, subscriber_ref: subRef, metadata: meta as unknown as Record<string, unknown> }),
                onEvent: (jev) => {
                  const rev = jev.payload as RunEvent
                  // A plaintext ROUTING envelope; for an encrypted run the `encrypted`
                  // sub-field carries the ciphertext (relay never decrypts).
                  const base = { version: 1 as const, kind: 'plaintext' as const, from: nodeId, to: 'relay', ts: t(), type: 'run_replay_event' as const, run_id: rid, subscriber_ref: subRef, source_sequence: jev.sequence }
                  if (key) { const enc = encryptEvent(key, rev); sendMsg(ws, { ...base, encrypted: { nonce: enc.nonce, ciphertext: enc.ciphertext } }) }
                  else sendMsg(ws, { ...base, event: rev })
                },
                onOverflow: () => { replaySubs.delete(subRef) },
              })
              replaySubs.set(subRef, sub)
            } catch { sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(), type: 'run_replay_meta', run_id: rid, subscriber_ref: subRef, metadata: null }) }
          }
        } else if (msg.type === 'run_replay_close') {
          const subRef = (msg as { subscriber_ref: string }).subscriber_ref
          try { replaySubs.get(subRef)?.close() } catch { /* ignore */ } finally { replaySubs.delete(subRef) }
        } else if (rawKind === 'encrypted' && (msg as { type?: string }).type === 'encrypted_approval_response') {
          const enc = msg as EncryptedApprovalResponseMsg
          handleEncryptedApprovalResponse(ws, nodeId, enc).catch((err: Error) => {
            process.stderr.write(`[vibe-node] encrypted approval_response error: ${err.message}\n`)
          })
        } else if (msg.type === 'terminal_open') {
          // Attach to a tmux session; with create=true (and node opt-in) create a
          // login shell if it is missing. Never take ownership of a pre-existing
          // session. On attach, start a capture-pane pump streaming terminal_output.
          const sid = msg.session_id
          const from = msg.from
          const openAck = (ok: boolean, message: string, code?: string): void => sendMsg(ws, {
            version: 1, kind: 'plaintext', from: nodeId, to: from, ts: t(),
            type: 'terminal_open_ack', req_id: msg.req_id, session_id: sid, ok, message, ...(code ? { code } : {}),
          })
          const attachAndPump = (label: string): void => {
            openAck(true, label)
            const bridge: TerminalBridge = { session: msg.session, lastActivityAt: Date.now(), stopped: false }
            let lastPane: string | undefined
            const schedule = (): void => {
              if (bridge.stopped) return
              const active = Date.now() - bridge.lastActivityAt < TERMINAL_ACTIVE_WINDOW_MS
              bridge.timer = setTimeout(pump, active ? TERMINAL_POLL_FAST_MS : TERMINAL_POLL_SLOW_MS)
              if (typeof bridge.timer.unref === 'function') bridge.timer.unref()
            }
            const pump = (): void => {
              if (bridge.stopped) return
              const cap = tmuxCapturePane(msg.session)
              if (!cap.ok) {
                sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: from, ts: t(), type: 'terminal_output', session_id: sid, data: '\r\n[vibe] tmux session ended\r\n' })
                stopTerminalBridge(sid)
                return
              }
              if (cap.pane !== lastPane) {
                lastPane = cap.pane
                bridge.lastActivityAt = Date.now() // a change keeps us in the fast band
                // Home + clear, then redraw (CRLF for xterm). Full-pane redraw.
                const data = '\x1b[H\x1b[2J' + cap.pane.replace(/\n/g, '\r\n')
                sendMsg(ws, { version: 1, kind: 'plaintext', from: nodeId, to: from, ts: t(), type: 'terminal_output', session_id: sid, data })
              }
              schedule()
            }
            // Input pokes the pump: mark active + poll soon (don't wait out a slow sleep).
            bridge.bump = (): void => {
              if (bridge.stopped) return
              bridge.lastActivityAt = Date.now()
              if (bridge.timer) clearTimeout(bridge.timer)
              bridge.timer = setTimeout(pump, TERMINAL_POLL_FAST_MS)
              if (typeof bridge.timer.unref === 'function') bridge.timer.unref()
            }
            terminalBridges.set(sid, bridge)
            pump() // immediate first frame, then self-schedules
          }
          if (!tmuxAvailable()) {
            openAck(false, 'tmux is not available on this node', 'terminal_unavailable')
          } else if (terminalBridges.has(sid)) {
            openAck(true, `already attached to "${msg.session}"`) // idempotent
          } else if (tmuxHasSession(msg.session)) {
            attachAndPump(`attached to tmux session "${msg.session}"`) // exists → attach; ownership unchanged
          } else if (!msg.create) {
            openAck(false, `no tmux session "${msg.session}" on this node — pass --create to make it`, 'session_not_found')
          } else if (!isSafeSessionName(msg.session)) {
            openAck(false, `invalid session name "${msg.session}"`, 'invalid_session_name')
          } else if (!allowTerminalCreate) {
            openAck(false, 'session creation is disabled on this node — start the daemon with --allow-terminal-create (or VIBE_TERMINAL_ALLOW_CREATE=1)', 'terminal_create_disabled')
          } else if (!tmuxCreateOwnedSession(msg.session)) {
            openAck(false, `failed to create session "${msg.session}"`, 'terminal_create_failed')
          } else {
            attachAndPump(`created and attached to tmux session "${msg.session}"`)
          }
        } else if (msg.type === 'terminal_input') {
          // Literal keys to tmux via an ARGS ARRAY (no shell). NEVER log msg.data.
          const b = terminalBridges.get(msg.session_id)
          if (b) { tmuxSendKeys(b.session, msg.data); b.bump?.() } // poll fast right after input
        } else if (msg.type === 'terminal_resize') {
          // Best-effort; a detached session may clamp — errors ignored.
          const b = terminalBridges.get(msg.session_id)
          if (b && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) tmuxResizeWindow(b.session, msg.cols, msg.rows)
        } else if (msg.type === 'terminal_close') {
          // Stop the pump + drop state. NEVER kill the tmux session itself.
          stopTerminalBridge(msg.session_id)
        } else if (msg.type === 'terminal_session_list') {
          // Vibe-OWNED sessions only (never surfaces vibe-node / user sessions).
          sendMsg(ws, {
            version: 1, kind: 'plaintext', from: nodeId, to: msg.from, ts: t(),
            type: 'terminal_session_list_ack', req_id: msg.req_id, ok: true,
            sessions: tmuxAvailable() ? tmuxListOwnedSessions() : [],
          })
        } else if (msg.type === 'terminal_session_kill') {
          // Kill ONLY a Vibe-owned session — never vibe-node, a user session, or
          // the tmux server. (Owned kill is allowed even if create is disabled.)
          const killAck = (ok: boolean, result: 'killed' | 'not_owned' | 'missing' | undefined, message: string, code?: string): void => sendMsg(ws, {
            version: 1, kind: 'plaintext', from: nodeId, to: msg.from, ts: t(),
            type: 'terminal_session_kill_ack', req_id: msg.req_id, ok, ...(result ? { result } : {}), message, ...(code ? { code } : {}),
          })
          if (!tmuxAvailable()) {
            killAck(false, undefined, 'tmux is not available on this node', 'terminal_unavailable')
          } else if (!isSafeSessionName(msg.session)) {
            killAck(false, undefined, `invalid session name "${msg.session}"`, 'invalid_session_name')
          } else {
            const result = tmuxKillOwnedSession(msg.session)
            if (result === 'killed') killAck(true, 'killed', `killed session "${msg.session}"`)
            else if (result === 'not_owned') killAck(false, 'not_owned', `refusing to kill "${msg.session}" — not a Vibe-owned session`, 'terminal_not_owned')
            else killAck(false, 'missing', `no session "${msg.session}"`, 'session_not_found')
          }
        } else if (msg.type === 'relay_error') {
          process.stderr.write(`[vibe-node] relay error: ${msg.code} — ${msg.message}\n`)
          try { ws.close() } catch { /* ignore */ }
          // transient: the 'close' handler resolves the outcome → reconnect
        }
      } catch {}
    })

    ws.on('close', () => {
      // Stop every terminal pump for this connection (do NOT kill tmux sessions).
      for (const b of terminalBridges.values()) { b.stopped = true; if (b.timer) clearTimeout(b.timer) }
      terminalBridges.clear()
      process.stderr.write('[vibe-node] relay connection closed\n')
      emit('closed')
      finish({ kind: 'closed', registered })
    })

    ws.on('error', (err) => {
      process.stderr.write(`[vibe-node] connection error: ${err.message}\n`)
      finish({ kind: 'closed', registered })
    })
  })

  // Reconnect loop with capped exponential backoff. A session that registered
  // resets the backoff so the first reconnect after a relay restart is quick.
  let attempt = 0
  while (!stopped) {
    const outcome = await connectOnce()
    activeWs = null
    if (stopped) break

    if (outcome.kind === 'fatal') {
      const onFatal = control?.onFatal ?? ((code: number) => process.exit(code))
      onFatal(1, outcome.reason)
      return
    }

    if (outcome.registered) attempt = 0
    const delay = nextBackoffMs(attempt, { baseMs: control?.backoffBaseMs, capMs: control?.backoffCapMs })
    attempt++
    emit('reconnect_scheduled')
    process.stderr.write(`[vibe-node] reconnecting in ${delay}ms\n`)
    await sleep(delay, control?.signal)
  }
}

/** Execute the stop logic for a run and return the result (no I/O). */
async function runStopLogic(runId: string): Promise<RunStopAckPayload> {
  const record = tryReadRun(runId)
  if (!record) {
    return { ok: false, error: `Run not found: ${runId}`, code: 'run_not_found' }
  }

  const TERMINAL = ['completed', 'failed', 'stopped', 'cancelled']
  if (TERMINAL.includes(record.status)) {
    return { ok: false, error: `Run is already terminal: ${record.status}`, code: 'already_terminal' }
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

  appendEvent({ type: 'status', run_id: runId, session_id: record.session_id, status: 'stopped', ts: t() })
  const updated = updateRun(runId, { status: 'stopped' })
  return { ok: true, record: updated }
}

/**
 * Stop a run on the node: kill the runner process, append stopped event, update RunRecord.
 * If stopAesKey is set (encrypted run), sends an encrypted_run_stop_ack instead of plaintext.
 * Uses tryReadRun (no process.exit) so it is safe to call from a long-running daemon.
 */
async function handleRunStop(ws: WebSocket, nodeId: string, msg: RunStopRequestMsg, stopAesKey?: string): Promise<void> {
  const result = await runStopLogic(msg.run_id)

  if (stopAesKey) {
    // MVP 4D: encrypt the ack — relay only sees run_id/req_id/nonce/ciphertext.
    const enc = encryptEvent(stopAesKey, result)
    ws.send(JSON.stringify({
      version: 1, kind: 'encrypted', from: nodeId, to: 'relay', ts: t(),
      type: 'encrypted_run_stop_ack',
      req_id: msg.req_id, run_id: msg.run_id,
      nonce: enc.nonce, ciphertext: enc.ciphertext,
    } satisfies EncryptedRunStopAckMsg))
  } else {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_stop_ack', req_id: msg.req_id, run_id: msg.run_id, ...result,
    })
  }
}

/**
 * Answer a non-destructive run_status_request from the node's authoritative
 * local run record. Read-only: no process signals, no event/record mutation —
 * safe to call repeatedly (e.g. from Symphony's stall watchdog) without any
 * side effect on the run. The RunRecord carries only run metadata (status,
 * pr_url, branch, etc.), never secrets.
 */
async function handleRunStatus(ws: WebSocket, nodeId: string, msg: RunStatusRequestMsg): Promise<void> {
  const record = tryReadRun(msg.run_id)
  if (!record) {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_status_ack', req_id: msg.req_id, run_id: msg.run_id, ok: false,
      error: `Run not found: ${msg.run_id}`, code: 'run_not_found',
    })
    return
  }

  sendMsg(ws, {
    version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
    type: 'run_status_ack', req_id: msg.req_id, run_id: msg.run_id, ok: true, record,
  })
}

/**
 * Handle an encrypted run_stop_request envelope (MVP 4D).
 * Decrypts using the stop key stored in the RunRecord, calls the stop logic,
 * and returns an encrypted_run_stop_ack.
 */
async function handleEncryptedRunStop(ws: WebSocket, nodeId: string, enc: EncryptedRunStopRequestMsg): Promise<void> {
  const record = tryReadRun(enc.run_id)
  const stopAesKey = record?.stop_aes_key

  if (!stopAesKey) {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_stop_ack', req_id: enc.req_id, run_id: enc.run_id, ok: false,
      error: 'No stop key for this run — was it started with --encrypt?', code: 'no_stop_key',
    })
    return
  }

  let _payload: RunStopPayload
  try {
    _payload = decryptEvent(stopAesKey, { nonce: enc.nonce, ciphertext: enc.ciphertext }) as unknown as RunStopPayload
  } catch {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'run_stop_ack', req_id: enc.req_id, run_id: enc.run_id, ok: false,
      error: 'Failed to decrypt stop request — wrong key or tampered ciphertext', code: 'decrypt_failed',
    })
    return
  }

  // Reconstruct synthetic RunStopRequestMsg and call existing handler (encrypted ack path).
  const synthetic: RunStopRequestMsg = {
    version: 1, kind: 'plaintext', from: enc.from, to: enc.to, ts: enc.ts,
    type: 'run_stop_request', req_id: enc.req_id, run_id: enc.run_id,
    ...(_payload.reason && { reason: _payload.reason }),
  }
  return handleRunStop(ws, nodeId, synthetic, stopAesKey)
}

/**
 * Handle an encrypted approval_response envelope (MVP 4F).
 * Decrypts using the approval key stored in the RunRecord, appends approval_response
 * event to the run log, and returns an encrypted_approval_response_ack.
 */
async function handleEncryptedApprovalResponse(
  ws: WebSocket,
  nodeId: string,
  enc: EncryptedApprovalResponseMsg,
): Promise<void> {
  const record = tryReadRun(enc.run_id)
  const approvalAesKey = record?.approval_aes_key

  if (!approvalAesKey) {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'relay_error', code: 'no_approval_key',
      message: 'No approval key for this run — was it started with encryption?',
    })
    return
  }

  let payload: ApprovalResponsePayload
  try {
    payload = decryptEvent(approvalAesKey, { nonce: enc.nonce, ciphertext: enc.ciphertext }) as unknown as ApprovalResponsePayload
  } catch {
    sendMsg(ws, {
      version: 1, kind: 'plaintext', from: nodeId, to: 'relay', ts: t(),
      type: 'relay_error', code: 'decrypt_failed',
      message: 'Failed to decrypt approval_response — wrong key or tampered ciphertext',
    })
    return
  }

  // Append approval_response event to the run log so the event stream includes the decision.
  appendEvent({
    type: 'approval_response',
    run_id: enc.run_id,
    ts: t(),
    approval_id: payload.approval_id,
    decision: payload.decision,
    ...(payload.message && { message: payload.message }),
  })

  const result: import('../relay/types.js').ApprovalResponseAckPayload = { ok: true }
  const ackEnc = encryptEvent(approvalAesKey, result)
  ws.send(JSON.stringify({
    version: 1, kind: 'encrypted', from: nodeId, to: 'relay', ts: t(),
    type: 'encrypted_approval_response_ack',
    req_id: enc.req_id, run_id: enc.run_id,
    nonce: ackEnc.nonce, ciphertext: ackEnc.ciphertext,
  } satisfies EncryptedApprovalResponseAckMsg))
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
  /** workspace_lease_v1: authorize the run against the node's active workspace lease.
   *  Carried INSIDE the encrypted payload; never forwarded to the provider/prompt. */
  workspaceLeaseId?: string
  /** Harness-owned post-task verifier config (argv only). Carried INSIDE the
   *  encrypted payload; never forwarded to the provider/prompt. */
  verify?: { profile: string } // Harness-owned verifier profile id (Node-policy-owned command; never forwarded to the provider)
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

    // Captured during open, used to derive event key after ack.
    let capturedEphemeralPrivKey: string | undefined

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
          ...(opts.workspaceLeaseId && { workspace_lease_id: opts.workspaceLeaseId }),
          ...(opts.verify && { verify: opts.verify }),
        }
        const enc = encryptPayload(opts.encryptionPublicKey, payload)
        capturedEphemeralPrivKey = enc.ephemeralPrivateKey
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
          ...(opts.workspaceLeaseId && { workspace_lease_id: opts.workspaceLeaseId }),
          ...(opts.verify && { verify: opts.verify }),
        })
      }
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_start_ack' && msg.req_id === reqId) {
          ws.close()
          if (msg.ok && msg.record) {
            // MVP 4C/4D: derive and store event+stop AES keys locally for stream decryption and stop encryption.
            // Keys are NOT included in the returned record (not printed to stdout).
            if (capturedEphemeralPrivKey && opts.encryptionPublicKey) {
              const eventAesKey    = deriveRunEventKey(capturedEphemeralPrivKey, opts.encryptionPublicKey)
              const stopAesKey     = deriveRunStopKey(capturedEphemeralPrivKey, opts.encryptionPublicKey)
              const approvalAesKey = deriveApprovalKey(capturedEphemeralPrivKey, opts.encryptionPublicKey)
              writeRun({ ...msg.record, event_aes_key: eventAesKey, stop_aes_key: stopAesKey, approval_aes_key: approvalAesKey })
            }
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

/** Observable stream-lifecycle events (test hook; no-op in production). */
export type StreamConnEvent =
  | 'connecting' | 'subscribed' | 'closed' | 'reconnect_scheduled' | 'gave_up'

/** Optional controls for {@link remoteStream}; defaults preserve production behaviour. */
export interface RemoteStreamControl {
  /** Stop the stream/reconnect loop programmatically (used instead of process signals). */
  signal?: AbortSignal
  /** Reconnect backoff base/cap in ms (defaults 1000 / 30000). */
  backoffBaseMs?: number
  backoffCapMs?: number
  /** Max reconnect attempts after an unexpected close before giving up (default 6). */
  maxReconnects?: number
  /** WS keep-alive ping interval in ms (default 15000). A missed pong terminates the
   *  socket so a half-open connection reconnects instead of hanging silently. */
  pingMs?: number
  /** Lifecycle observer (test hook). */
  onEvent?: (ev: StreamConnEvent) => void
  /** Called with each decoded run event (plaintext or decrypted), in addition to
   *  the normal stdout forwarding. Lets an in-process consumer (e.g. the remote
   *  web viewer) buffer events without re-implementing the WS/decrypt plumbing. */
  onRunEvent?: (event: RunEvent) => void
  /** When true, do not write events to process.stdout — the consumer takes them
   *  via {@link onRunEvent} instead. Unset preserves the CLI stdout behaviour. */
  suppressStdout?: boolean
  /** On reconnect exhaustion, whether to emit the synthetic `error(stream_
   *  disconnected)` + `status:failed` terminal. Defaults to TRUE (unchanged CLI
   *  behaviour). The Gateway sets this FALSE — a dropped event transport is NOT a
   *  task failure; it reconciles authoritative status instead. */
  emitDisconnectTerminal?: boolean
  /** Called once when the stream gives up (reconnects exhausted or fatal). Lets a
   *  consumer trigger authoritative status reconciliation without treating the
   *  transport drop as a terminal run result. */
  onGiveUp?: (reason: string) => void
  /** NODE source cursor for journaled replay (run_event_replay_v1). When set, the
   *  subscribe carries `after_sequence`; the node serves replay+live via
   *  run_replay_event (source_sequence). NOT a Gateway task cursor. */
  afterSequence?: number
  /** Called once with the node's ReplayMetadata (before any replay event). */
  onReplayMeta?: (meta: Record<string, unknown> | null) => void
  /** Called for each replay/live source event with its NODE source_sequence
   *  (encrypted runs are decrypted first). Used instead of onRunEvent in replay mode. */
  onSourceEvent?: (event: RunEvent, sourceSequence: number) => void
}

/** Outcome of a single subscriber connection attempt. */
type StreamOutcome =
  | { kind: 'terminal' }              // a terminal status event was printed → done
  | { kind: 'closed' }               // socket closed/errored before terminal → reconnect
  | { kind: 'fatal'; reason: string } // relay_error / 401 → do not reconnect

/**
 * Connect to relay, subscribe to a run's event stream, print each event as JSONL to stdout.
 * Resolves when a terminal event is received.
 *
 * For encrypted runs (started with --encrypt), reads the event AES key from the local
 * run record (written by remoteRunStart), decrypts each encrypted_run_event, and prints
 * the same VibeEvent JSONL schema as plaintext runs.
 *
 * Robustness (fixes the JOZ-37 false-stall class):
 *  - A broken downstream pipe (consumer gone → EPIPE/backpressure on stdout) is handled,
 *    not left as an unhandled `'error'` that crashes the process mid-stream.
 *  - An unexpected WebSocket close/error BEFORE a terminal event no longer ends the stream
 *    silently. The subscriber reconnects and re-subscribes with capped exponential backoff
 *    (the relay does not buffer past events, but live events resume — keeping the caller's
 *    activity watchdog fed). A WS keep-alive ping detects half-open sockets.
 *  - If the stream truly cannot be re-established (reconnects exhausted), an explicit
 *    structured terminal (`error` code=stream_disconnected + `status:failed`) is emitted so
 *    the caller (Symphony) sees a clear failure reason instead of silent inactivity.
 *  - 401 / relay_error are fatal (no reconnect); the token is never logged.
 */
export async function remoteStream(
  relay: string,
  token: string,
  runId: string,
  control?: RemoteStreamControl,
): Promise<void> {
  // Read event AES key from local run record (set during run_start --encrypt, if applicable).
  const localRecord = tryReadRun(runId)
  const eventAesKey = localRecord?.event_aes_key
  const emit = (ev: StreamConnEvent): void => control?.onEvent?.(ev)

  // ── stdout pipe guard ───────────────────────────────────────────────────────
  // If the downstream consumer (e.g. Symphony's port) closes, Node emits an
  // async 'error' (EPIPE) on stdout. Without a listener that crashes the whole
  // process — exactly the kind of silent stream death we are fixing. Catch it,
  // stop streaming (there is no one left to forward to), and exit cleanly.
  let finished = false
  let stopped = false
  let activeWs: WebSocket | null = null
  const onStdoutError = (): void => {
    stopped = true
    finished = true
    try { activeWs?.close() } catch { /* ignore */ }
  }
  process.stdout.on('error', onStdoutError)

  const safeWrite = (line: string): void => {
    if (finished || stopped) return
    try { process.stdout.write(line) } catch { /* downstream gone; onStdoutError handles it */ }
  }
  /** Forward one event; returns true if it was terminal. Delivers to an in-process
   *  consumer via onRunEvent (if set) and to stdout unless suppressed. */
  const printEvent = (event: RunEvent): boolean => {
    try { control?.onRunEvent?.(event) } catch { /* a buggy consumer must not kill the stream */ }
    if (!control?.suppressStdout) safeWrite(JSON.stringify(event) + '\n')
    return isTerminal(event)
  }

  // ── shutdown plumbing (abortable for tests) ─────────────────────────────────
  if (control?.signal) {
    if (control.signal.aborted) { stopped = true }
    else control.signal.addEventListener('abort', () => {
      stopped = true
      try { activeWs?.close() } catch { /* ignore */ }
    }, { once: true })
  }

  const pingMs = control?.pingMs ?? 15_000

  const connectOnce = (): Promise<StreamOutcome> => new Promise<StreamOutcome>((resolve) => {
    emit('connecting')
    const ws = new WebSocket(relayUrl(relay, token))
    activeWs = ws
    let settled = false
    let hb: ReturnType<typeof setInterval> | null = null
    let alive = true
    const finish = (outcome: StreamOutcome): void => {
      if (settled) return
      settled = true
      if (hb) clearInterval(hb)
      resolve(outcome)
    }

    ws.on('open', () => {
      emit('subscribed')
      sendMsg(ws, {
        version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(),
        type: 'run_stream_subscribe', run_id: runId,
        ...(control?.afterSequence !== undefined ? { after_sequence: control.afterSequence } : {}),
      })
      // Keep-alive: a half-open socket never fires 'close'. If the previous ping
      // went unanswered, terminate so the reconnect loop takes over.
      hb = setInterval(() => {
        if (!alive) { try { ws.terminate() } catch { /* ignore */ } ; return }
        alive = false
        try { ws.ping() } catch { /* ignore */ }
      }, pingMs)
    })
    ws.on('pong', () => { alive = true })

    ws.on('message', (raw) => {
      alive = true // any inbound traffic proves liveness
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        if (msg.type === 'run_event' && msg.run_id === runId) {
          // Plaintext event (unencrypted run)
          if (printEvent(msg.event)) { try { ws.close() } catch { /* ignore */ } ; finish({ kind: 'terminal' }) }
        } else if ((msg as { type?: string }).type === 'encrypted_run_event'
                   && (msg as { run_id?: string }).run_id === runId) {
          // MVP 4C: encrypted event — decrypt and print the same VibeEvent schema
          const enc = msg as EncryptedRunEventMsg
          if (!eventAesKey) {
            process.stderr.write('[vibe] received encrypted_run_event but run has no local event key\n')
            return
          }
          try {
            const event = decryptEvent(eventAesKey, { nonce: enc.nonce, ciphertext: enc.ciphertext }) as RunEvent
            if (printEvent(event)) { try { ws.close() } catch { /* ignore */ } ; finish({ kind: 'terminal' }) }
          } catch (err) {
            process.stderr.write(`[vibe] failed to decrypt event: ${(err as Error).message}\n`)
          }
        } else if (msg.type === 'run_replay_meta' && (msg as { run_id?: string }).run_id === runId) {
          try { control?.onReplayMeta?.((msg as { metadata: Record<string, unknown> | null }).metadata) } catch { /* consumer error must not kill the stream */ }
        } else if (msg.type === 'run_replay_event' && (msg as { run_id?: string }).run_id === runId) {
          // Journaled replay/live event with its NODE source_sequence. Encrypted runs
          // arrive as an `encrypted` envelope — decrypt with the run event key; the
          // relay never saw plaintext.
          const rm = msg as { source_sequence: number; event?: RunEvent; encrypted?: { nonce: string; ciphertext: string } }
          let ev: RunEvent | undefined = rm.event
          if (!ev && rm.encrypted) {
            if (!eventAesKey) { process.stderr.write('[vibe] received encrypted run_replay_event but run has no local event key\n'); return }
            try { ev = decryptEvent(eventAesKey, rm.encrypted) as RunEvent } catch (err) { process.stderr.write(`[vibe] failed to decrypt replay event: ${(err as Error).message}\n`); return }
          }
          if (!ev) return
          try { control?.onSourceEvent?.(ev, rm.source_sequence) } catch { /* consumer error must not kill the stream */ }
          if (!control?.suppressStdout) safeWrite(JSON.stringify(ev) + '\n')
          if (isTerminal(ev)) { try { ws.close() } catch { /* ignore */ } ; finish({ kind: 'terminal' }) }
        } else if (msg.type === 'relay_error') {
          try { ws.terminate() } catch { /* ignore */ }
          finish({ kind: 'fatal', reason: `${msg.code}: ${msg.message}` })
        }
        // run_stream_subscribe_ack is silently accepted — no action needed
      } catch { /* ignore malformed frame */ }
    })

    // A 401 at the WS handshake is a definite auth failure — do not reconnect.
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        process.stderr.write('[vibe] relay rejected stream: 401 unauthorized — check VIBE_RELAY_TOKEN [token REDACTED]\n')
        try { ws.terminate() } catch { /* ignore */ }
        finish({ kind: 'fatal', reason: 'relay returned 401 unauthorized (check token)' })
      }
      // other unexpected responses fall through to 'error'/'close' (transient → reconnect)
    })

    ws.on('close', () => { emit('closed'); finish({ kind: 'closed' }) })
    // Transient transport error → treat as a close and reconnect; never reject silently.
    ws.on('error', () => { finish({ kind: 'closed' }) })
  })

  try {
    let attempt = 0
    const maxReconnects = control?.maxReconnects ?? 6
    let lastReason = 'relay event stream closed before a terminal status'

    while (!stopped) {
      const outcome = await connectOnce()
      activeWs = null
      if (outcome.kind === 'terminal') { finished = true; return }
      if (stopped) return
      if (outcome.kind === 'fatal') { lastReason = outcome.reason; break }

      // closed without terminal → reconnect with capped backoff, bounded attempts
      if (attempt >= maxReconnects) {
        lastReason = `relay event stream closed before a terminal status (gave up after ${attempt} reconnect attempt(s))`
        break
      }
      const delay = nextBackoffMs(attempt, { baseMs: control?.backoffBaseMs, capMs: control?.backoffCapMs })
      attempt++
      emit('reconnect_scheduled')
      process.stderr.write(`[vibe] event stream closed — reconnecting in ${delay}ms (attempt ${attempt}/${maxReconnects})\n`)
      await sleep(delay, control?.signal)
    }

    if (stopped) return

    // Give up: emit an explicit, structured terminal so the caller gets a clear
    // failure instead of silent inactivity. Routed through printEvent (not raw
    // safeWrite) so an in-process consumer (onRunEvent) also learns the stream
    // died and the events respect suppressStdout. Never silently stop forwarding.
    emit('gave_up')
    try { control?.onGiveUp?.(lastReason) } catch { /* a buggy consumer must not crash cleanup */ }
    // The Gateway disables this: a transport give-up is NOT an authoritative run
    // failure, so it must not fabricate a terminal status. Default TRUE keeps the
    // CLI's clear-failure behaviour for callers (e.g. Symphony) that need one.
    if (control?.emitDisconnectTerminal !== false) {
      const ts = t()
      printEvent({
        run_id: runId, ts, type: 'error', code: 'stream_disconnected',
        message: `${lastReason} — the run may still be active on the node`,
      } satisfies RunEvent)
      printEvent({ run_id: runId, ts, type: 'status', status: 'failed' } satisfies RunEvent)
    }
    finished = true
  } finally {
    process.stdout.removeListener('error', onStdoutError)
  }
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

/**
 * One-shot: connect to relay, send run_stop_request to owning node, return updated RunRecord.
 * If the local run record has a stop_aes_key (set during encrypted run_start), sends an
 * encrypted stop request and decrypts the ack. Otherwise uses the plaintext path.
 */
export async function remoteStop(relay: string, token: string, runId: string): Promise<RunRecord> {
  // Read stop key from local run record (set during remoteRunStart --encrypt, if applicable).
  const localRecord = tryReadRun(runId)
  const stopAesKey = localRecord?.stop_aes_key

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
      if (stopAesKey) {
        // MVP 4D: encrypt the stop request — relay only sees run_id/req_id/nonce/ciphertext.
        const payload: RunStopPayload = { reason: 'requested_by_user' }
        const enc = encryptEvent(stopAesKey, payload)
        ws.send(JSON.stringify({
          version: 1, kind: 'encrypted', from: 'cli', to: 'relay', ts: t(),
          type: 'encrypted_run_stop_request',
          req_id: reqId, run_id: runId, key_id: runId,
          nonce: enc.nonce, ciphertext: enc.ciphertext,
        } satisfies EncryptedRunStopRequestMsg))
      } else {
        sendMsg(ws, {
          version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(),
          type: 'run_stop_request', req_id: reqId, run_id: runId, reason: 'requested_by_user',
        })
      }
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        const msgType = (msg as { type?: string }).type

        if (stopAesKey && msgType === 'encrypted_run_stop_ack') {
          // MVP 4D: decrypt the ack
          const enc = msg as EncryptedRunStopAckMsg
          if (enc.req_id !== reqId) return
          ws.close()
          try {
            const result = decryptEvent(stopAesKey, { nonce: enc.nonce, ciphertext: enc.ciphertext }) as unknown as RunStopAckPayload
            if (result.ok && result.record) {
              done(result.record)
            } else {
              done(undefined, new Error(`${result.code ?? 'stop_failed'}: ${result.error ?? 'unknown error'}`))
            }
          } catch (err) {
            done(undefined, new Error(`Failed to decrypt stop ack: ${(err as Error).message}`))
          }
        } else if (msgType === 'run_stop_ack' && (msg as { req_id?: string }).req_id === reqId) {
          // Plaintext ack (or error ack for encrypted stop when relay reports routing error)
          const ack = msg as import('./types.js').RunStopAckMsg
          ws.close()
          if (ack.ok && ack.record) {
            done(ack.record)
          } else {
            done(undefined, new Error(`${ack.code ?? 'stop_failed'}: ${ack.error ?? 'unknown error'}`))
          }
        } else if (msgType === 'relay_error') {
          const errMsg = msg as import('./types.js').RelayErrorMsg
          ws.terminate()
          reject(new Error(`${errMsg.code}: ${errMsg.message}`))
        }
      } catch {}
    })

    ws.on('close', () => done(undefined, new Error('Relay connection closed before run_stop_ack')))
    ws.on('error', (err) => done(undefined, err))
  })
}

/** One-shot: list Vibe-owned terminal sessions on a node (request/reply). */
export async function remoteTerminalList(relay: string, token: string, nodeId: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))
    const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
    let settled = false
    const done = (v?: string[], err?: Error): void => { if (settled) return; settled = true; clearTimeout(timeout); try { ws.close() } catch { /* ignore */ } ; v ? resolve(v) : reject(err!) }
    const timeout = setTimeout(() => { ws.terminate(); done(undefined, new Error('Timeout waiting for terminal_session_list_ack')) }, 10_000)
    ws.on('open', () => sendMsg(ws, { version: 1, kind: 'plaintext', from: 'cli', to: nodeId, ts: t(), type: 'terminal_session_list', req_id: reqId }))
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        const m = msg as { type?: string; req_id?: string }
        if (m.type === 'terminal_session_list_ack' && m.req_id === reqId) {
          const ack = msg as import('./types.js').TerminalSessionListAckMsg
          ack.ok ? done(ack.sessions ?? []) : done(undefined, new Error(`${ack.code ?? 'error'}: ${ack.message ?? 'list failed'}`))
        } else if (m.type === 'relay_error') {
          const e = msg as { code: string; message: string }
          done(undefined, new Error(`${e.code}: ${e.message}`))
        }
      } catch { /* ignore */ }
    })
    ws.on('close', () => done(undefined, new Error('Relay connection closed before terminal_session_list_ack')))
    ws.on('error', (err) => done(undefined, err as Error))
  })
}

export interface TerminalKillResult { ok: boolean; result?: 'killed' | 'not_owned' | 'missing'; message?: string; code?: string }

/** One-shot: ask a node to kill a Vibe-owned terminal session (request/reply).
 *  Resolves with the node's result (incl. not_owned/missing); rejects only on
 *  transport/relay errors. */
export async function remoteTerminalKill(relay: string, token: string, nodeId: string, session: string): Promise<TerminalKillResult> {
  return new Promise<TerminalKillResult>((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))
    const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
    let settled = false
    const done = (v?: TerminalKillResult, err?: Error): void => { if (settled) return; settled = true; clearTimeout(timeout); try { ws.close() } catch { /* ignore */ } ; v ? resolve(v) : reject(err!) }
    const timeout = setTimeout(() => { ws.terminate(); done(undefined, new Error('Timeout waiting for terminal_session_kill_ack')) }, 10_000)
    ws.on('open', () => sendMsg(ws, { version: 1, kind: 'plaintext', from: 'cli', to: nodeId, ts: t(), type: 'terminal_session_kill', req_id: reqId, session }))
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        const m = msg as { type?: string; req_id?: string }
        if (m.type === 'terminal_session_kill_ack' && m.req_id === reqId) {
          const ack = msg as import('./types.js').TerminalSessionKillAckMsg
          done({ ok: ack.ok, result: ack.result, message: ack.message, code: ack.code })
        } else if (m.type === 'relay_error') {
          const e = msg as { code: string; message: string }
          done(undefined, new Error(`${e.code}: ${e.message}`))
        }
      } catch { /* ignore */ }
    })
    ws.on('close', () => done(undefined, new Error('Relay connection closed before terminal_session_kill_ack')))
    ws.on('error', (err) => done(undefined, err as Error))
  })
}

/**
 * One-shot, read-only: connect to relay, send a run_status_request to the owning
 * node, and return its authoritative RunRecord. Unlike `vibe symphony status`
 * without --relay (which reads the *local* record and is stale for remote runs),
 * this reflects the node's true run state — used by Symphony's stall watchdog to
 * avoid false-parking a run that actually completed/failed. No side effects on
 * the run. The relay/node never receive the token in the record; redaction in
 * the node daemon already strips secrets from any persisted record.
 */
export async function remoteRunStatus(relay: string, token: string, runId: string): Promise<RunRecord> {
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
      done(undefined, new Error('Timeout waiting for run_status_ack from relay'))
    }, 10_000)

    ws.on('open', () => {
      sendMsg(ws, {
        version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(),
        type: 'run_status_request', req_id: reqId, run_id: runId,
      })
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        const msgType = (msg as { type?: string }).type

        if (msgType === 'run_status_ack' && (msg as { req_id?: string }).req_id === reqId) {
          const ack = msg as import('./types.js').RunStatusAckMsg
          ws.close()
          if (ack.ok && ack.record) {
            done(ack.record)
          } else {
            done(undefined, new Error(`${ack.code ?? 'status_failed'}: ${ack.error ?? 'unknown error'}`))
          }
        } else if (msgType === 'relay_error') {
          const errMsg = msg as import('./types.js').RelayErrorMsg
          ws.terminate()
          reject(new Error(`${errMsg.code}: ${errMsg.message}`))
        }
      } catch {}
    })

    ws.on('close', () => done(undefined, new Error('Relay connection closed before run_status_ack')))
    ws.on('error', (err) => done(undefined, err))
  })
}

/** The authoritative AgentTaskResult of a remote run (run_result_v1). */
export interface RemoteRunResult { result_status: string; result: AgentTaskResultV1 | null }

/**
 * One-shot, read-only: fetch the durable AgentTaskResult for a remote run by exact
 * run id. For an ENCRYPTED run the node returns the result CIPHERTEXT (relay never
 * sees plaintext); this decrypts it with the run event key from the local run
 * record and revalidates it. A node without run_result_v1 (or no result) yields
 * result_status 'missing'. No side effects on the run.
 */
export async function remoteRunResult(relay: string, token: string, runId: string): Promise<RemoteRunResult> {
  const localRecord = tryReadRun(runId)
  const eventAesKey = localRecord?.event_aes_key
  return new Promise<RemoteRunResult>((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))
    const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
    let settled = false
    const done = (v?: RemoteRunResult, err?: Error): void => { if (settled) return; settled = true; clearTimeout(timeout); v ? resolve(v) : reject(err!) }
    const timeout = setTimeout(() => { ws.terminate(); done(undefined, new Error('Timeout waiting for run_result_ack from relay')) }, 10_000)
    ws.on('open', () => { sendMsg(ws, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(), type: 'run_result_request', req_id: reqId, run_id: runId }) })
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        const msgType = (msg as { type?: string }).type
        if (msgType === 'run_result_ack' && (msg as { req_id?: string }).req_id === reqId) {
          const ack = msg as import('./types.js').RunResultAckMsg
          ws.close()
          if (!ack.ok) { done(undefined, new Error(`${ack.code ?? 'result_failed'}: ${ack.error ?? 'unknown error'}`)); return }
          const status = ack.result_status ?? 'missing'
          let result: AgentTaskResultV1 | null = null
          try {
            if (ack.encrypted && eventAesKey) { const dec = decryptEvent(eventAesKey, ack.encrypted) as unknown; const v = validateTaskResult(dec); result = v.ok ? v.value : null }
            else if (ack.result) { const v = validateTaskResult(ack.result); result = v.ok ? v.value : null }
          } catch { result = null }
          // An 'available' status whose content failed to decrypt/validate is 'invalid'.
          done({ result_status: status === 'available' && !result ? 'invalid' : status, result })
        } else if (msgType === 'relay_error') { const e = msg as import('./types.js').RelayErrorMsg; ws.terminate(); reject(new Error(`${e.code}: ${e.message}`)) }
      } catch { /* ignore */ }
    })
    ws.on('close', () => done(undefined, new Error('Relay connection closed before run_result_ack')))
    ws.on('error', (err) => done(undefined, err))
  })
}

/** workspace_lease_v1: one-shot lease op against a specific node. Resolves with the
 *  ack; a structured `workspace_lease_*` failure rejects with an Error whose `.code`
 *  is the sanitized lease code. Only bounded opaque data crosses the relay. */
export class RemoteLeaseError extends Error { constructor(message: string, public readonly code: string) { super(message); this.name = 'RemoteLeaseError' } }
function oneShotLease(relay: string, token: string, request: (reqId: string) => Record<string, unknown>): Promise<import('./types.js').WorkspaceLeaseAckMsg> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))
    const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
    let settled = false
    const done = (ack?: import('./types.js').WorkspaceLeaseAckMsg, err?: Error): void => { if (settled) return; settled = true; clearTimeout(timeout); ack ? resolve(ack) : reject(err!) }
    const timeout = setTimeout(() => { ws.terminate(); done(undefined, new RemoteLeaseError('timeout waiting for workspace_lease_ack', 'workspace_lease_unavailable')) }, 10_000)
    ws.on('open', () => sendMsg(ws, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(), req_id: reqId, ...request(reqId) } as never))
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as RelayMessage
        if ((m as { type?: string }).type === 'workspace_lease_ack' && (m as { req_id?: string }).req_id === reqId) { ws.close(); done(m as import('./types.js').WorkspaceLeaseAckMsg) }
        else if ((m as { type?: string }).type === 'relay_error' && (m as { req_id?: string }).req_id === reqId) { const e = m as import('./types.js').RelayErrorMsg; ws.terminate(); done(undefined, new RemoteLeaseError(e.message ?? 'relay could not route the request', e.code ?? 'workspace_lease_unavailable')) }
      } catch { /* ignore */ }
    })
    ws.on('close', () => done(undefined, new RemoteLeaseError('relay closed before workspace_lease_ack', 'workspace_lease_unavailable')))
    ws.on('error', (err) => done(undefined, new RemoteLeaseError(err.message, 'workspace_lease_unavailable')))
  })
}
function unwrapLease(ack: import('./types.js').WorkspaceLeaseAckMsg): WorkspaceLeaseV1 {
  if (!ack.ok || !ack.lease) throw new RemoteLeaseError(ack.error ?? 'workspace lease operation failed', ack.code ?? 'workspace_lease_invalid')
  return ack.lease
}
export async function remoteWorkspaceLeaseAcquire(relay: string, token: string, nodeId: string, workflowId: string, workspaceKey: string): Promise<{ lease: WorkspaceLeaseV1; created: boolean }> {
  const ack = await oneShotLease(relay, token, () => ({ type: 'workspace_lease_acquire', node_id: nodeId, workflow_id: workflowId, workspace_key: workspaceKey, mode: 'exclusive' }))
  return { lease: unwrapLease(ack), created: ack.created === true }
}
export async function remoteWorkspaceLeaseGet(relay: string, token: string, nodeId: string, leaseId: string): Promise<WorkspaceLeaseV1> {
  return unwrapLease(await oneShotLease(relay, token, () => ({ type: 'workspace_lease_get', node_id: nodeId, workspace_lease_id: leaseId })))
}
export async function remoteWorkspaceLeaseRelease(relay: string, token: string, nodeId: string, leaseId: string): Promise<WorkspaceLeaseV1> {
  return unwrapLease(await oneShotLease(relay, token, () => ({ type: 'workspace_lease_release', node_id: nodeId, workspace_lease_id: leaseId })))
}
/** workspace_lease_v1: observe a FRESH workspace revision on a node (read-only). Only
 *  bounded revision evidence crosses the relay; the physical path stays Node-local. */
export function remoteWorkspaceRevisionObserve(relay: string, token: string, nodeId: string, workspaceKey: string): Promise<import('../lib/workspace-lease.js').WorkspaceRevision> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))
    const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
    let settled = false
    const done = (rev?: import('../lib/workspace-lease.js').WorkspaceRevision, err?: Error): void => { if (settled) return; settled = true; clearTimeout(timeout); rev ? resolve(rev) : reject(err!) }
    const timeout = setTimeout(() => { ws.terminate(); done(undefined, new RemoteLeaseError('timeout waiting for workspace_revision_ack', 'workspace_revision_unavailable')) }, 10_000)
    ws.on('open', () => sendMsg(ws, { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: t(), req_id: reqId, type: 'workspace_revision_observe', node_id: nodeId, workspace_key: workspaceKey } as never))
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as RelayMessage
        if ((m as { type?: string }).type === 'workspace_revision_ack' && (m as { req_id?: string }).req_id === reqId) {
          const a = m as import('./types.js').WorkspaceRevisionAckMsg
          ws.close()
          if (a.ok && a.revision) done(a.revision); else done(undefined, new RemoteLeaseError(a.error ?? 'revision observation failed', a.code ?? 'workspace_revision_unavailable'))
        } else if ((m as { type?: string }).type === 'relay_error' && (m as { req_id?: string }).req_id === reqId) {
          const e = m as import('./types.js').RelayErrorMsg; ws.terminate(); done(undefined, new RemoteLeaseError(e.message ?? 'relay could not route the request', e.code ?? 'workspace_revision_unavailable'))
        }
      } catch { /* ignore */ }
    })
    ws.on('close', () => done(undefined, new RemoteLeaseError('relay closed before workspace_revision_ack', 'workspace_revision_unavailable')))
    ws.on('error', (err) => done(undefined, new RemoteLeaseError(err.message, 'workspace_revision_unavailable')))
  })
}

/**
 * One-shot: connect to relay, send an encrypted approval_response to the owning node.
 * Reads the approval AES key from the local run record (written by remoteRunStart --encrypt).
 * Resolves when the node confirms receipt via an encrypted approval_response_ack.
 */
export async function remoteApprovalRespond(
  relay: string,
  token: string,
  runId: string,
  approvalId: string,
  decision: 'approve' | 'deny',
  message?: string,
): Promise<void> {
  const localRecord = tryReadRun(runId)
  const approvalAesKey = localRecord?.approval_aes_key

  if (!approvalAesKey) {
    throw new Error(`No approval key for run ${runId} — was it started with encryption?`)
  }

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(relayUrl(relay, token))
    const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`

    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      err ? reject(err) : resolve()
    }

    const timeout = setTimeout(() => {
      ws.terminate()
      done(new Error('Timeout waiting for approval_response_ack from relay'))
    }, 10_000)

    ws.on('open', () => {
      const payload: ApprovalResponsePayload = {
        approval_id: approvalId,
        decision,
        ...(message && { message }),
      }
      const enc = encryptEvent(approvalAesKey, payload)
      ws.send(JSON.stringify({
        version: 1, kind: 'encrypted', from: 'cli', to: 'relay', ts: t(),
        type: 'encrypted_approval_response',
        req_id: reqId, run_id: runId, key_id: runId,
        nonce: enc.nonce, ciphertext: enc.ciphertext,
      } satisfies EncryptedApprovalResponseMsg))
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage
        const msgType = (msg as { type?: string }).type

        if (msgType === 'encrypted_approval_response_ack') {
          const enc = msg as EncryptedApprovalResponseAckMsg
          if (enc.req_id !== reqId) return
          ws.close()
          try {
            const result = decryptEvent(approvalAesKey, { nonce: enc.nonce, ciphertext: enc.ciphertext }) as unknown as ApprovalResponseAckPayload
            if (result.ok) {
              done()
            } else {
              done(new Error(`${result.code ?? 'approval_failed'}: ${result.error ?? 'unknown error'}`))
            }
          } catch (err) {
            done(new Error(`Failed to decrypt approval ack: ${(err as Error).message}`))
          }
        } else if (msgType === 'relay_error') {
          const errMsg = msg as import('./types.js').RelayErrorMsg
          ws.terminate()
          done(new Error(`${errMsg.code}: ${errMsg.message}`))
        }
      } catch {}
    })

    ws.on('close', () => done(new Error('Relay connection closed before approval_response_ack')))
    ws.on('error', (err) => done(err))
  })
}
