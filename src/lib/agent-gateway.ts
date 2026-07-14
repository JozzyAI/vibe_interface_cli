/**
 * Local Agent Task Gateway (Vibe Agent Gateway, layer 2 — LOCAL/mock only).
 *
 * A real, callable HTTP API in front of the EXISTING local run lifecycle. It
 * introduces NO second runner, scheduler, lifecycle state machine, or event
 * schema: it reuses `startRun`/`stopRun`/`readRun`/`readEvents` and projects
 * everything through the canonical contract (`agent-task-contract.ts`).
 *
 *   POST   /v1/tasks            create a task (mock agent, local node)      -> 202 Task
 *   GET    /v1/tasks/:id        current Task projection                     -> 200 Task
 *   GET    /v1/tasks/:id/events Server-Sent Events (canonical TaskEvent)    -> text/event-stream
 *   POST   /v1/tasks/:id/cancel idempotent cancel                           -> 200 Task
 *   GET    /v1/agents           locally-served agents (mock in this layer)  -> 200 { agents }
 *
 * Auth: a DEDICATED API bearer token (Authorization: Bearer <token>), constant-
 * time compared. No query token, no cookie, not the relay/terminal token. The
 * token is never logged or placed in any response/error body. Loopback-only by
 * default. This module performs NO stdout/stderr logging.
 *
 * Scope: LOCAL mock only. Remote Vibe Node execution (Claude Code / Codex over
 * the relay) is deferred to the next layer; a concrete node_id is rejected.
 */
import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentBackend, RunEvent, RunRecord } from '../types.js'
import { startRun, stopRun } from './run-actions.js'
import { readRun } from '../store.js'
import { readEvents } from '../events.js'
import { isLoopbackHost } from './terminal-web.js'
import { remoteRunStart, remoteStream, remoteRunStatus, remoteStop, fetchRemoteNodes } from '../relay/client.js'
import { classifyRunError } from './run-error.js'
import {
  TASK_CONTRACT_VERSION,
  runRecordToTask, runStatusToTaskStatus, runEventToTaskEvent,
  validateCreateTaskRequest, buildAgentDescriptors,
  apiError, runErrorToApiError, apiErrorHttpStatus, isTerminalTaskStatus,
  type Task, type TaskEvent, type TaskEventType, type ApiError,
} from './agent-task-contract.js'

// ── documented, bounded limits (constants) ───────────────────────────────────

/** Documented default port for `vibe api serve`. */
export const DEFAULT_API_PORT = 8787
/** Max accepted request-body size (bytes). Larger bodies are rejected 413. */
export const MAX_BODY_BYTES = 1 << 20 // 1 MiB
/** Per-task in-memory event buffer cap. Replay to a new subscriber is bounded to
 *  the most recent this-many events (oldest are dropped first). */
export const MAX_EVENTS_PER_TASK = 1000
/** Completed tasks retained in memory (for late status/replay). ACTIVE tasks are
 *  never evicted; the oldest completed task is dropped once this is exceeded. */
export const MAX_RETAINED_COMPLETED_TASKS = 100
/** Concurrent NON-terminal (active) tasks. A create at the cap is rejected with
 *  service_unavailable/503 — existing active tasks are never evicted/cancelled. */
export const MAX_ACTIVE_TASKS = 32
/** Agents this LOCAL gateway layer can actually run (remote agents land later). */
export const GATEWAY_LOCAL_AGENTS: readonly string[] = ['mock']

const SSE_HEARTBEAT_MS = 15000
const EVENT_POLL_MS = 200

// ── in-memory task registry (the run lifecycle stays the source of truth) ─────

interface GatewayTask {
  taskId: string
  agent: AgentBackend
  mode: 'local' | 'remote'     // local mock (readEvents poller) vs remote node (remoteStream pump)
  events: TaskEvent[]          // bounded canonical buffer (for replay)
  nextSeq: number              // monotonic per-task sequence
  emittedRunEvents: number     // count of RunEvents already mapped (local poller cursor)
  subscribers: Set<http.ServerResponse>
  terminal: boolean
  cancelInFlight: boolean      // guards against duplicate stop operations
  poll?: NodeJS.Timeout        // local event poller
  abort?: AbortController      // remote remoteStream pump
  pumpActive?: boolean         // a remoteStream pump is currently running
  reconciling?: boolean        // a status-reconciliation loop is in flight
  resumeCount?: number         // bounded pump resumes after transport give-up
  lastRecord?: RunRecord       // last known authoritative remote projection
  completedAt?: number
}

