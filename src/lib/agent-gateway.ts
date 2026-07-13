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
import type { AgentBackend, RunEvent } from '../types.js'
import { startRun, stopRun } from './run-actions.js'
import { readRun } from '../store.js'
import { readEvents } from '../events.js'
import { isLoopbackHost } from './terminal-web.js'
import {
  TASK_CONTRACT_VERSION,
  runRecordToTask, runStatusToTaskStatus, runEventToTaskEvent,
  validateCreateTaskRequest, buildAgentDescriptors,
  apiError, isTerminalTaskStatus,
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
  events: TaskEvent[]          // bounded canonical buffer (for replay)
  nextSeq: number              // monotonic per-task sequence
  emittedRunEvents: number     // count of RunEvents already mapped
  subscribers: Set<http.ServerResponse>
  terminal: boolean
  cancelInFlight: boolean      // guards against duplicate stop operations
  poll?: NodeJS.Timeout
  completedAt?: number
}

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
    for (const res of task.subscribers) { try { res.end() } catch { /* already closed */ } }
    task.subscribers.clear()
    completedOrder.push(task.taskId)
    evictIfNeeded()
  }

  function drain(task: GatewayTask): void {
    let all: RunEvent[]
    try { all = readEvents(task.taskId) } catch { return }
    for (let i = task.emittedRunEvents; i < all.length; i++) {
      const te = runEventToTaskEvent(all[i], task.nextSeq)
      if (te) {
        task.nextSeq++
        pushEvent(task, te)
        if (te.type === 'task.completed' || te.type === 'task.failed' || te.type === 'task.cancelled') {
          task.emittedRunEvents = i + 1
          finishTask(task)
          return
        }
      }
    }
    task.emittedRunEvents = all.length
  }

  function startPoll(task: GatewayTask): void {
    drain(task)
    if (task.terminal) return
    task.poll = setInterval(() => drain(task), EVENT_POLL_MS)
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

    if (reqv.node_id && reqv.node_id !== 'local' && reqv.node_id !== 'auto') {
      return sendError(res, apiError('invalid_request', 'remote node execution is not available on this local gateway (deferred); omit node_id to run locally', { details: { node_id: reqv.node_id } }), 400)
    }
    if (!GATEWAY_LOCAL_AGENTS.includes(reqv.agent)) {
      return sendError(res, apiError('agent_unavailable', `agent "${reqv.agent}" is not available on this local gateway (only: ${GATEWAY_LOCAL_AGENTS.join(', ')})`), 422)
    }

    // Active-task cap. Count + reserve atomically (this block has no await), so
    // concurrent creates cannot exceed the cap. Existing tasks are NOT evicted.
    if (activeCount + pendingCreates >= maxActive) {
      return sendError(res, apiError('service_unavailable', `too many active tasks (limit ${maxActive}); retry once a task completes`), 503)
    }
    pendingCreates++ // reservation held until the task registers or startRun fails

    // Prompt text -> a private temp file (startRun takes a prompt-file path).
    const promptFile = path.join(os.tmpdir(), `vibe-api-prompt-${crypto.randomBytes(8).toString('hex')}.txt`)
    fs.writeFileSync(promptFile, reqv.input.text, { mode: 0o600 })

    let record
    try {
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
    } catch (err) {
      pendingCreates-- // release the reserved slot; the task never registered
      return sendError(res, apiError('internal_error', `failed to start task: ${(err as Error).message}`), 500)
    }

    const task: GatewayTask = {
      taskId: record.run_id, agent: record.agent, events: [], nextSeq: 0,
      emittedRunEvents: 0, subscribers: new Set(), terminal: false, cancelInFlight: false,
    }
    tasks.set(task.taskId, task)
    pendingCreates-- // reservation becomes a live active task
    activeCount++
    pushEvent(task, synthEvent(task, 'task.created', { agent: record.agent }))
    startPoll(task)
    sendJson(res, 202, runRecordToTask(record))
  }

  function handleGet(res: http.ServerResponse, taskId: string): void {
    if (!tasks.has(taskId)) return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)
    let record
    try { record = readRun(taskId) } catch { return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404) }
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
    // Disconnecting a subscriber must NOT cancel the task — just prune the listener.
    req.on('close', () => { task.subscribers.delete(res) })
  }

  function handleCancel(res: http.ServerResponse, taskId: string): void {
    const task = tasks.get(taskId)
    if (!task) return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)

    let record
    try { record = readRun(taskId) } catch { return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404) }

    // Already terminal (completed/failed/cancelled): return the existing task
    // unchanged — cancellation is idempotent and never re-stops.
    if (isTerminalTaskStatus(runStatusToTaskStatus(record.status)) || task.cancelInFlight) {
      return sendJson(res, 200, runRecordToTask(record))
    }

    task.cancelInFlight = true // guard against concurrent duplicate stop operations
    try {
      const stopped = stopRun(taskId)
      drain(task) // process the terminal event now: frees the active slot + notifies subscribers promptly
      sendJson(res, 200, runRecordToTask(stopped))
    } catch {
      // Lost a race to a terminal transition — return the current projection.
      try { sendJson(res, 200, runRecordToTask(readRun(taskId))) }
      catch { sendError(res, apiError('internal_error', 'failed to cancel task'), 500) }
    } finally {
      task.cancelInFlight = false
    }
  }

  function handleAgents(res: http.ServerResponse): void {
    sendJson(res, 200, { agents: buildAgentDescriptors([...GATEWAY_LOCAL_AGENTS]) })
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
          return handleAgents(res)
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
            return handleGet(res, taskId)
          }
          if (parts.length === 4 && parts[3] === 'events') {
            if (method !== 'GET') return methodNotAllowed(res, ['GET'])
            return handleEvents(req, res, taskId)
          }
          if (parts.length === 4 && parts[3] === 'cancel') {
            if (method !== 'POST') return methodNotAllowed(res, ['POST'])
            return handleCancel(res, taskId)
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
            for (const sres of task.subscribers) { try { sres.end() } catch { /* ignore */ } }
            task.subscribers.clear()
          }
          server.close(() => r())
        }),
      })
    })
  })
}
