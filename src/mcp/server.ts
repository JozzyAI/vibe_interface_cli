/**
 * Minimal, dependency-free MCP server for the Vibe Agent Gateway.
 *
 * Implements MCP JSON-RPC 2.0 over newline-delimited stdio — protocol version
 * `2025-06-18` (negotiated with the client) — methods `initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call`, `ping`. No MCP SDK
 * dependency is added (keeping deps minimal and avoiding an unofficial-fork /
 * offline-verification risk); the wire surface implemented here is small and stable.
 *
 * The server is a PURE CLIENT of the Agent Gateway HTTP API (see gateway-client):
 * it never touches the relay, the relay token, or task execution, and never
 * cancels a task on client disconnect. stdout carries ONLY protocol messages;
 * diagnostics go to stderr and never contain the token.
 */
import { GatewayApiError, type GatewayClient } from './gateway-client.js'

/** Overall wait budget bounds for the higher-level workflow tools (in seconds).
 *  Wider than a single SSE poll (still capped at 30s inside gateway-client): the
 *  workflow loops bounded polls within this one budget. */
const RUN_WAIT_MIN_S = 0.5
const RUN_WAIT_MAX_S = 120
const RUN_WAIT_DEFAULT_S = 30

/** Preferred protocol version (latest stable). Older supported revisions are also
 *  accepted; an unknown/future version negotiates DOWN to this — we never claim an
 *  unimplemented version. */
export const SUPPORTED_PROTOCOL = '2025-11-25'
const KNOWN_PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
const MAX_CURSOR = 2_147_483_647
const WAIT_MIN_S = 0.5
const WAIT_MAX_S = 30

interface JsonRpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type ToolContent = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: unknown }
interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<ToolContent>
}

// ── result / error helpers ────────────────────────────────────────────────────

function ok(result: unknown): ToolContent {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }
}
function toolError(code: string, message: string, extra: Record<string, unknown> = {}): ToolContent {
  const body = { error: true, code, message, ...extra }
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true, structuredContent: body }
}
function fromGatewayError(err: unknown): ToolContent {
  if (err instanceof GatewayApiError) return { content: [{ type: 'text', text: JSON.stringify(err.api, null, 2) }], isError: true, structuredContent: err.api }
  return toolError('mcp_internal_error', (err as Error).message ?? 'internal error')
}

// ── arg validation (defensive; hosts may not enforce inputSchema) ──────────────

function reqString(args: Record<string, unknown>, key: string): { ok: true; value: string } | { ok: false; err: ToolContent } {
  const v = args[key]
  if (typeof v !== 'string' || v.trim() === '') return { ok: false, err: toolError('invalid_request', `\`${key}\` is required (non-empty string)`) }
  return { ok: true, value: v }
}

/** Shared inputSchema fragment for the create-task fields — only Gateway v1
 *  supported fields (no workspace.path/repo_url/branch, no timeout, no commands). */
const START_TASK_PROPERTIES: Record<string, unknown> = {
  agent: { type: 'string', description: 'agent id (e.g. mock, claude-code, codex)' },
  node_id: { type: 'string', description: 'target remote node id; omit for the local mock' },
  input_text: { type: 'string', description: 'the task prompt' },
  workspace_key: { type: 'string', description: 'opaque workspace key ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ (NOT a path); omit to auto-generate', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
  permission_mode: { type: 'string', enum: ['default', 'unsafe-skip'] },
  metadata: { type: 'object' },
}

/** Validate + build the Gateway POST /v1/tasks body from shared create-task args.
 *  Only Gateway v1 supported fields are forwarded. */
function buildStartBody(args: Record<string, unknown>): { ok: true; body: Record<string, unknown> } | { ok: false; err: ToolContent } {
  const agent = reqString(args, 'agent'); if (!agent.ok) return { ok: false, err: agent.err }
  const text = reqString(args, 'input_text'); if (!text.ok) return { ok: false, err: text.err }
  if (args.node_id !== undefined && typeof args.node_id !== 'string') return { ok: false, err: toolError('invalid_request', '`node_id` must be a string') }
  if (args.workspace_key !== undefined && typeof args.workspace_key !== 'string') return { ok: false, err: toolError('invalid_request', '`workspace_key` must be a string') }
  if (args.permission_mode !== undefined && args.permission_mode !== 'default' && args.permission_mode !== 'unsafe-skip') return { ok: false, err: toolError('invalid_request', '`permission_mode` must be "default" or "unsafe-skip"') }
  if (args.metadata !== undefined && (typeof args.metadata !== 'object' || args.metadata === null || Array.isArray(args.metadata))) return { ok: false, err: toolError('invalid_request', '`metadata` must be an object') }
  const body: Record<string, unknown> = { agent: agent.value, input: { text: text.value } }
  if (typeof args.node_id === 'string') body.node_id = args.node_id
  if (typeof args.workspace_key === 'string') body.workspace = { workspace_key: args.workspace_key }
  if (args.permission_mode) body.execution = { permission_mode: args.permission_mode }
  if (args.metadata) body.metadata = args.metadata
  return { ok: true, body }
}

/** Parse an optional `wait_seconds` into a bounded overall-wait budget in ms.
 *  Out-of-range/non-finite is REJECTED (not clamped); absent uses the default. */
function parseWaitBudgetMs(args: Record<string, unknown>): { ok: true; ms: number } | { ok: false; err: ToolContent } {
  const raw = args.wait_seconds
  if (raw === undefined) return { ok: true, ms: RUN_WAIT_DEFAULT_S * 1000 }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < RUN_WAIT_MIN_S || raw > RUN_WAIT_MAX_S) return { ok: false, err: toolError('invalid_request', `\`wait_seconds\` must be a number in [${RUN_WAIT_MIN_S}, ${RUN_WAIT_MAX_S}]`) }
  return { ok: true, ms: raw * 1000 }
}