const REMOTE_RECONCILE_ATTEMPTS = 3   // bounded remoteRunStatus checks on stream give-up
const REMOTE_RECONCILE_BACKOFF_MS = 500
const REMOTE_MAX_RESUMES = 3          // bounded pump resumes (never poll indefinitely)

export interface GatewayServer {
  host: string
  port: number
  close(): Promise<void>
}

export interface AgentGatewayOptions {
  host: string
  port: number
  apiToken: string
  /** Override MAX_RETAINED_COMPLETED_TASKS (tests). Active tasks never evicted. */
  maxRetainedCompletedTasks?: number
  /** Override MAX_EVENTS_PER_TASK (tests). */
  maxEventsPerTask?: number
  /** Override MAX_ACTIVE_TASKS (tests). */
  maxActiveTasks?: number
  /** Relay ws URL — enables REMOTE agent execution (Claude Code / Codex on an
   *  online node). When unset, the gateway is local/mock-only (as before). */
  relay?: string
  /** Resolved relay auth token VALUE (never logged). Required with `relay`. */
  relayToken?: string
}

// ── auth ─────────────────────────────────────────────────────────────────────

function bearerMatches(req: http.IncomingMessage, apiToken: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const provided = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(apiToken)
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
}

// ── JSON helpers (structured errors only; never leak stacks or the token) ─────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function sendError(res: http.ServerResponse, err: ApiError, httpStatus: number): void {
  sendJson(res, httpStatus, err)
}

function readBody(req: http.IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false; tooLarge: true }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      // Over the cap: resolve now so the handler can send 413. Do NOT destroy the
      // socket — that would prevent the response from reaching the client. Further
      // inbound data is drained and ignored via the `done` guard.
      if (size > limit) { done = true; resolve({ ok: false, tooLarge: true }); return }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }) } })
    req.on('error', () => { if (!done) { done = true; resolve({ ok: true, text: '' }) } })
  })
}

// ── SSE framing ──────────────────────────────────────────────────────────────

