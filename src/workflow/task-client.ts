/**
 * The `AgentTaskClient` abstraction the Workflow Runtime depends on, plus a
 * production adapter over the existing Gateway HTTP client (`GatewayClient`).
 *
 * The runtime never talks to the relay, the Node daemon, or the MCP server — it
 * creates and observes durable Agent Tasks ONLY through this narrow interface.
 * Focused tests inject a deterministic fake implementing the same interface.
 */
import type { RuntimeTaskEvent } from './output-parser.js'
import { GatewayClient, GatewayApiError } from '../mcp/gateway-client.js'

/** A create-task request. `idempotency_key` is REQUIRED — the runtime always uses
 *  the step_execution_id so a retry never starts a second backend run. */
export interface AgentTaskCreateRequest {
  agent: string
  node_id?: string
  input: { text: string }
  workspace_key?: string
  permission_mode?: 'default' | 'unsafe-skip'
  metadata?: Record<string, unknown>
  idempotency_key: string
}

export interface AgentTaskRef { task_id: string }

export interface AgentTaskState {
  task_id: string
  status: string
  terminal: boolean
  /** Canonical event history is complete (`history.complete === true`). Retained as
   *  DIAGNOSTIC evidence only — the runtime routes on the AgentTaskResult, not on
   *  event history. */
  history_complete: boolean
  /** First-class AgentTaskResult status: 'available' | 'missing' | 'invalid' (or
   *  undefined for a legacy task without a result). The authoritative control result. */
  result_status?: string
  /** The authoritative final output text (present iff result_status === 'available').
   *  The runtime parses THIS into the step schema — never the event history. */
  result_text?: string
}

export interface AgentTaskTerminalRead extends AgentTaskState {
  /** Ordered canonical Task events consumed in this window (for output extraction). */
  events: RuntimeTaskEvent[]
  /** Resume cursor = the greatest event id consumed. */
  next_event_id: number
}

export interface AgentTaskClient {
  /** Create a task (idempotent by `idempotency_key`). */
  createTask(req: AgentTaskCreateRequest): Promise<AgentTaskRef>
  /** Authoritative current task projection. */
  getTask(taskId: string): Promise<AgentTaskState>
  /** ONE bounded wait window: collect events + report authoritative terminal state.
   *  Never cancels the task on timeout/disconnect. */
  waitForTerminal(taskId: string, opts: { afterId?: number; budgetMs: number; signal?: AbortSignal }): Promise<AgentTaskTerminalRead>
  /** Request cancellation of a specific task (idempotent). */
  cancelTask(taskId: string): Promise<void>
}

/** A transient (retryable) transport/service failure — the runtime waits and
 *  retries with bounded backoff rather than failing the workflow. */
export class TransientAgentTaskError extends Error {
  constructor(message: string) { super(message); this.name = 'TransientAgentTaskError' }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const RETRYABLE_CODES = new Set(['gateway_unreachable', 'gateway_error', 'service_unavailable', 'node_offline', 'internal_error'])

function isTerminalStatus(s: unknown): boolean { return typeof s === 'string' && TERMINAL.has(s) }
function historyComplete(task: unknown): boolean {
  const h = (task && typeof task === 'object') ? (task as { history?: { complete?: unknown } }).history : undefined
  return h?.complete === true
}
function resultStatusOf(task: unknown): string | undefined {
  const v = (task && typeof task === 'object') ? (task as { result_status?: unknown }).result_status : undefined
  return typeof v === 'string' ? v : undefined
}
function resultTextOf(task: unknown): string | undefined {
  const r = (task && typeof task === 'object') ? (task as { result?: { final_output?: { text?: unknown } } }).result : undefined
  const t = r?.final_output?.text
  return typeof t === 'string' ? t : undefined
}
function statusOf(task: unknown): string {
  return (task && typeof task === 'object' && typeof (task as { status?: unknown }).status === 'string') ? (task as { status: string }).status : 'unknown'
}
function taskIdOf(task: unknown, fallback: string): string {
  return (task && typeof task === 'object' && typeof (task as { task_id?: unknown }).task_id === 'string') ? (task as { task_id: string }).task_id : fallback
}

/** Translate a GatewayApiError into either a transient (retryable) signal or a
 *  fatal rethrow, so the runtime can back off vs. fail deterministically. */
function classify(err: unknown): never {
  if (err instanceof GatewayApiError) {
    if (err.api.retryable === true || RETRYABLE_CODES.has(err.api.code)) throw new TransientAgentTaskError(err.api.message)
    throw err
  }
  // An unexpected network/abort error is treated as transient (bounded retry).
  throw new TransientAgentTaskError((err as Error)?.message ?? 'agent task client error')
}

/** Production adapter over the Gateway HTTP client. */
export class GatewayAgentTaskClient implements AgentTaskClient {
  constructor(private readonly client: GatewayClient) {}

  async createTask(req: AgentTaskCreateRequest): Promise<AgentTaskRef> {
    let task: unknown
    try {
      task = await this.client.startTask({
        agent: req.agent,
        ...(req.node_id ? { node_id: req.node_id } : {}),
        input: req.input,
        ...(req.workspace_key ? { workspace: { workspace_key: req.workspace_key } } : {}),
        ...(req.permission_mode ? { execution: { permission_mode: req.permission_mode } } : {}),
        ...(req.metadata ? { metadata: req.metadata } : {}),
        idempotency_key: req.idempotency_key,
      })
    } catch (err) { classify(err) }
    const taskId = taskIdOf(task, '')
    if (!taskId) throw new TransientAgentTaskError('gateway did not return a task_id')
    return { task_id: taskId }
  }

  async getTask(taskId: string): Promise<AgentTaskState> {
    let task: unknown
    try { task = await this.client.getTask(taskId) } catch (err) { classify(err) }
    const status = statusOf(task)
    return { task_id: taskIdOf(task, taskId), status, terminal: isTerminalStatus(status), history_complete: historyComplete(task), result_status: resultStatusOf(task), result_text: resultTextOf(task) }
  }

  async waitForTerminal(taskId: string, opts: { afterId?: number; budgetMs: number; signal?: AbortSignal }): Promise<AgentTaskTerminalRead> {
    if (opts.signal?.aborted) throw new TransientAgentTaskError('aborted')
    let r: Awaited<ReturnType<GatewayClient['waitForTask']>>
    try { r = await this.client.waitForTask(taskId, { afterId: opts.afterId, overallWaitMs: opts.budgetMs }) } catch (err) { classify(err) }
    const status = statusOf(r.task)
    return {
      task_id: taskIdOf(r.task, taskId), status, terminal: r.terminal || isTerminalStatus(status),
      history_complete: historyComplete(r.task), result_status: resultStatusOf(r.task), result_text: resultTextOf(r.task),
      events: r.events as RuntimeTaskEvent[], next_event_id: r.next_event_id,
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    try { await this.client.cancelTask(taskId) } catch (err) { classify(err) }
  }
}
