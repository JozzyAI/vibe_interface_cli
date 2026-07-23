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
import { workflowUiHtml } from './workflow-ui.js'
import { workflowBuilderUiHtml } from './workflow-builder-ui.js'
import { remoteRunStart, remoteStream, remoteRunStatus, remoteStop, remoteRunResult, fetchRemoteNodes } from '../relay/client.js'
import { classifyRunError } from './run-error.js'
import {
  TASK_CONTRACT_VERSION,
  runRecordToTask, runStatusToTaskStatus, runEventToTaskEvent,
  validateCreateTaskRequest, buildAgentDescriptors,
  apiError, runErrorToApiError, apiErrorHttpStatus, isTerminalTaskStatus,
  type Task, type TaskEvent, type TaskEventType, type ApiError,
} from './agent-task-contract.js'
import { computeRequestFingerprint } from './request-fingerprint.js'
import { CWD_CAPABILITY } from '../workspace.js'
import type { GatewayTaskStore, ControlStore } from '../control/store.js'
import { ControlStoreError, type CreateTaskInput, type TaskEventInput, type TaskRecord } from '../control/records.js'
import { validateTaskResult, type AgentTaskResultV1, type TaskResultStatus } from './agent-task-result.js'
import { listWorkflowsController, createWorkflowController, startWorkflowController, getWorkflowController, cancelWorkflowController, getPendingRequestController, answerInputController, decideApprovalController, resumeWorkflowController } from '../workflow/api.js'
import { compileWorkflowController, getWorkflowDraftController, approveWorkflowDraftController } from '../workflow/compiler/api.js'
import { createBuilderSessionController, getBuilderSessionController, listBuilderSessionsController, sendBuilderMessageController, archiveBuilderSessionController } from '../workflow/builder/api.js'
import { streamWorkflowEvents } from '../workflow/event-stream.js'
import { workflowApiError } from '../workflow/api-contract.js'

/** Map a canonical TaskEvent to the durable append shape (no secrets, bounded). */
function toEventInput(ev: TaskEvent): TaskEventInput { return { sequence: ev.seq, event_type: ev.type, ts: ev.ts, payload: ev.payload } }
/** Project a durably-stored TaskRecord to the public Task (for historical/
 *  recovered tasks not held in the in-memory cache). */
function taskRecordToTask(rec: TaskRecord): Task {
  const task: Task = { task_id: rec.task_id, agent: rec.agent as AgentBackend, node_id: rec.node_id ?? 'local', status: rec.status as Task['status'], created_at: rec.created_at, updated_at: rec.updated_at, contract_version: TASK_CONTRACT_VERSION }
  if (rec.error_code || rec.error_message) task.error = { message: rec.error_message ?? rec.error_code ?? 'error', reason: rec.error_code ?? undefined }
  if (rec.metadata) task.metadata = rec.metadata
  return task
}
/** Machine-readable event-history completeness for a durable task (backward-
 *  compatible optional field; older clients ignore it). */
interface TaskHistoryInfo { complete: boolean; incomplete_reason?: string; earliest_retained_sequence: number; boundary_sequence?: number }
function historyField(rec: TaskRecord): TaskHistoryInfo {
  return { complete: !rec.history_incomplete, ...(rec.history_reason ? { incomplete_reason: rec.history_reason } : {}), earliest_retained_sequence: rec.earliest_retained_sequence, ...(rec.history_boundary_sequence != null ? { boundary_sequence: rec.history_boundary_sequence } : {}) }
}
/** Gateway-owned public task id (decoupled from the relay run id for remote tasks
 *  so the task record can be persisted BEFORE the remote start returns a run id). */
function newGatewayTaskId(): string { return 'run_' + crypto.randomBytes(9).toString('hex') }
const TERMINAL_EVENT_TYPES = new Set<TaskEventType>(['task.completed', 'task.failed', 'task.cancelled'])
function terminalStatusFor(type: TaskEventType): 'completed' | 'failed' | 'cancelled' { return type === 'task.completed' ? 'completed' : type === 'task.failed' ? 'failed' : 'cancelled' }

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
  revision: number             // durable ControlStore task revision (1 if unpersisted)
  nodeId: string | null        // routing node id (null/'local' = local mock)
  remoteRunId: string | null   // durable remote run correlation (null until known)
  recovered?: boolean          // rebuilt from the durable store after a restart
  historyTruncated?: boolean   // some early events are no longer retained (durability gap)
  replayCapable?: boolean      // the owning node advertises run_event_replay_v1
  resultCapable?: boolean      // the owning node advertises run_result_v1 (undefined = unknown, e.g. recovered)
  replayMode?: boolean         // this task is served via the source-event replay pump
  replayCutoff?: number        // node replay latest_sequence (catch-up target)
  replayHistoryComplete?: boolean // node reported history_complete_for_request
  catchUpCleared?: boolean     // history_incomplete already cleared after verified catch-up
  pendingResult?: { status: TaskResultStatus; result: AgentTaskResultV1 | null } // remote result fetched via relay before terminalization
}
const RUN_EVENT_REPLAY_CAPABILITY = 'run_event_replay_v1'
const RUN_RESULT_CAPABILITY = 'run_result_v1'
const WORKSPACE_LEASE_CAPABILITY = 'workspace_lease_v1'
const REMOTE_RESULT_ATTEMPTS = 3        // bounded run_result_v1 fetch retries before deferring

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
  /** Durable task store. When set, task identity + canonical event history are
   *  persisted (events durably BEFORE SSE publish) and non-terminal tasks are
   *  recovered on start. When unset, the gateway is purely in-memory (as before). */
  taskStore?: GatewayTaskStore
  /** Recover persisted non-terminal tasks on start (default: true when a store is
   *  set). Rebuilds the in-memory cache/active-slot accounting and reconciles. */
  recoverOnStart?: boolean
  /** Full async ControlStore (same DB as `taskStore`) for the durable Workflow
   *  REST routes (`/v1/workflows*`). When unset, workflow routes are disabled. */
  controlStore?: ControlStore
  /** Lazy accessor for the WorkflowRuntime. Lazy because the runtime's task client
   *  targets THIS gateway over loopback, so it is constructed AFTER listen and
   *  injected here. Returns undefined until wired (routes then answer 503). */
  getWorkflowRuntime?: () => import('../workflow/runtime.js').WorkflowRuntime | undefined
  /** Lazy accessor for the WorkflowCompiler (constructed after listen, like the
   *  runtime). Returns undefined until wired (draft routes then answer 503). */
  getWorkflowCompiler?: () => import('../workflow/compiler/compiler.js').WorkflowCompiler | undefined
  /** Lazy accessor for the Conversational WorkflowBuilderService (constructed after
   *  listen, over the same compiler + control store). Undefined until wired (builder
   *  routes then answer 503). */
  getWorkflowBuilder?: () => import('../workflow/builder/service.js').WorkflowBuilderService | undefined
}

// ── auth ─────────────────────────────────────────────────────────────────────

function constEq(a: string, b: string): boolean {
  const pa = Buffer.from(a), pb = Buffer.from(b)
  return pa.length === pb.length && crypto.timingSafeEqual(pa, pb)
}
/** The browser UI authenticates same-origin fetches via an HttpOnly cookie (JS never
 *  holds the token). Non-UI clients use the Authorization: Bearer header. */
const GW_COOKIE = 'vibe_gw'
function cookieToken(req: http.IncomingMessage): string | undefined {
  const raw = req.headers.cookie
  if (typeof raw !== 'string') return undefined
  for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === GW_COOKIE) return decodeURIComponent(v.join('=')) }
  return undefined
}
function bearerMatches(req: http.IncomingMessage, apiToken: string): boolean {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ') && constEq(header.slice('Bearer '.length), apiToken)) return true
  const ck = cookieToken(req)
  return ck !== undefined && constEq(ck, apiToken)
}