function sseFrame(ev: TaskEvent): string {
  // Canonical TaskEvent envelope as the data payload; monotonic id; typed event.
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/**
 * Deterministic replay cursor semantics (pure).
 *   - no header / negative / non-numeric / malformed -> cursor null -> replay the
 *     WHOLE retained buffer (safe default: never silently omit).
 *   - numeric cursor N -> replay retained events with seq > N (a "latest" or
 *     "future" cursor yields an empty replay; live events still follow).
 *   - `truncated` is true when events between the cursor and the oldest retained
 *     event were evicted (a gap), so the caller can signal it instead of silently
 *     returning a surprising partial history.
 * Live events (after subscribe) are NEVER filtered by the cursor — the cursor
 * only governs REPLAY of the retained buffer.
 */
export function computeSseReplay(
  buffer: TaskEvent[],
  lastEventIdHeader: string | string[] | undefined,
): { events: TaskEvent[]; truncated: boolean; cursor: number | null } {
  const raw = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader
  const cursor = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null
  if (cursor === null) return { events: buffer.slice(), truncated: false, cursor: null }
  const events = buffer.filter((e) => e.seq > cursor)
  const truncated = buffer.length > 0 && buffer[0].seq > cursor + 1
  return { events, truncated, cursor }
}

export function startAgentGateway(opts: AgentGatewayOptions): Promise<GatewayServer> {
  const { host, port, apiToken } = opts
  const maxRetained = opts.maxRetainedCompletedTasks ?? MAX_RETAINED_COMPLETED_TASKS
  const maxEvents = opts.maxEventsPerTask ?? MAX_EVENTS_PER_TASK
  const maxActive = opts.maxActiveTasks ?? MAX_ACTIVE_TASKS
  const relay = opts.relay
  const relayToken = opts.relayToken
  const remoteEnabled = Boolean(relay && relayToken)
  const tasks = new Map<string, GatewayTask>()
  const completedOrder: string[] = [] // FIFO of terminal task ids for eviction
  // Active-task accounting. `activeCount` = registered non-terminal tasks;
  // `pendingCreates` = accepted-but-not-yet-registered creations. The cap check
  // and reservation are done in one SYNCHRONOUS block (no await between them), so
  // concurrent POSTs cannot both pass at the cap.
  let activeCount = 0
  let pendingCreates = 0
  let shuttingDown = false

  // ── event emission + fan-out ───────────────────────────────────────────────

  function pushEvent(task: GatewayTask, ev: TaskEvent): void {
    task.events.push(ev)
    if (task.events.length > maxEvents) task.events.shift()
    const frame = sseFrame(ev)
    for (const res of task.subscribers) { try { res.write(frame) } catch { /* dead socket; close handler prunes */ } }
  }

  function synthEvent(task: GatewayTask, type: TaskEventType, payload: Record<string, unknown>): TaskEvent {
    return { seq: task.nextSeq++, task_id: task.taskId, type, ts: new Date().toISOString(), payload, contract_version: TASK_CONTRACT_VERSION }
  }

  function evictIfNeeded(): void {
    while (completedOrder.length > maxRetained) {
      const victim = completedOrder.shift()!
      const t = tasks.get(victim)
      if (t && t.terminal) tasks.delete(victim) // never evict an active task
    }
  }

  function finishTask(task: GatewayTask): void {
    if (task.terminal) return
    task.terminal = true
    activeCount-- // frees one active slot (completion or cancellation)
    task.completedAt = Date.now()
    if (task.poll) { clearInterval(task.poll); task.poll = undefined }
    if (task.abort) { try { task.abort.abort() } catch { /* ignore */ } task.abort = undefined }
    for (const res of task.subscribers) { try { res.end() } catch { /* already closed */ } }
    task.subscribers.clear()
    completedOrder.push(task.taskId)
    evictIfNeeded()
  }

  function drain(task: GatewayTask): void {
    let all: RunEvent[]
    try { all = readEvents(task.taskId) } catch { return }
    for (let i = task.emittedRunEvents; i < all.length; i++) {
      if (ingest(task, all[i])) { task.emittedRunEvents = i + 1; return }
    }
    task.emittedRunEvents = all.length
  }

  function startPoll(task: GatewayTask): void {
    drain(task)
    if (task.terminal) return
    task.poll = setInterval(() => drain(task), EVENT_POLL_MS)
  }

  /** Emit exactly one canonical terminal event and finish the task. Guarded so
   *  the stream pump and a GET-status reconciliation racing to the same terminal
   *  state can never produce two terminal events. */
  function finishWithTerminal(task: GatewayTask, ev: TaskEvent): void {
    if (task.terminal) return
    pushEvent(task, ev)
    finishTask(task)
  }

  /** Emit one already-decoded RunEvent into a task's canonical stream. Shared by
   *  the local poller (via drain) and the remote pump. Returns true if terminal. */
  function ingest(task: GatewayTask, event: RunEvent): boolean {
    if (task.terminal) return true
    const te = runEventToTaskEvent(event, task.nextSeq)
    if (!te) return false
    task.nextSeq++
    if (te.type === 'task.completed' || te.type === 'task.failed' || te.type === 'task.cancelled') {
      finishWithTerminal(task, te)
      return true
    }
    pushEvent(task, te)
    return false
  }

  /**
   * Fold an AUTHORITATIVE remote RunRecord into gateway state. Preserves terminal
   * monotonicity (a terminal task never regresses) and, the FIRST time a record
   * becomes terminal, emits exactly one matching canonical terminal event and
   * finishes the task (freeing the slot, aborting the pump, closing subscribers,
   * entering completed-retention). Tolerates repeated identical terminal records
   * and stream/GET races. Used by GET, cancel, and stream give-up reconciliation.
   */
  function reconcileRemoteRecord(task: GatewayTask, record: RunRecord): void {
    task.lastRecord = record
    if (task.terminal) return
    const status = runStatusToTaskStatus(record.status)
    if (!isTerminalTaskStatus(status)) return
    const type: TaskEventType = status === 'completed' ? 'task.completed' : status === 'failed' ? 'task.failed' : 'task.cancelled'
    finishWithTerminal(task, synthEvent(task, type, {}))
  }

  /**
   * Remote event source: subscribe to the node's run stream over the relay and
   * feed each RunEvent into the same canonical buffer/subscribers. The relay does
   * not buffer pre-subscribe events, so streaming begins at subscription (same as
   * `vibe run stream`); GET (remoteRunStatus) stays authoritative. A transport
   * give-up is NOT treated as a task failure (`emitDisconnectTerminal:false`) —
   * instead it triggers bounded authoritative status reconciliation.
   */
  function startRemotePump(task: GatewayTask): void {
    if (task.terminal || task.pumpActive) return
    const abort = new AbortController()
    task.abort = abort
    task.pumpActive = true
    void remoteStream(relay!, relayToken!, task.taskId, {
      suppressStdout: true,
      signal: abort.signal,
      emitDisconnectTerminal: false, // a dropped transport is not a run result
      onRunEvent: (event) => { if (!task.terminal) ingest(task, event) },
      onGiveUp: () => { void reconcileViaStatus(task) },
    })
      .catch(() => { /* aborted/failed; terminal handled via ingest or reconcile */ })
      .finally(() => { task.pumpActive = false })
  }

  /**
   * After the stream gives up, discover the authoritative state with BOUNDED
   * backoff (never poll indefinitely):
   *   - terminal    -> reconcileRemoteRecord emits one terminal event + finishes;
   *   - running/queued -> keep the task non-terminal and RESUME the live pump
   *                       (bounded by REMOTE_MAX_RESUMES);
   *   - node offline / relay unavailable -> preserve last known state, back off,
   *     retry; after the bound, leave the task non-terminal with no live pump — a
   *     later GET reconciles, and a new SSE subscriber resumes the pump.
   */
  async function reconcileViaStatus(task: GatewayTask): Promise<void> {
    if (task.terminal || task.reconciling) return
    task.reconciling = true
    try {
      for (let attempt = 0; attempt < REMOTE_RECONCILE_ATTEMPTS && !task.terminal; attempt++) {
        try {
          const record = await remoteRunStatus(relay!, relayToken!, task.taskId)
          reconcileRemoteRecord(task, record)
          if (task.terminal) return
          if ((task.resumeCount ?? 0) < REMOTE_MAX_RESUMES) { task.resumeCount = (task.resumeCount ?? 0) + 1; startRemotePump(task) }
          return
        } catch {
          await new Promise((r) => setTimeout(r, REMOTE_RECONCILE_BACKOFF_MS * (attempt + 1)))
        }
      }
      // Bounded attempts exhausted: leave the task non-terminal (last known state
      // preserved). GET returns the authoritative error; a new SSE subscriber
      // (handleEvents) restarts the pump.
    } finally { task.reconciling = false }
  }

  /** Map a caught remote-run error to a canonical ApiError + HTTP status. */
  function remoteApiError(err: unknown, taskId?: string): { error: ApiError; status: number } {
    const code = classifyRunError(err)
    const message = err instanceof Error ? err.message : String(err)
    const error = runErrorToApiError(code, message, taskId ? { task_id: taskId } : {})
    return { error, status: apiErrorHttpStatus(error.code) }
  }

  // ── route handlers ─────────────────────────────────────────────────────────

  async function handleCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ctype = req.headers['content-type']
    if (typeof ctype === 'string' && ctype && !ctype.includes('application/json')) {
      return sendError(res, apiError('invalid_request', 'Content-Type must be application/json'), 415)
    }
    const body = await readBody(req, MAX_BODY_BYTES)
    if (!body.ok) return sendError(res, apiError('invalid_request', `request body exceeds ${MAX_BODY_BYTES} bytes`), 413)
    let parsed: unknown
    try { parsed = JSON.parse(body.text) } catch { return sendError(res, apiError('invalid_request', 'malformed JSON body'), 400) }

    const v = validateCreateTaskRequest(parsed)
    if (!v.ok) return sendError(res, v.error, 400)
    const reqv = v.value

    // A concrete node_id routes to a REMOTE node; local/auto/absent runs the mock
    // agent locally. Remote execution requires the gateway to be relay-configured.
    const isRemote = Boolean(reqv.node_id && reqv.node_id !== 'local' && reqv.node_id !== 'auto')
    if (isRemote && !remoteEnabled) {
      return sendError(res, apiError('invalid_request', 'remote node execution requires a relay-configured gateway (start `vibe api serve` with --relay / a connect profile); omit node_id to run the local mock', { details: { node_id: reqv.node_id } }), 400)
    }
    if (!isRemote && !GATEWAY_LOCAL_AGENTS.includes(reqv.agent)) {
      return sendError(res, apiError('agent_unavailable', `agent "${reqv.agent}" is not available for local execution (only: ${GATEWAY_LOCAL_AGENTS.join(', ')}); target a remote node with node_id for other agents`), 422)
    }
    // Remote agent validity is enforced by the target node (agent_not_supported).

    // Active-task cap. Count + reserve atomically (this block has no await), so
    // concurrent creates cannot exceed the cap. Existing tasks are NOT evicted.
    if (activeCount + pendingCreates >= maxActive) {
      return sendError(res, apiError('service_unavailable', `too many active tasks (limit ${maxActive}); retry once a task completes`), 503)
    }
    pendingCreates++ // reservation held until the task registers or start fails
    const release = (): void => { pendingCreates-- }

    // Remote preflight: ENCRYPTED execution is mandatory. Fetch the registry, require
    // the node online + advertising the agent, and obtain its encryption key. The
    // preflight is advisory (can race), so authoritative start errors are still
    // mapped below. NEVER fall back to a plaintext run_start.
    let encryptionPublicKey: string | undefined
    if (isRemote) {
      let nodes
      try { nodes = await fetchRemoteNodes(relay!, relayToken!) }
      catch (err) { release(); const m = remoteApiError(err, undefined); return sendError(res, m.error, m.status) }
      const node = nodes.find((n) => n.node_id === reqv.node_id)
      if (!node || node.status !== 'online') { release(); return sendError(res, apiError('node_offline', `node ${reqv.node_id} is offline or unknown`, { details: { node_id: reqv.node_id } }), 503) }
      if (!Array.isArray(node.agents) || !node.agents.includes(reqv.agent)) { release(); return sendError(res, apiError('agent_unavailable', `node ${reqv.node_id} does not advertise agent "${reqv.agent}"`, { details: { node_id: reqv.node_id } }), 422) }
      if (!node.encryption_public_key) { release(); return sendError(res, apiError('service_unavailable', `secure remote execution unavailable: node ${reqv.node_id} advertises no encryption key`, { retryable: false, details: { node_id: reqv.node_id } }), 503) }
      encryptionPublicKey = node.encryption_public_key
    }

    // Prompt text -> a private temp file (both startRun and remoteRunStart take a
    // prompt-file path; remoteRunStart reads it and sends the ENCRYPTED content).
    const promptFile = path.join(os.tmpdir(), `vibe-api-prompt-${crypto.randomBytes(8).toString('hex')}.txt`)
    fs.writeFileSync(promptFile, reqv.input.text, { mode: 0o600 })

    let record: RunRecord
    let started = false
    const mode: 'local' | 'remote' = isRemote ? 'remote' : 'local'
    try {
      if (isRemote) {
        record = await remoteRunStart(relay!, relayToken!, reqv.node_id!, {
          agent: reqv.agent as AgentBackend,
          promptFile,
          workspaceKey: reqv.workspace?.workspace_key,
          // repo_url/branch are DEFERRED in Gateway v1 (rejected at validation) —
          // the node does not clone/prepare a repo before the backend starts.
          permissionMode: reqv.execution?.permission_mode,
          metadata: reqv.metadata,
          encryptionPublicKey, // mandatory — run_start payload is encrypted for the node
        })
      } else {
        // agent === 'mock' and node 'local' are guaranteed here, so startRun cannot
        // hit its process.exit error paths (unsupported agent / unresolved node).
        record = await startRun({
          agent: reqv.agent as AgentBackend,
          node: 'local',
          promptFile,
          workspaceKey: reqv.workspace?.workspace_key,
          permissionMode: reqv.execution?.permission_mode,
          extraMetadata: reqv.metadata,
        })
      }
      started = true
    } catch (err) {
      release() // release the reserved slot; the task never registered
      if (isRemote) { const m = remoteApiError(err); return sendError(res, m.error, m.status) }
      return sendError(res, apiError('internal_error', `failed to start task: ${(err as Error).message}`), 500)
    } finally {
      // Remote: remoteRunStart has already read + encrypted the prompt, so the
      // plaintext temp file is no longer needed — remove it. Local: the detached
      // supervisor may read prompt_file AFTER start (the run owns it), so keep it
      // on success and remove it only if start failed.
      if (isRemote || !started) { try { fs.unlinkSync(promptFile) } catch { /* best effort */ } }
    }

    const task: GatewayTask = {
      taskId: record.run_id, agent: record.agent, mode, events: [], nextSeq: 0,
      emittedRunEvents: 0, subscribers: new Set(), terminal: false, cancelInFlight: false,
    }
    tasks.set(task.taskId, task)
    pendingCreates-- // reservation becomes a live active task
    activeCount++
    pushEvent(task, synthEvent(task, 'task.created', { agent: record.agent }))
    if (mode === 'remote') startRemotePump(task); else startPoll(task)
    sendJson(res, 202, runRecordToTask(record))
  }

  async function handleGet(res: http.ServerResponse, taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)
    let record: RunRecord
    try {
      record = task.mode === 'remote' ? await remoteRunStatus(relay!, relayToken!, taskId) : readRun(taskId)
    } catch (err) {
      // Node offline / relay unavailable: preserve last known state and surface
      // the structured error (do NOT mark the task terminal).
      if (task.mode === 'remote') { const m = remoteApiError(err, taskId); return sendError(res, m.error, m.status) }
      return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)
    }
    // Authoritative GET may be the first to observe a terminal state — fold it in
    // (emits one terminal event, frees the slot, stops the pump) exactly once.
    if (task.mode === 'remote') reconcileRemoteRecord(task, record)
    sendJson(res, 200, runRecordToTask(record))
  }

  function handleEvents(req: http.IncomingMessage, res: http.ServerResponse, taskId: string): void {
    const task = tasks.get(taskId)
    if (!task) return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable proxy buffering (nginx)
    })
    res.write(': connected\n\n')

    // Replay-to-live handoff with NO race window. This block is fully SYNCHRONOUS
    // and `pushEvent` (buffer.push + fan-out) is atomic, so every event is EITHER
    // in the snapshot below (replayed) OR fanned out live after we subscribe —
    // never both, never neither. The snapshot is an explicit cutoff.
    const snapshot = task.events.slice()
    const replay = computeSseReplay(snapshot, req.headers['last-event-id'])
    if (replay.truncated) {
      res.write(': warning: requested Last-Event-ID predates the retained buffer; replaying from the oldest retained event\n\n')
    }
    for (const ev of replay.events) res.write(sseFrame(ev))

    if (task.terminal) { res.end(); return } // terminal already delivered above
    task.subscribers.add(res)
    // A remote task whose transport gave up has no live pump; a new subscriber
    // resumes it (the relay doesn't replay, so live events flow from here on).
    if (task.mode === 'remote' && !task.pumpActive) startRemotePump(task)
    // Disconnecting a subscriber must NOT cancel the task — just prune the listener.
    req.on('close', () => { task.subscribers.delete(res) })
  }

  async function handleCancel(res: http.ServerResponse, taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)

    let record: RunRecord
    try {
      record = task.mode === 'remote' ? await remoteRunStatus(relay!, relayToken!, taskId) : readRun(taskId)
    } catch (err) {
      if (task.mode === 'remote') { const m = remoteApiError(err, taskId); return sendError(res, m.error, m.status) }
      return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)
    }

    // Already terminal (completed/failed/cancelled): return the existing task
    // unchanged — cancellation is idempotent and never re-stops.
    if (isTerminalTaskStatus(runStatusToTaskStatus(record.status)) || task.cancelInFlight) {
      return sendJson(res, 200, runRecordToTask(record))
    }

    task.cancelInFlight = true // guard against concurrent duplicate stop operations
    try {
      if (task.mode === 'remote') {
        const stopped = await remoteStop(relay!, relayToken!, taskId)
        // Reconcile the authoritative stopped record NOW — do not rely on the event
        // pump to deliver the stopped event (it may be lost). This emits the one
        // terminal event and frees the active slot even if the stream never sees it.
        reconcileRemoteRecord(task, stopped)
        sendJson(res, 200, runRecordToTask(stopped))
      } else {
        const stopped = stopRun(taskId)
        drain(task) // process the terminal event now: frees the active slot + notifies subscribers promptly
        sendJson(res, 200, runRecordToTask(stopped))
      }
    } catch (err) {
      // Lost a race to a terminal transition — return the current projection.
      try {
        const cur = task.mode === 'remote' ? await remoteRunStatus(relay!, relayToken!, taskId) : readRun(taskId)
        sendJson(res, 200, runRecordToTask(cur))
      } catch {
        if (task.mode === 'remote') { const m = remoteApiError(err, taskId); sendError(res, m.error, m.status) }
        else sendError(res, apiError('internal_error', 'failed to cancel task'), 500)
      }
    } finally {
      task.cancelInFlight = false
    }
  }

  async function handleAgents(res: http.ServerResponse): Promise<void> {
    // Local mock is always available. When relay-configured, also list agents
    // advertised by ONLINE remote nodes (best-effort; relay hiccups never fail
    // this endpoint — they just omit remote agents).
    const descriptors = buildAgentDescriptors([...GATEWAY_LOCAL_AGENTS])
    if (remoteEnabled) {
      try {
        const nodes = await fetchRemoteNodes(relay!, relayToken!)
        for (const node of nodes) {
          if (node.status === 'online' && Array.isArray(node.agents)) {
            descriptors.push(...buildAgentDescriptors(node.agents, { node_id: node.node_id }))
          }
        }
      } catch { /* relay unreachable — return local agents only */ }
    }
    sendJson(res, 200, { agents: descriptors })
  }

  // ── server ──────────────────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (shuttingDown) return sendError(res, apiError('service_unavailable', 'gateway is shutting down'), 503)
        if (!bearerMatches(req, apiToken)) return sendError(res, apiError('unauthorized', 'missing or invalid bearer token'), 401)

        const url = new URL(req.url ?? '/', 'http://localhost')
        const parts = url.pathname.split('/').filter(Boolean) // ['v1','tasks',':id',...]
        const method = req.method ?? 'GET'

        // /v1/agents
        if (parts.length === 2 && parts[0] === 'v1' && parts[1] === 'agents') {
          if (method !== 'GET') return methodNotAllowed(res, ['GET'])
          return await handleAgents(res)
        }
        // /v1/tasks
        if (parts.length === 2 && parts[0] === 'v1' && parts[1] === 'tasks') {
          if (method !== 'POST') return methodNotAllowed(res, ['POST'])
          return await handleCreate(req, res)
        }
        // /v1/tasks/:id  and sub-resources
        if (parts.length >= 3 && parts[0] === 'v1' && parts[1] === 'tasks') {
          const taskId = decodeURIComponent(parts[2])
          if (!taskId) return sendError(res, apiError('invalid_request', 'missing task id'), 400)
          if (parts.length === 3) {
            if (method !== 'GET') return methodNotAllowed(res, ['GET'])
            return await handleGet(res, taskId)
          }
          if (parts.length === 4 && parts[3] === 'events') {
            if (method !== 'GET') return methodNotAllowed(res, ['GET'])
            return handleEvents(req, res, taskId)
          }
          if (parts.length === 4 && parts[3] === 'cancel') {
            if (method !== 'POST') return methodNotAllowed(res, ['POST'])
            return await handleCancel(res, taskId)
          }
        }
        sendError(res, apiError('task_not_found', 'not found'), 404)
      } catch (err) {
        // Never leak a stack trace; structured error only.
        if (!res.headersSent) sendError(res, apiError('internal_error', 'internal error'), 500)
        else { try { res.end() } catch { /* ignore */ } }
        void err
      }
    })()
  })

  function methodNotAllowed(res: http.ServerResponse, allow: string[]): void {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: allow.join(', ') })
    res.end(JSON.stringify(apiError('invalid_request', 'method not allowed')))
  }

  // Server-level SSE heartbeat keeps connections alive and surfaces dead sockets.
  const heartbeat = setInterval(() => {
    for (const task of tasks.values()) for (const res of task.subscribers) { try { res.write(': keep-alive\n\n') } catch { /* pruned on close */ } }
  }, SSE_HEARTBEAT_MS)
  heartbeat.unref?.()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const boundPort = (server.address() as { port: number }).port
      resolve({
        host,
        port: boundPort,
        close: () => new Promise<void>((r) => {
          // Graceful: stop accepting new work, close SSE clients, clear timers.
          // Running tasks are NOT cancelled — only the API surface stops.
          shuttingDown = true
          clearInterval(heartbeat)
          for (const task of tasks.values()) {
            if (task.poll) { clearInterval(task.poll); task.poll = undefined }
            if (task.abort) { try { task.abort.abort() } catch { /* ignore */ } task.abort = undefined }
            for (const sres of task.subscribers) { try { sres.end() } catch { /* ignore */ } }
            task.subscribers.clear()
          }
          server.close(() => r())
        }),
      })
    })
  })
}
