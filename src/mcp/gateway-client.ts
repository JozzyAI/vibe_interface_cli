/**
 * HTTP + SSE client for the Vibe Agent Gateway. The MCP server is a PURE CLIENT of
 * this HTTP API — it never touches the relay, the relay token, or task execution
 * logic. The API Bearer token is read from the gateway's 0600 token file and used
 * ONLY in the Authorization header; it is never returned, logged, or echoed.
 */
import fs from 'fs'
import path from 'path'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
/** Bounded event-wait window: guaranteed minimum (to capture the retained replay)
 *  and a conservative maximum so a tool call can never block indefinitely. */
export const EVENT_WAIT_MIN_MS = 500
export const EVENT_WAIT_MAX_MS = 30_000
export const DEFAULT_EVENT_WAIT_MS = 10_000
const DEFAULT_HTTP_TIMEOUT_MS = 15_000

/** Overall wait budget for the higher-level workflow tools (vibe_run_task /
 *  vibe_wait_task). The workflow LOOPS bounded, single SSE polls (each still
 *  capped at EVENT_WAIT_MAX_MS) within one overall deadline — a fresh full window
 *  is never granted to each internal request past the caller's deadline. */
export const OVERALL_WAIT_MIN_MS = 500
export const OVERALL_WAIT_MAX_MS = 120_000
export const DEFAULT_OVERALL_WAIT_MS = 30_000
/** Cap on the optional agent-output text preview aggregated from delta events. */
export const OUTPUT_PREVIEW_MAX_CHARS = 4_000

const TERMINAL_TASK_EVENTS = new Set(['task.completed', 'task.failed', 'task.cancelled'])
/** End-of-forward-progress workflow events (v1 does not auto-resume `blocked`). */
const WORKFLOW_END_EVENTS = new Set(['workflow.completed', 'workflow.failed', 'workflow.cancelled', 'workflow.blocked'])

/** A structured Gateway error surfaced to MCP tool callers (never carries a token). */
export interface GatewayError {
  error: true
  code: string
  message: string
  retryable?: boolean
  task_id?: string
  details?: Record<string, unknown>
  http_status?: number
}

export class GatewayApiError extends Error {
  constructor(public readonly api: GatewayError) { super(api.message) }
}

/** Typed create-task request body. `idempotency_key` is optional; supplying it lets
 *  a caller (e.g. a future WorkflowRuntime, keyed by step_execution_id) retry the
 *  identical request safely and get the SAME task back instead of a second run. */
export interface StartTaskRequest {
  agent: string
  node_id?: string
  input: { text: string }
  workspace?: { workspace_key?: string }
  execution?: { permission_mode?: string }
  metadata?: Record<string, unknown>
  idempotency_key?: string
  workspace_lease_id?: string
}

export function isLoopbackGatewayUrl(url: string): boolean {
  try { return LOOPBACK_HOSTS.has(new URL(url).hostname) } catch { return false }
}

// ── read + validate the gateway token file (read-only; never creates it) ──────

export type TokenRead = { ok: true; token: string } | { ok: false; code: string; message: string }

/**
 * Read the API bearer token from the gateway's token file. Read-only and
 * validating (mirrors the gateway's own hygiene): requires a regular file (not a
 * symlink), rejects group/world-accessible permissions where POSIX applies, and
 * rejects empty/malformed contents. The path — never the token — may appear in errors.
 */
export function readGatewayToken(tokenPath: string): TokenRead {
  const abs = path.resolve(tokenPath)
  let st: fs.Stats
  try { st = fs.lstatSync(abs) }
  catch { return { ok: false, code: 'token_file_missing', message: `gateway token file not found: ${abs} (start the gateway first)` } }
  if (st.isSymbolicLink()) return { ok: false, code: 'token_file_symlink', message: `refusing to read token file ${abs}: it is a symbolic link` }
  if (!st.isFile()) return { ok: false, code: 'token_file_not_regular', message: `refusing to read token file ${abs}: not a regular file` }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    return { ok: false, code: 'token_file_insecure_perms', message: `refusing to read token file ${abs}: group/world-accessible (chmod 600 it)` }
  }
  let raw: string
  try { raw = fs.readFileSync(abs, 'utf8') } catch (err) { return { ok: false, code: 'token_file_read_failed', message: `could not read token file ${abs}: ${(err as Error).message}` } }
  const token = raw.trim()
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) return { ok: false, code: 'token_file_invalid', message: `token file ${abs} is empty or malformed` }
  return { ok: true, token }
}