export function createGatewayTools(client: GatewayClient): ToolDef[] {
  return [
    {
      name: 'vibe_list_agents',
      description: 'List agents the Vibe Agent Gateway can run — the local mock agent plus each online remote node\'s advertised agents (e.g. claude-code, codex).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: async () => { try { return ok(await client.listAgents()) } catch (e) { return fromGatewayError(e) } },
    },
    {
      name: 'vibe_start_task',
      description: 'Start an agent task and return the canonical Task (status typically "running") WITHOUT waiting. Follow it with vibe_get_task_events (or use vibe_run_task to start and wait in one call). Only Gateway v1 fields are accepted.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['agent', 'input_text'],
        properties: { ...START_TASK_PROPERTIES },
      },
      handler: async (args) => {
        const built = buildStartBody(args); if (!built.ok) return built.err
        try {
          const task = await client.startTask(built.body)
          const taskId = (task as { task_id?: string }).task_id
          return ok({ task, next: taskId ? { tool: 'vibe_get_task_events', arguments: { task_id: taskId } } : undefined })
        } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_run_task',
      description: 'CONVENIENCE WORKFLOW: start an agent task AND wait (bounded) for it to finish, in one call. Creates the task, then resumes its events until the task is terminal or the overall wait budget (wait_seconds, default 30s, max 120s) expires. MAY RETURN BEFORE COMPLETION: if it returns terminal=false / ended_by="timeout", the task is STILL RUNNING — continue it with vibe_wait_task using the returned task_id and next_event_id (resume cursor). A timeout or MCP disconnect NEVER cancels the task; only vibe_cancel_task does. Returns the authoritative Task, ordered events, next_event_id, terminal, ended_by, truncated, and (if any) a bounded output_preview.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['agent', 'input_text'],
        properties: {
          ...START_TASK_PROPERTIES,
          wait_seconds: { type: 'number', minimum: RUN_WAIT_MIN_S, maximum: RUN_WAIT_MAX_S, description: `overall seconds to wait for completion; must be in [${RUN_WAIT_MIN_S}, ${RUN_WAIT_MAX_S}] (default ${RUN_WAIT_DEFAULT_S})` },
        },
      },
      handler: async (args) => {
        const built = buildStartBody(args); if (!built.ok) return built.err
        const budget = parseWaitBudgetMs(args); if (!budget.ok) return budget.err
        // 1) Create the task. A failure here means nothing is running.
        let taskId: string
        try {
          const created = await client.startTask(built.body)
          const id = (created as { task_id?: unknown }).task_id
          if (typeof id !== 'string' || id === '') return ok({ task: created, note: 'task created but no task_id was returned; cannot wait', terminal: false, ended_by: 'timeout' })
          taskId = id
        } catch (e) { return fromGatewayError(e) }
        // 2) Wait bounded for completion. If waiting fails AFTER creation, the task
        //    may still be running — surface the task_id and DO NOT cancel it.
        try {
          const r = await client.waitForTask(taskId, { overallWaitMs: budget.ms })
          return ok(r.terminal ? r : { ...r, task_id: taskId, resume: { tool: 'vibe_wait_task', arguments: { task_id: taskId, after_event_id: r.next_event_id } }, note: 'wait budget expired; the task is still running — resume with vibe_wait_task (no cancellation occurred)' })
        } catch (e) {
          const base = e instanceof GatewayApiError ? e.api : { error: true, code: 'mcp_internal_error', message: (e as Error).message }
          return { content: [{ type: 'text', text: JSON.stringify({ ...base, task_id: taskId, terminal: false, note: 'task was created and MAY STILL BE RUNNING; waiting failed and no cancellation occurred — resume with vibe_wait_task', resume: { tool: 'vibe_wait_task', arguments: { task_id: taskId } } }, null, 2) }], isError: true }
        }
      },
    },
    {
      name: 'vibe_get_task',
      description: 'Get the current canonical Task for a task_id (authoritative status).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['task_id'], properties: { task_id: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const id = reqString(args, 'task_id'); if (!id.ok) return id.err
        try { return ok(await client.getTask(id.value)) } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_get_task_events',
      description: 'Bounded poll of a task\'s events. Returns the current task, ordered events with id greater than after_event_id, next_event_id (a resume CURSOR = the greatest id consumed, NOT the next id), terminal, and whether the wait ended by "terminal" or "timeout". Bounded request/response (NOT an endless stream); loop with the returned next_event_id as after_event_id. Terminal is decided by the authoritative Task status. Never cancels the task.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['task_id'],
        properties: {
          task_id: { type: 'string' },
          after_event_id: { type: 'integer', minimum: 0, maximum: MAX_CURSOR, description: 'resume cursor: return only events with id strictly greater than this' },
          wait_seconds: { type: 'number', minimum: WAIT_MIN_S, maximum: WAIT_MAX_S, description: `max seconds to wait for new events; must be in [${WAIT_MIN_S}, ${WAIT_MAX_S}]` },
        },
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const id = reqString(args, 'task_id'); if (!id.ok) return id.err
        let afterId: number | undefined
        if (args.after_event_id !== undefined) {
          const n = args.after_event_id
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_CURSOR) return toolError('invalid_request', `\`after_event_id\` must be an integer in [0, ${MAX_CURSOR}]`)
          afterId = n
        }
        let waitMs: number | undefined
        if (args.wait_seconds !== undefined) {
          const w = args.wait_seconds
          // Reject out-of-range values (do NOT silently clamp upward).
          if (typeof w !== 'number' || !Number.isFinite(w) || w < WAIT_MIN_S || w > WAIT_MAX_S) return toolError('invalid_request', `\`wait_seconds\` must be a number in [${WAIT_MIN_S}, ${WAIT_MAX_S}]`)
          waitMs = w * 1000
        }
        try { return ok(await client.collectEvents(id.value, { afterId, waitMs })) } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_wait_task',
      description: 'RESUMABLE BOUNDED WAIT: continue an existing task from a resume cursor and wait (bounded) for it to finish. The primary continuation path for a task returned by vibe_run_task with terminal=false. Pass after_event_id = the next_event_id you last received; resumes strictly after it with no gap and no duplicate boundary event. Loops bounded polls within wait_seconds (default 30s, max 120s), stopping on terminal (authoritative Task status) or timeout. A no-new-event timeout preserves your cursor. A timeout or MCP disconnect NEVER cancels the task. Returns task, ordered events, next_event_id, terminal, ended_by, truncated, and (if any) a bounded output_preview.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['task_id'],
        properties: {
          task_id: { type: 'string' },
          after_event_id: { type: 'integer', minimum: 0, maximum: MAX_CURSOR, description: 'resume cursor: continue strictly after this event id (the next_event_id from a prior call)' },
          wait_seconds: { type: 'number', minimum: RUN_WAIT_MIN_S, maximum: RUN_WAIT_MAX_S, description: `overall seconds to wait for completion; must be in [${RUN_WAIT_MIN_S}, ${RUN_WAIT_MAX_S}] (default ${RUN_WAIT_DEFAULT_S})` },
        },
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const id = reqString(args, 'task_id'); if (!id.ok) return id.err
        let afterId: number | undefined
        if (args.after_event_id !== undefined) {
          const n = args.after_event_id
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_CURSOR) return toolError('invalid_request', `\`after_event_id\` must be an integer in [0, ${MAX_CURSOR}]`)
          afterId = n
        }
        const budget = parseWaitBudgetMs(args); if (!budget.ok) return budget.err
        try {
          const r = await client.waitForTask(id.value, { afterId, overallWaitMs: budget.ms })
          return ok(r.terminal ? r : { ...r, task_id: id.value, resume: { tool: 'vibe_wait_task', arguments: { task_id: id.value, after_event_id: r.next_event_id } }, note: 'wait budget expired; the task is still running — resume again with vibe_wait_task (no cancellation occurred)' })
        } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_cancel_task',
      description: 'DESTRUCTIVE: request cancellation of a running task and return the current canonical Task. Idempotent (the gateway owns idempotency): cancelling an already-terminal task returns it unchanged.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['task_id'], properties: { task_id: { type: 'string' } } },
      annotations: { destructiveHint: true, title: 'Cancel task' },
      handler: async (args) => {
        const id = reqString(args, 'task_id'); if (!id.ok) return id.err
        try { return ok(await client.cancelTask(id.value)) } catch (e) { return fromGatewayError(e) }
      },
    },
  ]
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