// ── JSON helpers (structured errors only; never leak stacks or the token) ─────

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...(extraHeaders ?? {}) })
  res.end(payload)
}

/** Backward-compatible marker on an idempotent-replay response (old clients ignore it). */
const REPLAY_HEADERS = { 'idempotency-replayed': 'true' } as const
/** Structured, non-echoing conflict for a same-key request whose meaning changed. */
function idempotencyConflict(): ApiError {
  return apiError('idempotency_conflict', 'a task already exists for this idempotency_key with a different request', { retryable: false })
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
  const persist = opts.taskStore
  const recoverOnStart = opts.recoverOnStart ?? Boolean(persist)
  // Relay operations target the bound remote run id (decoupled from the public
  // task_id). Falls back to task_id for the legacy no-store path where they match.
  const relayId = (t: GatewayTask): string => t.remoteRunId ?? t.taskId
  const recoveryTimers = new Set<NodeJS.Timeout>() // bounded recovery/backoff timers

  // Persist a NON-terminal accepted event durably BEFORE publishing it, so a
  // client never sees an event that was not saved. Idempotent duplicates are a
  // no-op; any other durable failure means we do NOT publish (the event isn't
  // durable). Terminal events go through finishWithTerminal (atomic terminalize).
  function persistThenPush(task: GatewayTask, ev: TaskEvent): void {
    if (persist) { try { persist.appendTaskEventDurable(task.taskId, toEventInput(ev)) } catch { return } }
    pushEvent(task, ev)
  }

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
  function finishWithTerminal(task: GatewayTask, ev: TaskEvent, durableError?: { code: string; message: string }): void {
    if (task.terminal) return
    // Persist the durable AgentTaskResult, terminal status (+ optional sanitized
    // error), and exactly one terminal event ATOMICALLY before publishing — so a
    // terminal task never loses its final output. An already-recorded terminal
    // (idempotent) or a transient durable failure still finishes in memory.
    if (persist) {
      const { status, result } = resolveTerminalResult(task, ev)
      try {
        const rec = persist.terminalizeTaskWithResultDurable(task.taskId, task.revision, { status: terminalStatusFor(ev.type), ...(durableError ? { error_code: durableError.code, error_message: durableError.message } : {}) }, toEventInput(ev), status, result)
        task.revision = rec.revision
      } catch { /* already terminal / storage hiccup — proceed with in-memory finish */ }
    }
    pushEvent(task, ev)
    finishTask(task)
  }

  /** Resolve the authoritative AgentTaskResult for a terminalizing task. A remote
   *  async path pre-populates `task.pendingResult` (fetched via the relay result
   *  protocol) BEFORE terminalization; a LOCAL completed task reads its own run
   *  record's authoritative result. A non-completed terminal (failed/cancelled) or
   *  an absent/invalid result yields 'missing'/'invalid' — NEVER a guess from events. */
  function resolveTerminalResult(task: GatewayTask, ev: TaskEvent): { status: TaskResultStatus; result: AgentTaskResultV1 | null } {
    if (task.pendingResult) return task.pendingResult
    if (ev.type === 'task.completed' && task.mode === 'local') {
      try {
        const rec = readRun(task.taskId) as RunRecord & { result_status?: string; task_result?: unknown }
        if (rec.result_status === 'available' && rec.task_result) {
          const v = validateTaskResult(rec.task_result)
          return v.ok ? { status: 'available', result: v.value } : { status: 'invalid', result: null }
        }
      } catch { /* fall through to missing */ }
      return { status: 'missing', result: null }
    }
    return { status: 'missing', result: null }
  }

  /** Backward-compatible task-result projection for the public task API. */
  function resultProjection(taskId: string): Record<string, unknown> {
    if (!persist) return {}
    try {
      const r = persist.getTaskResultDurable(taskId)
      if (!r) return {}
      return { result_status: r.result_status, ...(r.result ? { result: r.result } : {}) }
    } catch { return { result_status: 'invalid' } }
  }

  /** Emit one already-decoded RunEvent into a task's canonical stream. Shared by
   *  the local poller (via drain) and the remote pump. Returns true if terminal. */
  function ingest(task: GatewayTask, event: RunEvent): boolean {
    if (task.terminal) return true
    const te = runEventToTaskEvent(event, task.nextSeq)
    if (!te) return false
    te.task_id = task.taskId // public gateway id (decoupled from the relay run_id)
    task.nextSeq++
    if (TERMINAL_EVENT_TYPES.has(te.type)) {
      // A REMOTE terminal fetches the durable result FIRST (atomic with terminalize);
      // a LOCAL terminal reads its own run record inside finishWithTerminal.
      if (task.mode === 'remote') void finishRemoteWithResult(task, te)
      else finishWithTerminal(task, te)
      return true
    }
    persistThenPush(task, te)
    return false
  }

  /** Recovery convergence for a remote task terminalized WITHOUT its result (e.g.
   *  the replay path): fetch + persist the durable result idempotently after the
   *  fact. Never fabricates; a failure leaves the result 'missing' for a later GET. */
  function fetchAndPersistRemoteResult(task: GatewayTask): void {
    if (!persist || task.mode !== 'remote') return
    void (async () => {
      await fetchRemoteResult(task)
      if (!task.pendingResult) return
      try { persist.persistTaskResultDurable(task.taskId, task.pendingResult.status, task.pendingResult.result) } catch { /* already persisted / conflict tolerated */ }
    })()
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
    // Fetch the authoritative remote AgentTaskResult (encrypted E2E) BEFORE
    // terminalizing, so it is persisted atomically with the terminal event and a
    // terminal task never loses its final output. Result fetch failure → 'missing'
    // and a later GET/recovery retries (never fabricated).
    void finishRemoteWithResult(task, synthEvent(task, type, {}))
  }

  /**
   * Resolve the authoritative remote AgentTaskResult, THEN terminalize atomically.
   * Result resolution must reach an authoritative available/missing/invalid outcome
   * before the terminal state is published:
   *   - an ONLINE OLD node (no run_result_v1) → authoritative 'missing' immediately;
   *   - a capable node → fetch with bounded retry; a transient outage does NOT
   *     fabricate 'missing' — the task is left non-terminal and a later GET/recovery
   *     re-attempts (never publishing terminal before the result resolves);
   *   - a recovered task (unknown capability) falls back to 'missing' only after the
   *     bounded retries, so it cannot get stuck against a genuinely old node.
   * Guarded + idempotent (finishWithTerminal / terminalize are once-only).
   */
  async function finishRemoteWithResult(task: GatewayTask, ev: TaskEvent): Promise<void> {
    if (task.terminal) return
    if (!remoteEnabled || task.mode !== 'remote' || !task.remoteRunId) { finishWithTerminal(task, ev); return }
    if (task.resultCapable === false) { task.pendingResult = { status: 'missing', result: null }; finishWithTerminal(task, ev); return } // explicit old-node absence
    for (let attempt = 0; attempt < REMOTE_RESULT_ATTEMPTS && !task.terminal; attempt++) {
      try {
        const r = await remoteRunResult(relay!, relayToken!, relayId(task))
        task.pendingResult = { status: r.result_status as TaskResultStatus, result: r.result } // authoritative
        finishWithTerminal(task, ev)
        return
      } catch { if (attempt + 1 < REMOTE_RESULT_ATTEMPTS) await new Promise((r) => setTimeout(r, REMOTE_RECONCILE_BACKOFF_MS * (attempt + 1))) }
    }
    // Bounded retries exhausted (transient outage). Fresh capable task: leave
    // NON-TERMINAL (a later GET/recovery re-attempts). Recovered/unknown: fall back
    // to 'missing' so it cannot hang against an old node.
    if (task.resultCapable === undefined && !task.terminal) { task.pendingResult = { status: 'missing', result: null }; finishWithTerminal(task, ev) }
  }

  /** Fetch the durable remote AgentTaskResult into `task.pendingResult` (best-effort,
   *  once) — for post-terminal convergence via the replay path. */
  async function fetchRemoteResult(task: GatewayTask): Promise<void> {
    if (task.pendingResult || !remoteEnabled || task.mode !== 'remote' || !task.remoteRunId) return
    if (task.resultCapable === false) { task.pendingResult = { status: 'missing', result: null }; return }
    try { const r = await remoteRunResult(relay!, relayToken!, relayId(task)); task.pendingResult = { status: r.result_status as TaskResultStatus, result: r.result } }
    catch { /* transient; a later GET / recovery re-fetches (never fabricated here) */ }
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
    void remoteStream(relay!, relayToken!, relayId(task), {
      suppressStdout: true,
      signal: abort.signal,
      emitDisconnectTerminal: false, // a dropped transport is not a run result
      onRunEvent: (event) => { if (!task.terminal) ingest(task, event) },
      onGiveUp: () => { void reconcileViaStatus(task) },
    })
      .catch(() => { /* aborted/failed; terminal handled via ingest or reconcile */ })
      .finally(() => { task.pumpActive = false })
  }

  // ── source-event replay pump (Gateway ⇄ Node run_event_replay_v1) ────────────
  // The ONE authoritative pump for a replay-capable task: requests journaled
  // replay from the persisted source cursor, ingests each source event ATOMICALLY
  // (persist source_sequence + advance the source cursor BEFORE SSE publish), then
  // tails live. NODE source_sequence is NEVER used as the Gateway task sequence.
  function startReplayPump(task: GatewayTask, afterSequence: number): void {
    if (task.terminal || task.pumpActive || !persist) return
    task.replayMode = true
    const abort = new AbortController()
    task.abort = abort
    task.pumpActive = true
    void remoteStream(relay!, relayToken!, relayId(task), {
      suppressStdout: true,
      signal: abort.signal,
      emitDisconnectTerminal: false,
      afterSequence,
      onReplayMeta: (meta) => handleReplayMeta(task, meta),
      onSourceEvent: (event, sourceSeq) => { if (!task.terminal) ingestSource(task, event, sourceSeq) },
      onGiveUp: () => { void reconcileViaStatus(task) },
    })
      .catch(() => { /* transport failure — reconcile via status, never a fabricated terminal */ })
      .finally(() => { task.pumpActive = false })
  }

  /** Resume the single authoritative pump for a running remote task. */
  function resumePump(task: GatewayTask): void {
    if (task.terminal || task.pumpActive) return
    if (task.replayCapable && persist) startReplayPump(task, persist.getTaskRecord(task.taskId)?.last_remote_event_sequence ?? -1)
    else startRemotePump(task)
  }

  function handleReplayMeta(task: GatewayTask, meta: Record<string, unknown> | null): void {
    if (!persist) return
    if (!meta) { try { persist.markTaskHistoryIncomplete(task.taskId, 'remote_source_cursor_unknown', task.nextSeq - 1) } catch { /* */ } ; task.historyTruncated = true; return }
    task.replayCutoff = typeof meta.latest_sequence === 'number' ? meta.latest_sequence : undefined
    task.replayHistoryComplete = meta.history_complete_for_request === true
    if (meta.history_complete_for_request === false) {
      // Node journal truncated the requested prefix: preserve incompleteness.
      try { persist.markTaskHistoryIncomplete(task.taskId, 'node_journal_truncated', task.nextSeq - 1) } catch { /* */ }
      task.historyTruncated = true
    } else {
      maybeClearCatchUp(task) // cutoff may already == cursor (no new event needed)
    }
  }

  /** Atomically ingest one NODE source event and publish only on success. */
  function ingestSource(task: GatewayTask, event: RunEvent, sourceSeq: number): void {
    if (task.terminal || !persist) return
    const te = runEventToTaskEvent(event, 0)
    if (!te) { try { persist.advanceSourceCursor(task.taskId, sourceSeq) } catch { /* gap/conflict: skip */ } ; maybeClearCatchUp(task); return }
    const terminal = TERMINAL_EVENT_TYPES.has(te.type)
    try {
      const r = persist.ingestSourceEventDurable(task.taskId, sourceSeq, { event_type: te.type, ts: te.ts, payload: te.payload, terminal, status: terminal ? terminalStatusFor(te.type) : undefined })
      task.revision = r.record.revision
      if (r.applied && r.canonicalSequence !== null) {
        const te2: TaskEvent = { seq: r.canonicalSequence, task_id: task.taskId, type: te.type, ts: te.ts, payload: te.payload, contract_version: TASK_CONTRACT_VERSION }
        task.nextSeq = Math.max(task.nextSeq, r.canonicalSequence + 1)
        pushEvent(task, te2) // SSE publish AFTER durable commit
        if (terminal) { finishTask(task); fetchAndPersistRemoteResult(task) } // converge the durable result post-terminal
      }
      maybeClearCatchUp(task)
    } catch { /* gap/conflict: do not publish; a later GET / reconcile catches up */ }
  }

  /** After a VERIFIED gap-free catch-up (cursor reached the complete cutoff),
   *  clear the history-incomplete marker exactly once. */
  function maybeClearCatchUp(task: GatewayTask): void {
    if (task.catchUpCleared || !task.replayHistoryComplete || task.replayCutoff === undefined || !persist) return
    const rec = persist.getTaskRecord(task.taskId)
    if (rec && (rec.last_remote_event_sequence ?? -1) >= task.replayCutoff) {
      try { persist.clearTaskHistoryIncomplete(task.taskId); task.catchUpCleared = true; task.historyTruncated = false } catch { /* */ }
    }
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
          const record = await remoteRunStatus(relay!, relayToken!, relayId(task))
          reconcileRemoteRecord(task, record)
          if (task.terminal) return
          if ((task.resumeCount ?? 0) < REMOTE_MAX_RESUMES) { task.resumeCount = (task.resumeCount ?? 0) + 1; resumePump(task) }
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

  // ── restart recovery (rebuild in-memory cache from the durable store) ───────

  function toTaskEvent(taskId: string, sequence: number, type: string, ts: string, payload: unknown): TaskEvent {
    return { seq: sequence, task_id: taskId, type: type as TaskEventType, ts, payload: (payload ?? {}) as Record<string, unknown>, contract_version: TASK_CONTRACT_VERSION }
  }

  /** Align a recovered LOCAL task's RunEvent cursor so `drain` continues WITHOUT
   *  re-emitting events already persisted as TaskEvents (no gap, no duplicate). */
  function seedRecoveredLocalCursor(task: GatewayTask): void {
    let all: RunEvent[]; try { all = readEvents(task.taskId) } catch { return }
    const alreadyMapped = Math.max(0, task.nextSeq - 1) // TaskEvents from RunEvents (excludes synthetic task.created)
    let mapped = 0
    for (let i = 0; i < all.length; i++) {
      if (mapped >= alreadyMapped) { task.emittedRunEvents = i; return }
      if (runEventToTaskEvent(all[i], 0)) mapped++
    }
    task.emittedRunEvents = all.length
  }

  /** Reconcile one recovered task with authoritative status; resume the live
   *  source if still running. Node-offline/transport failure NEVER fabricates a
   *  terminal — it retries with bounded backoff while the gateway is alive. */
  async function reconcileRecovered(task: GatewayTask, attempt = 0): Promise<void> {
    if (task.terminal || shuttingDown) return
    try {
      if (task.mode === 'remote') {
        // REPLAY-CAPABLE + KNOWN cursor: replay missing source events (incl the
        // terminal one) from the Node journal BEFORE reconciling status — output
        // just before completion must not be lost because status was seen first.
        if (task.replayCapable && persist) {
          const cursor = persist.getTaskRecord(task.taskId)?.last_remote_event_sequence ?? -1
          startReplayPump(task, cursor)
          return
        }
        const record = await remoteRunStatus(relay!, relayToken!, task.remoteRunId!)
        reconcileRemoteRecord(task, record)
        if (!task.terminal) {
          // Live-only recovery (unknown cursor / non-replay node): events emitted
          // during downtime may be missing. Mark the persisted history incomplete
          // at the last durably-consumed sequence. We NEVER invent/renumber events.
          if (persist && task.recovered) {
            const boundary = task.nextSeq - 1
            try { persist.markTaskHistoryIncomplete(task.taskId, 'remote_source_cursor_unknown', boundary) } catch { /* best effort */ }
            task.historyTruncated = true
          }
          startRemotePump(task)
        }
      } else {
        const record = readRun(task.taskId)
        const status = runStatusToTaskStatus(record.status)
        if (isTerminalTaskStatus(status)) finishWithTerminal(task, synthEvent(task, status === 'completed' ? 'task.completed' : status === 'failed' ? 'task.failed' : 'task.cancelled', {}))
        else { seedRecoveredLocalCursor(task); startPoll(task) }
      }
    } catch {
      // A transient read/transport error is NOT a task failure — retry with bounded
      // backoff. Only after exhausting attempts do we conclude a LOCAL run's state
      // is genuinely gone (sanitized failure, once); a REMOTE node stays non-terminal
      // (a later GET / new subscriber reconciles), never fabricated as failed.
      const lastAttempt = attempt + 1 >= REMOTE_RECONCILE_ATTEMPTS
      if (!lastAttempt && !shuttingDown) { const t = setTimeout(() => { recoveryTimers.delete(t); void reconcileRecovered(task, attempt + 1) }, REMOTE_RECONCILE_BACKOFF_MS * (attempt + 1)); recoveryTimers.add(t); t.unref?.(); return }
      if (task.mode === 'local') finishWithTerminal(task, synthEvent(task, 'task.failed', { reason: 'recovery_run_missing', message: 'local run state unavailable after restart' }), { code: 'recovery_run_missing', message: 'local run state unavailable after restart' })
    }
  }

  /** Rebuild non-terminal tasks from the store: register them (immediately
   *  addressable), rebuild active-slot accounting, fail ambiguous starts once,
   *  and schedule authoritative reconciliation. */
  function recoverTasks(): void {
    if (!persist || !recoverOnStart) return
    let records
    try { records = persist.listNonTerminalTasks() } catch { return }
    for (const rec of records) {
      const isRemote = rec.remote_run_id !== null || (rec.node_id !== null && rec.node_id !== 'local' && rec.node_id !== 'auto')
      const mode: 'local' | 'remote' = isRemote ? 'remote' : 'local'
      let events: TaskEvent[] = []
      try { events = persist.loadTaskEvents(rec.task_id).map((e) => toTaskEvent(rec.task_id, e.sequence, e.event_type, e.ts, e.payload)) } catch { events = [] }
      let historyTruncated = rec.earliest_retained_sequence > 0
      if (events.length > maxEvents) { events = events.slice(events.length - maxEvents); historyTruncated = true }
      const task: GatewayTask = {
        taskId: rec.task_id, agent: rec.agent as AgentBackend, mode, events,
        nextSeq: rec.last_event_sequence + 1, emittedRunEvents: 0,
        subscribers: new Set(), terminal: false, cancelInFlight: false,
        revision: rec.revision, nodeId: rec.node_id, remoteRunId: rec.remote_run_id,
        recovered: true, historyTruncated,
        // A known durable source cursor means the task was created replay-capable
        // (initReplayCursor ran only for replay-capable nodes) → recover via replay.
        replayCapable: rec.last_remote_event_sequence !== null,
      }
      tasks.set(task.taskId, task)
      activeCount++ // recovered non-terminal task counts against the active-task limit
      if (mode === 'remote' && !rec.remote_run_id) {
        // Ambiguous start: unknown whether the node began execution — do NOT resume
        // (would risk a duplicate run) and never guess a remote run id. Sanitized
        // recovery failure recorded exactly once.
        finishWithTerminal(task, synthEvent(task, 'task.failed', { reason: 'recovery_unknown_start', message: 'task start outcome is unknown after gateway restart; not resumed to avoid a duplicate execution' }), { code: 'recovery_unknown_start', message: 'remote start outcome unknown after gateway restart; not resumed' })
        continue
      }
      const t = setTimeout(() => { recoveryTimers.delete(t); void reconcileRecovered(task) }, 0)
      recoveryTimers.add(t); t.unref?.()
    }
  }

  /** Map a caught remote-run error to a canonical ApiError + HTTP status. */
  function remoteApiError(err: unknown, taskId?: string): { error: ApiError; status: number } {
    const code = classifyRunError(err)
    const message = err instanceof Error ? err.message : String(err)
    // The Node's cwd authorization refusal is a REQUEST problem, not an internal
    // failure — surface the FIRST-CLASS `cwd_not_allowed` API error code (400;
    // message is Node-sanitized: it never contains the path or the roots).
    if (message.startsWith('cwd_not_allowed:')) {
      const error = apiError('cwd_not_allowed', message, taskId ? { task_id: taskId } : {})
      return { error, status: apiErrorHttpStatus(error.code) }
    }
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
    // A workspace_lease_id can only be enforced by a lease-capable Node at run start.
    // A local / in-process backend cannot perform that enforcement, so a lease-carrying
    // request MUST target an explicit lease-capable node_id — we never simulate lease
    // safety with a Gateway-only row. Reject up front with a structured unsupported error.
    if (reqv.workspace_lease_id && !isRemote) {
      return sendError(res, apiError('workspace_lease_unsupported', 'workspace_lease_id requires an explicit lease-capable remote node_id; local/in-process execution cannot enforce a workspace lease'), 422)
    }
    // A cwd-backed task (`workspace.path`) can only be authorized by a cwd-capable
    // Node (allowed_cwd_roots). Local/in-process execution has no such
    // authorization surface — fail closed rather than silently running in a
    // scratch workspace.
    if (reqv.workspace?.path && !isRemote) {
      return sendError(res, apiError('agent_unavailable', '`workspace.path` requires an explicit remote node_id advertising the "cwd" capability; local/in-process execution cannot authorize an existing directory'), 422)
    }
    // Remote agent validity is enforced by the target node (agent_not_supported).

    // ── idempotency pre-check (BEFORE any active-slot reservation) ─────────────
    // A client-supplied idempotency_key makes create-or-return safe across a client
    // crash/retry. It requires a durable store (the SQLite partial unique index is
    // the authoritative dedupe). The read-only pre-check lets an existing task REPLAY
    // WITHOUT consuming a slot — so a retry succeeds even when the active limit is
    // full. A genuinely new key still falls through to the normal capacity check.
    const idemKey = reqv.idempotency_key
    let fingerprint: string | undefined
    if (idemKey) {
      if (!persist) return sendError(res, apiError('invalid_request', 'idempotency_key requires a durable task store (start `vibe api serve` with a control database)'), 400)
      fingerprint = computeRequestFingerprint(reqv)
      let existing: TaskRecord | null = null
      try { existing = persist.getTaskByIdempotencyKey(idemKey) } catch { existing = null }
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) return sendError(res, idempotencyConflict(), 409)
        // Idempotent replay: the SAME durable task (running, terminal, or ambiguous
        // recovery state) — no new task, no second run, no slot.
        return sendJson(res, 200, { ...taskRecordToTask(existing), history: historyField(existing) }, REPLAY_HEADERS)
      }
    }
    /** Persist a new task durably. With an idempotency key this is the atomic
     *  create-or-return (SQLite uniqueness is the final authority under a concurrent
     *  same-key race); without one it is the plain durable create (always created). */
    const persistCreate = (input: CreateTaskInput, createdEv: TaskEvent): { record: TaskRecord; created: boolean } => {
      if (idemKey) return persist!.createTaskIdempotently({ ...input, idempotency_key: idemKey, request_fingerprint: fingerprint! }, toEventInput(createdEv))
      return { record: persist!.createTaskDurable(input, toEventInput(createdEv)), created: true }
    }

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
    let replayCapable = false
    let resultCapable = false
    if (isRemote) {
      let nodes
      try { nodes = await fetchRemoteNodes(relay!, relayToken!) }
      catch (err) { release(); const m = remoteApiError(err, undefined); return sendError(res, m.error, m.status) }
      const node = nodes.find((n) => n.node_id === reqv.node_id)
      if (!node || node.status !== 'online') { release(); return sendError(res, apiError('node_offline', `node ${reqv.node_id} is offline or unknown`, { details: { node_id: reqv.node_id } }), 503) }
      if (!Array.isArray(node.agents) || !node.agents.includes(reqv.agent)) { release(); return sendError(res, apiError('agent_unavailable', `node ${reqv.node_id} does not advertise agent "${reqv.agent}"`, { details: { node_id: reqv.node_id } }), 422) }
      if (!node.encryption_public_key) { release(); return sendError(res, apiError('service_unavailable', `secure remote execution unavailable: node ${reqv.node_id} advertises no encryption key`, { retryable: false, details: { node_id: reqv.node_id } }), 503) }
      encryptionPublicKey = node.encryption_public_key
      replayCapable = Array.isArray(node.capabilities) && node.capabilities.includes(RUN_EVENT_REPLAY_CAPABILITY)
      resultCapable = Array.isArray(node.capabilities) && node.capabilities.includes(RUN_RESULT_CAPABILITY)
      // A lease-carrying request fails closed against a Node that does not advertise
      // run-start lease enforcement — never send the lease id to a node that would
      // ignore it (that would silently drop the protection the caller asked for).
      if (reqv.workspace_lease_id) {
        const leaseCapable = Array.isArray(node.capabilities) && node.capabilities.includes(WORKSPACE_LEASE_CAPABILITY)
        if (!leaseCapable) { release(); return sendError(res, apiError('workspace_lease_unsupported', `node ${reqv.node_id} does not advertise workspace lease enforcement (${WORKSPACE_LEASE_CAPABILITY}); a lease-protected task cannot run there`, { details: { node_id: reqv.node_id } }), 422) }
      }
      // A cwd-backed task fails closed against a Node that does not advertise cwd
      // authorization — an old/incapable Node would silently ignore the field and
      // run in a scratch workspace, which must never happen.
      if (reqv.workspace?.path) {
        const cwdCapable = Array.isArray(node.capabilities) && node.capabilities.includes(CWD_CAPABILITY)
        if (!cwdCapable) { release(); return sendError(res, apiError('agent_unavailable', `node ${reqv.node_id} does not advertise cwd-backed execution (${CWD_CAPABILITY}); a \`workspace.path\` task cannot run there`, { details: { node_id: reqv.node_id } }), 422) }
      }
    }

    // Prompt text -> a private temp file (both startRun and remoteRunStart take a
    // prompt-file path; remoteRunStart reads it and sends the ENCRYPTED content).
    const promptFile = path.join(os.tmpdir(), `vibe-api-prompt-${crypto.randomBytes(8).toString('hex')}.txt`)
    fs.writeFileSync(promptFile, reqv.input.text, { mode: 0o600 })

    // REMOTE + durable: persist the task record + task.created BEFORE attempting
    // remote start (remote_run_id UNBOUND), then durably BIND the remote run id
    // after a successful start. The task is durable even if the gateway crashes
    // mid-start; recovery treats an unbound remote_run_id as an AMBIGUOUS start
    // (never auto-restarted). The public task_id is gateway-owned and decoupled
    // from the relay run_id.
    if (isRemote && persist) {
      const taskId = newGatewayTaskId()
      const task: GatewayTask = {
        taskId, agent: reqv.agent as AgentBackend, mode: 'remote', events: [], nextSeq: 0,
        emittedRunEvents: 0, subscribers: new Set(), terminal: false, cancelInFlight: false,
        revision: 1, nodeId: reqv.node_id!, remoteRunId: null,
      }
      const createdEv = synthEvent(task, 'task.created', { agent: reqv.agent as AgentBackend })
      try {
        const r = persistCreate({
          task_id: taskId, node_id: reqv.node_id!, agent: reqv.agent as AgentBackend,
          workspace_key: reqv.workspace?.workspace_key ?? null, permission_mode: reqv.execution?.permission_mode ?? null,
          status: 'queued', remote_run_id: null, input_text: reqv.input.text, metadata: reqv.metadata ?? null,
        } satisfies CreateTaskInput, createdEv)
        task.revision = r.record.revision
        if (!r.created) {
          // A concurrent same-key create already won → do NOT start a second remote
          // run. Return the existing durable task (replay); free the reserved slot.
          release(); try { fs.unlinkSync(promptFile) } catch { /* */ }
          return sendJson(res, 200, { ...taskRecordToTask(r.record), history: historyField(r.record) }, REPLAY_HEADERS)
        }
      } catch (err) {
        release(); try { fs.unlinkSync(promptFile) } catch { /* */ }
        if (err instanceof ControlStoreError && err.code === 'idempotency_conflict') return sendError(res, idempotencyConflict(), 409)
        return sendError(res, apiError('internal_error', 'failed to persist task'), 500)
      }

      let rrec: RunRecord
      try {
        rrec = await remoteRunStart(relay!, relayToken!, reqv.node_id!, { agent: reqv.agent as AgentBackend, promptFile, workspaceKey: reqv.workspace?.workspace_key, cwd: reqv.workspace?.path, permissionMode: reqv.execution?.permission_mode, workspaceWrite: reqv.execution?.workspace_write, metadata: reqv.metadata, encryptionPublicKey, workspaceLeaseId: reqv.workspace_lease_id, verify: reqv.verify })
      } catch (err) {
        release(); try { fs.unlinkSync(promptFile) } catch { /* */ }
        // Start DEFINITELY failed → record the canonical failure terminally, once.
        const code = classifyRunError(err)
        try { persist.terminalizeTaskDurable(taskId, task.revision, { status: 'failed', error_code: code, error_message: (err as Error).message }, toEventInput(synthEvent(task, 'task.failed', { reason: code }))) } catch { /* */ }
        const m = remoteApiError(err, taskId); return sendError(res, m.error, m.status)
      }
      try { fs.unlinkSync(promptFile) } catch { /* */ }
      // Durably BIND the remote run id + running status BEFORE exposing lifecycle.
      try { const rec = persist.updateTaskDurable(taskId, task.revision, { remote_run_id: rrec.run_id, status: runStatusToTaskStatus(rrec.status) }); task.revision = rec.revision } catch { /* a durable-bind failure leaves an ambiguous row that recovery handles; the live process still knows the id */ }
      task.remoteRunId = rrec.run_id
      task.replayCapable = replayCapable
      task.resultCapable = resultCapable
      // Replay-capable node: consume events through the DURABLE source-event replay
      // pump (persist source_sequence + advance the source cursor BEFORE publish).
      if (replayCapable) { try { persist.initReplayCursor(taskId) } catch { /* */ } }
      tasks.set(taskId, task); pendingCreates--; activeCount++
      pushEvent(task, createdEv)
      if (replayCapable) startReplayPump(task, -1); else startRemotePump(task)
      return sendJson(res, 202, { ...runRecordToTask(rrec), task_id: taskId })
    }

    let record: RunRecord
    let started = false
    const mode: 'local' | 'remote' = isRemote ? 'remote' : 'local'
    try {
      if (isRemote) {
        record = await remoteRunStart(relay!, relayToken!, reqv.node_id!, {
          agent: reqv.agent as AgentBackend,
          promptFile,
          workspaceKey: reqv.workspace?.workspace_key,
          cwd: reqv.workspace?.path, // authorized ONLY by the Node (allowed_cwd_roots); fail closed
          // repo_url/branch are DEFERRED in Gateway v1 (rejected at validation) —
          // the node does not clone/prepare a repo before the backend starts.
          permissionMode: reqv.execution?.permission_mode,
          metadata: reqv.metadata,
          encryptionPublicKey, // mandatory — run_start payload is encrypted for the node
          workspaceLeaseId: reqv.workspace_lease_id, // enforced Node-side; never reaches the provider
          verify: reqv.verify, // enforced Node-side; never reaches the provider
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
          verify: reqv.verify,
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

    const nodeId = isRemote ? reqv.node_id! : null
    const remoteRunId = isRemote ? record.run_id : null // relay routes by run_id (== task_id)
    const task: GatewayTask = {
      taskId: record.run_id, agent: record.agent, mode, events: [], nextSeq: 0,
      emittedRunEvents: 0, subscribers: new Set(), terminal: false, cancelInFlight: false,
      revision: 1, nodeId, remoteRunId,
    }
    const createdEv = synthEvent(task, 'task.created', { agent: record.agent })
    if (persist) {
      // Atomically persist the task record + task.created BEFORE exposing the task.
      // With an idempotency key (LOCAL path — remote+persist returned above), the
      // cheap mock run already started; if create-or-return finds we LOST the race
      // (or the request conflicts), COMPENSATE by stopping that duplicate run and
      // return the winning task / a conflict — never expose a second run.
      try {
        const r = persistCreate({
          task_id: task.taskId, node_id: nodeId, agent: record.agent,
          workspace_key: reqv.workspace?.workspace_key ?? null,
          permission_mode: reqv.execution?.permission_mode ?? null,
          status: runStatusToTaskStatus(record.status), remote_run_id: remoteRunId,
          input_text: reqv.input.text, metadata: reqv.metadata ?? null,
        } satisfies CreateTaskInput, createdEv)
        task.revision = r.record.revision
        if (!r.created) {
          release(); try { stopRun(task.taskId) } catch { /* compensate the duplicate local run */ }
          const winner = idemKey ? persist.getTaskByIdempotencyKey(idemKey) : null
          if (winner) return sendJson(res, 200, { ...taskRecordToTask(winner), history: historyField(winner) }, REPLAY_HEADERS)
          return sendError(res, apiError('internal_error', 'idempotency resolution failed'), 500)
        }
      } catch (err) {
        release(); try { stopRun(task.taskId) } catch { /* compensate the duplicate local run */ }
        if (err instanceof ControlStoreError && err.code === 'idempotency_conflict') return sendError(res, idempotencyConflict(), 409)
        return sendError(res, apiError('internal_error', 'failed to persist task'), 500)
      }
    }
    tasks.set(task.taskId, task)
    pendingCreates-- // reservation becomes a live active task
    activeCount++
    pushEvent(task, createdEv) // buffer + fan-out (no subscribers yet); already durable above
    if (mode === 'remote') startRemotePump(task); else startPoll(task)
    sendJson(res, 202, runRecordToTask(record))
  }

  async function handleGet(res: http.ServerResponse, taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) {
      // Not in the in-memory cache: a historical (terminal, evicted, or
      // pre-restart) task remains queryable from the durable store.
      if (persist) { const rec = persist.getTaskRecord(taskId); if (rec) return sendJson(res, 200, { ...taskRecordToTask(rec), history: historyField(rec), ...resultProjection(taskId) }) }
      return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)
    }
    // A terminal REMOTE task's state is FINAL — return the durable/last-known
    // projection WITHOUT a (possibly slow/unreachable) authoritative relay call.
    // (Local terminal tasks keep using authoritative readRun below — no relay.)
    if (task.terminal && task.mode === 'remote') {
      if (persist) { const rec = persist.getTaskRecord(task.taskId); if (rec) return sendJson(res, 200, { ...taskRecordToTask(rec), task_id: task.taskId, history: historyField(rec), ...resultProjection(task.taskId) }) }
      if (task.lastRecord) return sendJson(res, 200, { ...runRecordToTask(task.lastRecord), task_id: task.taskId })
    }
    let record: RunRecord
    try {
      record = task.mode === 'remote' ? await remoteRunStatus(relay!, relayToken!, relayId(task)) : readRun(taskId)
    } catch (err) {
      // Node offline / relay unavailable: preserve last known state and surface
      // the structured error (do NOT mark the task terminal).
      if (task.mode === 'remote') { const m = remoteApiError(err, taskId); return sendError(res, m.error, m.status) }
      return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)
    }
    // Authoritative GET may be the first to observe a terminal state — fold it in
    // (emits one terminal event, frees the slot, stops the pump) exactly once.
    if (task.mode === 'remote') reconcileRemoteRecord(task, record)
    const hist = persist ? persist.getTaskRecord(task.taskId) : null
    // Always project the PUBLIC task_id (decoupled from remote_run_id) + attach
    // machine-readable history completeness + the durable result projection.
    sendJson(res, 200, { ...runRecordToTask(record), task_id: task.taskId, ...(hist ? { history: historyField(hist) } : {}), ...resultProjection(task.taskId) })
  }

  function handleEvents(req: http.IncomingMessage, res: http.ServerResponse, taskId: string): void {
    const task = tasks.get(taskId)
    if (!task) {
      // Historical/terminal task not in memory: replay persisted events from the
      // durable store (no live subscription — it is already terminal), applying
      // the same Last-Event-ID cursor + truncation semantics.
      if (persist) {
        const rec = persist.getTaskRecord(taskId)
        if (rec) {
          const durable = persist.loadTaskEvents(taskId).map((e) => toTaskEvent(taskId, e.sequence, e.event_type, e.ts, e.payload))
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
          res.write(': connected\n\n')
          const replay = computeSseReplay(durable, req.headers['last-event-id'])
          if (replay.truncated || rec.earliest_retained_sequence > 0) res.write(': warning: task event history is incomplete/truncated\n\n')
          for (const ev of replay.events) res.write(sseFrame(ev))
          res.end()
          return
        }
      }
      return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)
    }

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
    if (task.historyTruncated) {
      // Some early events are no longer available (gateway downtime / retention).
      // We NEVER fabricate or renumber events; the cursor stays the greatest saved.
      res.write(': warning: task event history is incomplete (some events emitted while the gateway was unavailable are not retained)\n\n')
    }
    for (const ev of replay.events) res.write(sseFrame(ev))

    if (task.terminal) { res.end(); return } // terminal already delivered above
    task.subscribers.add(res)
    // A remote task whose transport gave up has no live pump; a new subscriber
    // resumes it (the relay doesn't replay, so live events flow from here on).
    if (task.mode === 'remote' && !task.pumpActive) resumePump(task)
    // Disconnecting a subscriber must NOT cancel the task — just prune the listener.
    req.on('close', () => { task.subscribers.delete(res) })
  }

  async function handleCancel(res: http.ServerResponse, taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) {
      // Historical task not in memory: if durably terminal, cancel is an idempotent
      // no-op that returns the stored task. (Non-terminal tasks are always in the
      // cache — recovery rebuilds them — so this path never re-issues a stop.)
      if (persist) { const rec = persist.getTaskRecord(taskId); if (rec) return sendJson(res, 200, taskRecordToTask(rec)) }
      return sendError(res, apiError('task_not_found', `no such task: ${taskId}`, { task_id: taskId }), 404)
    }
    // Already terminal REMOTE task: idempotent no-op — return the final projection
    // WITHOUT an authoritative relay call (never re-stop a finished task).
    if (task.terminal && task.mode === 'remote') {
      if (persist) { const rec = persist.getTaskRecord(task.taskId); if (rec) return sendJson(res, 200, { ...taskRecordToTask(rec), task_id: task.taskId }) }
      if (task.lastRecord) return sendJson(res, 200, { ...runRecordToTask(task.lastRecord), task_id: task.taskId })
    }

    let record: RunRecord
    try {
      record = task.mode === 'remote' ? await remoteRunStatus(relay!, relayToken!, relayId(task)) : readRun(taskId)
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
        const stopped = await remoteStop(relay!, relayToken!, relayId(task))
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
        const cur = task.mode === 'remote' ? await remoteRunStatus(relay!, relayToken!, relayId(task)) : readRun(taskId)
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

  // ── workflow routes (durable Workflow Runtime lifecycle over the SAME store) ──
  // Enabled only when a ControlStore is provided. Mutating routes need the runtime
  // (503 until it is wired post-listen); read routes need only the store.
  const controlStore: ControlStore | undefined = opts.controlStore
  const getWorkflowRuntime = opts.getWorkflowRuntime
  const getWorkflowCompiler = opts.getWorkflowCompiler
  const getWorkflowBuilder = opts.getWorkflowBuilder
  const workflowStreams = new Set<http.ServerResponse>() // open workflow SSE responses (ended on shutdown)
  function wfUnavailable(res: http.ServerResponse): void { sendJson(res, 503, workflowApiError('workflow_runtime_unavailable', 'the workflow runtime is not available yet')) }

  async function handleWorkflows(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], method: string): Promise<void> {
    if (!controlStore) return sendError(res, apiError('task_not_found', 'workflows are not enabled on this gateway'), 404)
    const runtime = getWorkflowRuntime?.()
    // /v1/workflows
    if (parts.length === 2) {
      if (method === 'GET') { const r = await listWorkflowsController(controlStore, new URL(req.url ?? '/', 'http://localhost').searchParams); return sendJson(res, r.status, r.body) }
      if (method === 'POST') {
        if (!runtime) return wfUnavailable(res)
        const body = await readBody(req, MAX_BODY_BYTES)
        if (!body.ok) return sendError(res, apiError('invalid_request', `request body exceeds ${MAX_BODY_BYTES} bytes`), 413)
        let parsed: unknown
        try { parsed = JSON.parse(body.text) } catch { return sendJson(res, 400, workflowApiError('invalid_request', 'malformed JSON body')) }
        const r = await createWorkflowController(runtime, parsed)
        return sendJson(res, r.status, r.body)
      }
      return methodNotAllowed(res, ['GET', 'POST'])
    }
    const id = decodeURIComponent(parts[2])
    if (!id) return sendError(res, apiError('invalid_request', 'missing workflow id'), 400)
    if (parts.length === 3) {
      if (method !== 'GET') return methodNotAllowed(res, ['GET'])
      const r = await getWorkflowController(controlStore, id); return sendJson(res, r.status, r.body)
    }
    if (parts.length === 4 && parts[3] === 'start') {
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!runtime) return wfUnavailable(res)
      const r = await startWorkflowController(runtime, controlStore, id); return sendJson(res, r.status, r.body)
    }
    if (parts.length === 4 && parts[3] === 'events') {
      if (method !== 'GET') return methodNotAllowed(res, ['GET'])
      const rec = await controlStore.getWorkflow(id)
      if (!rec) return sendJson(res, 404, workflowApiError('workflow_not_found', `no such workflow: ${id}`))
      return streamWorkflowEvents(req, res, controlStore, id, workflowStreams)
    }
    if (parts.length === 4 && parts[3] === 'cancel') {
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!runtime) return wfUnavailable(res)
      const r = await cancelWorkflowController(runtime, controlStore, id); return sendJson(res, r.status, r.body)
    }
    // ── human pause / approval sub-resources ──
    if (parts.length === 4 && parts[3] === 'pending-request') {
      if (method !== 'GET') return methodNotAllowed(res, ['GET'])
      if (!runtime) return wfUnavailable(res)
      const r = await getPendingRequestController(runtime, controlStore, id); return sendJson(res, r.status, r.body)
    }
    if (parts.length === 4 && (parts[3] === 'answer' || parts[3] === 'decision')) {
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!runtime) return wfUnavailable(res)
      const body = await readBody(req, MAX_BODY_BYTES)
      if (!body.ok) return sendError(res, apiError('invalid_request', `request body exceeds ${MAX_BODY_BYTES} bytes`), 413)
      let parsed: unknown
      try { parsed = JSON.parse(body.text) } catch { return sendJson(res, 400, workflowApiError('invalid_request', 'malformed JSON body')) }
      const r = parts[3] === 'answer' ? await answerInputController(runtime, controlStore, id, parsed) : await decideApprovalController(runtime, controlStore, id, parsed)
      return sendJson(res, r.status, r.body)
    }
    if (parts.length === 4 && parts[3] === 'resume') {
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!runtime) return wfUnavailable(res)
      const r = await resumeWorkflowController(runtime, controlStore, id); return sendJson(res, r.status, r.body)
    }
    return sendError(res, apiError('task_not_found', 'not found'), 404)
  }

  // ── workflow-draft (compiler) routes ──
  async function handleWorkflowDrafts(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], method: string): Promise<void> {
    if (!controlStore) return sendError(res, apiError('task_not_found', 'the workflow compiler is not enabled on this gateway'), 404)
    const compiler = getWorkflowCompiler?.()
    const readJson = async (): Promise<{ ok: true; value: unknown } | { ok: false }> => {
      const body = await readBody(req, MAX_BODY_BYTES)
      if (!body.ok) { sendError(res, apiError('invalid_request', `request body exceeds ${MAX_BODY_BYTES} bytes`), 413); return { ok: false } }
      try { return { ok: true, value: JSON.parse(body.text) } } catch { sendJson(res, 400, { error: true, code: 'invalid_request', message: 'malformed JSON body' }); return { ok: false } }
    }
    if (parts.length === 2) { // /v1/workflow-drafts
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (parts[1] !== 'workflow-drafts') return sendError(res, apiError('task_not_found', 'not found'), 404)
      if (!compiler) return sendJson(res, 503, { error: true, code: 'compiler_unavailable', message: 'the workflow compiler is not available yet' })
      // POST /v1/workflow-drafts is the base for /compile; require the /compile suffix.
      return sendError(res, apiError('task_not_found', 'use POST /v1/workflow-drafts/compile'), 404)
    }
    if (parts.length === 3 && parts[2] === 'compile') {
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!compiler) return sendJson(res, 503, { error: true, code: 'compiler_unavailable', message: 'the workflow compiler is not available yet' })
      const parsed = await readJson(); if (!parsed.ok) return
      const r = await compileWorkflowController(compiler, parsed.value); return sendJson(res, r.status, r.body)
    }
    const draftId = decodeURIComponent(parts[2])
    if (!draftId) return sendError(res, apiError('invalid_request', 'missing draft id'), 400)
    if (parts.length === 3) {
      if (method !== 'GET') return methodNotAllowed(res, ['GET'])
      if (!compiler) return sendJson(res, 503, { error: true, code: 'compiler_unavailable', message: 'the workflow compiler is not available yet' })
      const r = await getWorkflowDraftController(compiler, draftId); return sendJson(res, r.status, r.body)
    }
    if (parts.length === 4 && parts[3] === 'approve') {
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!compiler) return sendJson(res, 503, { error: true, code: 'compiler_unavailable', message: 'the workflow compiler is not available yet' })
      const parsed = await readJson(); if (!parsed.ok) return
      const r = await approveWorkflowDraftController(compiler, draftId, parsed.value); return sendJson(res, r.status, r.body)
    }
    return sendError(res, apiError('task_not_found', 'not found'), 404)
  }

  // ── conversational workflow-builder routes (/v1/workflow-builder/sessions*) ──
  async function handleWorkflowBuilder(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], method: string, url: URL): Promise<void> {
    if (!controlStore) return sendError(res, apiError('task_not_found', 'the workflow builder is not enabled on this gateway'), 404)
    const builder = getWorkflowBuilder?.()
    const unavailable = (): void => sendJson(res, 503, { error: true, code: 'builder_unavailable', message: 'the workflow builder is not available yet' })
    const readJson = async (): Promise<{ ok: true; value: unknown } | { ok: false }> => {
      const body = await readBody(req, MAX_BODY_BYTES)
      if (!body.ok) { sendError(res, apiError('invalid_request', `request body exceeds ${MAX_BODY_BYTES} bytes`), 413); return { ok: false } }
      try { return { ok: true, value: JSON.parse(body.text) } } catch { sendJson(res, 400, { error: true, code: 'invalid_request', message: 'malformed JSON body' }); return { ok: false } }
    }
    // /v1/workflow-builder/sessions
    if (parts.length === 3 && parts[2] === 'sessions') {
      if (method === 'GET') { if (!builder) return unavailable(); const r = await listBuilderSessionsController(builder, { limit: numParam(url, 'limit'), offset: numParam(url, 'offset') }); return sendJson(res, r.status, r.body) }
      if (method === 'POST') { if (!builder) return unavailable(); const p = await readJson(); if (!p.ok) return; const r = await createBuilderSessionController(builder, p.value); return sendJson(res, r.status, r.body, r.headers) }
      return methodNotAllowed(res, ['GET', 'POST'])
    }
    if (parts.length >= 4 && parts[2] === 'sessions') {
      const sessionId = decodeURIComponent(parts[3])
      if (!sessionId) return sendError(res, apiError('invalid_request', 'missing builder session id'), 400)
      if (parts.length === 4) {
        if (method !== 'GET') return methodNotAllowed(res, ['GET'])
        if (!builder) return unavailable()
        const r = await getBuilderSessionController(builder, sessionId); return sendJson(res, r.status, r.body)
      }
      if (parts.length === 5 && parts[4] === 'messages') {
        if (method !== 'POST') return methodNotAllowed(res, ['POST'])
        if (!builder) return unavailable()
        const p = await readJson(); if (!p.ok) return
        const r = await sendBuilderMessageController(builder, sessionId, p.value); return sendJson(res, r.status, r.body, r.headers)
      }
      if (parts.length === 5 && parts[4] === 'archive') {
        if (method !== 'POST') return methodNotAllowed(res, ['POST'])
        if (!builder) return unavailable()
        const r = await archiveBuilderSessionController(builder, sessionId); return sendJson(res, r.status, r.body)
      }
    }
    return sendError(res, apiError('task_not_found', 'not found'), 404)
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (shuttingDown) return sendError(res, apiError('service_unavailable', 'gateway is shutting down'), 503)

        const url = new URL(req.url ?? '/', 'http://localhost')
        const parts = url.pathname.split('/').filter(Boolean) // ['v1','tasks',':id',...]
        const method = req.method ?? 'GET'

        // Workflow UI shell: a PUBLIC, secret-free HTML page (the JSON API stays gated).
        // A correct `?token=` sets an HttpOnly cookie + redirects to a clean URL, so the
        // page's same-origin fetches authenticate without JS ever holding the token.
        if (parts[0] === 'ui') {
          if (method !== 'GET') return methodNotAllowed(res, ['GET'])
          // The conversational builder workspace is a SIBLING page at /ui/builder; the
          // original compile/preview/approval page stays at /ui (backward-compatible).
          const isBuilder = parts[1] === 'builder'
          const cleanPath = isBuilder ? '/ui/builder' : '/ui'
          const tok = url.searchParams.get('token')
          if (tok !== null && constEq(tok, apiToken)) {
            // Bootstrap: strip the token from the URL immediately (redirect to a clean
            // path) and never cache the token-bearing request/redirect or the Set-Cookie.
            const q = isBuilder ? (url.searchParams.get('session') ? '?session=' + encodeURIComponent(url.searchParams.get('session')!) : '') : (url.searchParams.get('draft') ? '?draft=' + encodeURIComponent(url.searchParams.get('draft')!) : '')
            res.writeHead(302, { location: cleanPath + q, 'set-cookie': `${GW_COOKIE}=${encodeURIComponent(apiToken)}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
            return res.end()
          }
          // A missing/malformed/wrong token is never echoed — just serve the shell.
          const nonce = crypto.randomBytes(16).toString('base64')
          const html = isBuilder ? workflowBuilderUiHtml(nonce) : workflowUiHtml(nonce)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; connect-src 'self'; img-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'`, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
          return res.end(html)
        }

        if (!bearerMatches(req, apiToken)) return sendError(res, apiError('unauthorized', 'missing or invalid bearer token'), 401)

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
        // /v1/workflows and sub-resources (durable Workflow Runtime lifecycle)
        if (parts.length >= 2 && parts[0] === 'v1' && parts[1] === 'workflows') {
          return await handleWorkflows(req, res, parts, method)
        }
        if (parts.length >= 2 && parts[0] === 'v1' && parts[1] === 'workflow-drafts') {
          return await handleWorkflowDrafts(req, res, parts, method)
        }
        if (parts.length >= 2 && parts[0] === 'v1' && parts[1] === 'workflow-builder') {
          return await handleWorkflowBuilder(req, res, parts, method, url)
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
  function numParam(url: URL, name: string): number | undefined {
    const v = url.searchParams.get(name); if (v === null) return undefined
    const n = Number(v); return Number.isFinite(n) ? n : undefined
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
      // Rebuild non-terminal tasks from the durable store so they are immediately
      // addressable via GET/events/cancel; reconciliation proceeds in the background.
      try { recoverTasks() } catch { /* recovery best-effort; never blocks startup */ }
      resolve({
        host,
        port: boundPort,
        close: () => new Promise<void>((r) => {
          // Graceful: stop accepting new work, close SSE clients, clear timers.
          // Running tasks are NOT cancelled — only the API surface stops.
          shuttingDown = true
          clearInterval(heartbeat)
          for (const t of recoveryTimers) clearTimeout(t)
          recoveryTimers.clear()
          for (const task of tasks.values()) {
            if (task.poll) { clearInterval(task.poll); task.poll = undefined }
            if (task.abort) { try { task.abort.abort() } catch { /* ignore */ } task.abort = undefined }
            for (const sres of task.subscribers) { try { sres.end() } catch { /* ignore */ } }
            task.subscribers.clear()
          }
          for (const sres of workflowStreams) { try { sres.end() } catch { /* ignore */ } }
          workflowStreams.clear()
          server.close(() => r())
        }),
      })
    })
  })
}