// ── client ────────────────────────────────────────────────────────────────────

export interface CollectedEvents {
  task: unknown
  events: unknown[]
  /** Resume CURSOR: the greatest event id consumed so far (NOT the id of the next
   *  event). Pass it back as `after_event_id`; the next response yields ids
   *  strictly greater. `-1` means nothing has been consumed yet. */
  next_event_id: number
  terminal: boolean
  truncated: boolean
  ended_by: 'terminal' | 'timeout'
}

/** BOUNDED collection of workflow events + the authoritative workflow projection.
 *  `terminal`/`blocked` come from the durable workflow status (not a fabricated
 *  event). Workflow event sequences are DISTINCT from task event ids. */
export interface WorkflowCollectedEvents {
  workflow: unknown
  events: unknown[]
  next_event_id: number
  terminal: boolean
  blocked: boolean
  truncated: boolean
  ended_by: 'terminal' | 'blocked' | 'timeout'
}

/** Result of a higher-level workflow wait aggregated across bounded polls. */
export interface WorkflowWaitResult extends WorkflowCollectedEvents {}

/** Result of a higher-level workflow wait — a CollectedEvents aggregated across
 *  bounded polls, plus an optional compact text preview of agent output. */
export interface WaitResult extends CollectedEvents {
  /** Compact text derived ONLY from `agent.output.delta` events, in order, bounded
   *  to OUTPUT_PREVIEW_MAX_CHARS. Absent when no delta output was seen. */
  output_preview?: string
  /** True when `output_preview` hit the size cap and was truncated. */
  output_preview_truncated?: boolean
}

/**
 * Aggregate a compact preview from `agent.output.delta` events ONLY, in order,
 * bounded to `maxChars`. Never invents output not present in the events, never
 * discards the canonical events (the caller keeps those), and surfaces truncation
 * explicitly. Returns no preview when there was no delta output.
 */