export interface McpServer {
  tools: ToolDef[]
  /** Handle one JSON-RPC message; resolves to a response object, or null for a notification. */
  handle(msg: JsonRpcMessage): Promise<Record<string, unknown> | null>
}

export function createMcpServer(client: GatewayClient, serverVersion: string): McpServer {
  const tools = createGatewayTools(client)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const rpcError = (id: JsonRpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const rpcResult = (id: JsonRpcMessage['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result })

  return {
    tools,
    async handle(msg) {
      const method = msg.method
      // Notifications carry a method and NO id (a null id is tolerated as one) —
      // known or unknown, they are ignored and never answered.
      if (method !== undefined && method.startsWith('notifications/')) return null
      if (msg.id === undefined || msg.id === null) return null

      // From here it is a REQUEST (an id is present) — validate the JSON-RPC frame.
      if (typeof msg.id !== 'string' && typeof msg.id !== 'number') {
        return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: id must be a string or number' } }
      }
      if (msg.jsonrpc !== '2.0') return rpcError(msg.id, -32600, 'Invalid Request: jsonrpc must be "2.0"')
      if (typeof method !== 'string' || method === '') return rpcError(msg.id, -32600, 'Invalid Request: missing method')

      try {
        if (method === 'initialize') {
          const requested = msg.params?.protocolVersion
          // Echo an explicitly requested SUPPORTED version; otherwise negotiate to
          // our preferred version. Never echo an unknown/future version.
          const protocolVersion = typeof requested === 'string' && KNOWN_PROTOCOLS.has(requested) ? requested : SUPPORTED_PROTOCOL
          return rpcResult(msg.id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'vibe-agent-gateway', version: serverVersion } })
        }
        if (method === 'ping') return rpcResult(msg.id, {})
        if (method === 'tools/list') return rpcResult(msg.id, { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) })
        if (method === 'tools/call') {
          const name = msg.params?.name as string | undefined
          const tool = name ? byName.get(name) : undefined
          if (!tool) return rpcError(msg.id, -32602, `unknown tool: ${name ?? '(none)'}`)
          const rawArgs = msg.params?.arguments
          if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) return rpcError(msg.id, -32602, 'tool arguments must be an object')
          const result = await tool.handler((rawArgs as Record<string, unknown>) ?? {})
          return rpcResult(msg.id, result)
        }
        return rpcError(msg.id, -32601, `method not found: ${method}`)
      } catch (err) {
        // An unexpected handler exception MUST still resolve the request.
        return rpcError(msg.id, -32603, `internal error: ${(err as Error).message}`)
      }
    },
  }
}

/** Wire the server to stdio: newline-delimited JSON in/out; diagnostics to stderr. */
export function runStdioMcpServer(client: GatewayClient, serverVersion: string): void {
  const server = createMcpServer(client, serverVersion)
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: JsonRpcMessage
      try { msg = JSON.parse(line) } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); continue }
      const reqId = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : undefined
      void server.handle(msg)
        .then((resp) => { if (resp) process.stdout.write(JSON.stringify(resp) + '\n') })
        .catch((err) => {
          process.stderr.write(`[vibe-mcp] handler error: ${(err as Error).message}\n`)
          // A request must never be left unresolved on an unexpected rejection.
          if (reqId !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { code: -32603, message: 'internal error' } }) + '\n')
        })
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