export function summarizeDeltaEvents(events: unknown[], maxChars: number): { preview?: string; truncated: boolean } {
  let text = ''
  let sawDelta = false
  let truncated = false
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const e = ev as { type?: unknown; payload?: unknown }
    if (e.type !== 'agent.output.delta') continue
    const p = e.payload as { text?: unknown } | undefined
    const t = p && typeof p.text === 'string' ? p.text : ''
    if (!t) continue
    sawDelta = true
    if (text.length + t.length > maxChars) { text += t.slice(0, Math.max(0, maxChars - text.length)); truncated = true; break }
    text += t
  }
  if (!sawDelta) return { truncated: false }
  return { preview: text, truncated }
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
  ) {}

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra }
  }

  private async request(method: string, apiPath: string, body?: unknown): Promise<unknown> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await fetch(this.baseUrl + apiPath, {
        method,
        headers: body !== undefined ? this.authHeaders({ 'content-type': 'application/json' }) : this.authHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      })
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError'
      throw new GatewayApiError({ error: true, code: aborted ? 'gateway_timeout' : 'gateway_unreachable', message: aborted ? `gateway did not respond within ${this.timeoutMs}ms` : `could not reach the gateway: ${(err as Error).message}`, retryable: true })
    } finally { clearTimeout(timer) }

    const text = await res.text()
    let json: unknown = undefined
    try { json = text ? JSON.parse(text) : undefined } catch { /* non-JSON */ }
    if (res.status >= 400) {
      const api = (json && typeof json === 'object' && (json as { error?: unknown }).error === true)
        ? { ...(json as Record<string, unknown>), http_status: res.status } as unknown as GatewayError
        : { error: true as const, code: 'gateway_error', message: `gateway returned HTTP ${res.status}`, http_status: res.status }
      throw new GatewayApiError(api)
    }
    return json
  }

  async listAgents(): Promise<unknown> { return this.request('GET', '/v1/agents') }
  /** Create a task. `idempotency_key` (optional) makes create-or-return safe across
   *  a crash/retry — the future WorkflowRuntime passes a step_execution_id here. */
  async startTask(body: StartTaskRequest | Record<string, unknown>): Promise<unknown> { return this.request('POST', '/v1/tasks', body) }
  async getTask(taskId: string): Promise<unknown> { return this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`) }
  async cancelTask(taskId: string): Promise<unknown> { return this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`) }

  /**
   * BOUNDED event collection over the gateway's SSE endpoint. Reads events with id
   * strictly greater than `afterId` (via Last-Event-ID — so no event is duplicated
   * at the cursor boundary) for up to `waitMs` (clamped to [EVENT_WAIT_MIN_MS,
   * EVENT_WAIT_MAX_MS]), returning early on the terminal event. Returns
   * `next_event_id` = the greatest id consumed (a resume CURSOR to pass back as
   * `afterId`); a poll that consumes nothing preserves the caller's cursor.
   * Closing/timing out only drops the SSE subscriber — it NEVER cancels the task.
   * Order is preserved by seq. A gateway replay-truncation warning is surfaced as
   * `truncated` (the returned cursor stays safe/usable).
   */
  async collectEvents(taskId: string, opts: { afterId?: number; waitMs?: number } = {}): Promise<CollectedEvents> {
    const waitMs = Math.min(Math.max(opts.waitMs ?? DEFAULT_EVENT_WAIT_MS, EVENT_WAIT_MIN_MS), EVENT_WAIT_MAX_MS)
    const headers = this.authHeaders({ accept: 'text/event-stream' })
    if (opts.afterId !== undefined) headers['last-event-id'] = String(opts.afterId)

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), waitMs)
    const events: unknown[] = []
    let sawTerminalEvent = false
    let truncated = false
    // Resume cursor = the greatest event id CONSUMED. Initialised to the caller's
    // prior cursor (or -1 if none), so a poll that receives nothing preserves it.
    let lastSeq = opts.afterId ?? -1

    try {
      const res = await fetch(this.baseUrl + `/v1/tasks/${encodeURIComponent(taskId)}/events`, { method: 'GET', headers, signal: ac.signal })
      if (res.status >= 400) {
        clearTimeout(timer)
        const text = await res.text(); let json: unknown; try { json = JSON.parse(text) } catch { /* */ }
        const api = (json && (json as { error?: unknown }).error === true) ? { ...(json as Record<string, unknown>), http_status: res.status } as unknown as GatewayError : { error: true as const, code: 'gateway_error', message: `gateway returned HTTP ${res.status}`, http_status: res.status }
        throw new GatewayApiError(api)
      }
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
          if (!frame) continue
          if (frame.startsWith(':')) { if (frame.includes('predates the retained buffer')) truncated = true; continue }
          let type = ''; let dataLine = ''; let idLine = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7)
            else if (line.startsWith('data: ')) dataLine = line.slice(6)
            else if (line.startsWith('id: ')) idLine = line.slice(4)
          }
          if (!type) continue
          let payload: unknown = dataLine
          try { payload = JSON.parse(dataLine) } catch { /* keep raw */ }
          events.push(payload)
          const seq = Number(idLine)
          if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq)
          if (TERMINAL_TASK_EVENTS.has(type)) { sawTerminalEvent = true; break outer }
        }
      }
      try { await reader.cancel() } catch { /* ignore */ }
    } catch (err) {
      if (err instanceof GatewayApiError) throw err
      // AbortError = the bounded wait elapsed → return what we have (not an error).
      if ((err as Error).name !== 'AbortError') throw new GatewayApiError({ error: true, code: 'gateway_unreachable', message: `event stream failed: ${(err as Error).message}`, retryable: true })
    } finally { clearTimeout(timer); ac.abort() }

    // AUTHORITATIVE terminal decision from the canonical Task — not just from this
    // SSE window. If GET reports a terminal status we return terminal even when the
    // terminal event was not observed here (we do NOT fabricate one into `events`).
    const task = await this.getTask(taskId)
    const status = (task && typeof task === 'object') ? (task as { status?: unknown }).status : undefined
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
    void sawTerminalEvent // observed via the stream, but the Task status is authoritative
    return { task, events, next_event_id: lastSeq, terminal, truncated, ended_by: terminal ? 'terminal' : 'timeout' }
  }

  /**
   * Higher-level WORKFLOW wait: repeatedly resume `collectEvents` from the last
   * consumed cursor until the task is terminal (authoritative Task status) or one
   * OVERALL deadline expires. Each internal poll is bounded to `min(remaining
   * budget, EVENT_WAIT_MAX_MS)` — the caller's `overallWaitMs` is a single budget
   * shared across polls, never re-granted per request, so the total wait can never
   * exceed it. Events are aggregated in order with no gap or boundary-duplicate
   * (each resume uses the prior cursor). A poll that consumes nothing preserves the
   * cursor. Terminal is decided by the authoritative Task; a missed terminal SSE
   * event is NOT fabricated. Timing out or disconnecting NEVER cancels the task.
   */
  async waitForTask(taskId: string, opts: { afterId?: number; overallWaitMs?: number } = {}): Promise<WaitResult> {
    const overall = Math.min(Math.max(opts.overallWaitMs ?? DEFAULT_OVERALL_WAIT_MS, OVERALL_WAIT_MIN_MS), OVERALL_WAIT_MAX_MS)
    const deadline = Date.now() + overall
    let cursor = opts.afterId ?? -1
    const events: unknown[] = []
    let truncated = false
    let last: CollectedEvents | undefined
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining < EVENT_WAIT_MIN_MS) break // no budget for even a minimum poll
      const waitMs = Math.min(remaining, EVENT_WAIT_MAX_MS)
      const r = await this.collectEvents(taskId, { afterId: cursor, waitMs })
      if (r.events.length) events.push(...r.events)
      cursor = r.next_event_id
      truncated = truncated || r.truncated
      last = r
      if (r.terminal) break
    }
    // At least one poll always runs (overall >= EVENT_WAIT_MIN_MS), so `last` is set.
    const task = last!.task
    const terminal = last!.terminal
    const preview = summarizeDeltaEvents(events, OUTPUT_PREVIEW_MAX_CHARS)
    return {
      task, events, next_event_id: cursor, terminal, truncated,
      ended_by: terminal ? 'terminal' : 'timeout',
      ...(preview.preview !== undefined ? { output_preview: preview.preview, output_preview_truncated: preview.truncated } : {}),
    }
  }

  // ── workflows (durable Workflow Runtime lifecycle; same Gateway + Bearer token) ─

  async listWorkflows(query: { status?: string; limit?: number; offset?: number } = {}): Promise<unknown> {
    const q = new URLSearchParams()
    if (query.status) q.set('status', query.status)
    if (query.limit !== undefined) q.set('limit', String(query.limit))
    if (query.offset !== undefined) q.set('offset', String(query.offset))
    const qs = q.toString()
    return this.request('GET', `/v1/workflows${qs ? `?${qs}` : ''}`)
  }
  /** Create a workflow (validated, status `ready`) — does NOT start execution. */
  async createWorkflow(body: { spec: unknown; input_values?: unknown }): Promise<unknown> { return this.request('POST', '/v1/workflows', body) }
  /** Explicitly begin execution (idempotent; running/terminal return the snapshot). */
  async startWorkflow(workflowId: string): Promise<unknown> { return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/start`) }
  async getWorkflow(workflowId: string): Promise<unknown> { return this.request('GET', `/v1/workflows/${encodeURIComponent(workflowId)}`) }
  async cancelWorkflow(workflowId: string): Promise<unknown> { return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/cancel`) }

  /**
   * BOUNDED collection of a workflow's events over SSE — the workflow analogue of
   * collectEvents. Reads workflow events with sequence strictly greater than
   * `afterId` for up to `waitMs`, returning early on an end-of-progress event. The
   * authoritative GET workflow status decides terminal/blocked (a missed terminal
   * SSE event is never fabricated). Closing/timing out only drops the SSE
   * subscriber — it NEVER cancels the workflow. Workflow event sequences are
   * DISTINCT from task event ids.
   */
  async collectWorkflowEvents(workflowId: string, opts: { afterId?: number; waitMs?: number } = {}): Promise<WorkflowCollectedEvents> {
    const waitMs = Math.min(Math.max(opts.waitMs ?? DEFAULT_EVENT_WAIT_MS, EVENT_WAIT_MIN_MS), EVENT_WAIT_MAX_MS)
    const headers = this.authHeaders({ accept: 'text/event-stream' })
    if (opts.afterId !== undefined) headers['last-event-id'] = String(opts.afterId)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), waitMs)
    const events: unknown[] = []
    let truncated = false
    let lastSeq = opts.afterId ?? -1
    try {
      const res = await fetch(this.baseUrl + `/v1/workflows/${encodeURIComponent(workflowId)}/events`, { method: 'GET', headers, signal: ac.signal })
      if (res.status >= 400) {
        clearTimeout(timer)
        const text = await res.text(); let json: unknown; try { json = JSON.parse(text) } catch { /* */ }
        const api = (json && (json as { error?: unknown }).error === true) ? { ...(json as Record<string, unknown>), http_status: res.status } as unknown as GatewayError : { error: true as const, code: 'gateway_error', message: `gateway returned HTTP ${res.status}`, http_status: res.status }
        throw new GatewayApiError(api)
      }
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const f = buf.slice(0, idx); buf = buf.slice(idx + 2)
          if (!f) continue
          if (f.startsWith(':')) { if (f.includes('truncated')) truncated = true; continue }
          let type = ''; let dataLine = ''; let idLine = ''
          for (const line of f.split('\n')) { if (line.startsWith('event: ')) type = line.slice(7); else if (line.startsWith('data: ')) dataLine = line.slice(6); else if (line.startsWith('id: ')) idLine = line.slice(4) }
          if (!type) continue
          let payload: unknown = dataLine; try { payload = JSON.parse(dataLine) } catch { /* */ }
          events.push(payload)
          const seq = Number(idLine); if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq)
          if (WORKFLOW_END_EVENTS.has(type)) break outer
        }
      }
      try { await reader.cancel() } catch { /* */ }
    } catch (err) {
      if (err instanceof GatewayApiError) throw err
      if ((err as Error).name !== 'AbortError') throw new GatewayApiError({ error: true, code: 'gateway_unreachable', message: `workflow event stream failed: ${(err as Error).message}`, retryable: true })
    } finally { clearTimeout(timer); ac.abort() }

    // Authoritative terminal/blocked decision from the durable workflow projection.
    const workflow = await this.getWorkflow(workflowId)
    const status = (workflow && typeof workflow === 'object') ? (workflow as { status?: unknown }).status : undefined
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
    const blocked = status === 'blocked'
    return { workflow, events, next_event_id: lastSeq, terminal, blocked, truncated, ended_by: terminal ? 'terminal' : blocked ? 'blocked' : 'timeout' }
  }

  /**
   * Higher-level WORKFLOW wait: resume collectWorkflowEvents from the last cursor
   * until the workflow is terminal OR blocked (authoritative status) or ONE overall
   * budget expires. No gap/boundary-duplicate across resumes. A timeout/disconnect
   * NEVER cancels the workflow or its current Agent Task.
   */
  async waitForWorkflow(workflowId: string, opts: { afterId?: number; overallWaitMs?: number } = {}): Promise<WorkflowWaitResult> {
    const overall = Math.min(Math.max(opts.overallWaitMs ?? DEFAULT_OVERALL_WAIT_MS, OVERALL_WAIT_MIN_MS), OVERALL_WAIT_MAX_MS)
    const deadline = Date.now() + overall
    let cursor = opts.afterId ?? -1
    const events: unknown[] = []
    let truncated = false
    let last: WorkflowCollectedEvents | undefined
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining < EVENT_WAIT_MIN_MS) break
      const r = await this.collectWorkflowEvents(workflowId, { afterId: cursor, waitMs: Math.min(remaining, EVENT_WAIT_MAX_MS) })
      if (r.events.length) events.push(...r.events)
      cursor = r.next_event_id; truncated = truncated || r.truncated; last = r
      if (r.terminal || r.blocked) break
    }
    const terminal = last!.terminal; const blocked = last!.blocked
    return { workflow: last!.workflow, events, next_event_id: cursor, terminal, blocked, truncated, ended_by: terminal ? 'terminal' : blocked ? 'blocked' : 'timeout' }
  }
}
