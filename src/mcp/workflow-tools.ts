/**
 * MCP tools for the durable Workflow Runtime — seven tools that are PURE HTTP
 * clients of the Agent Gateway's `/v1/workflows*` routes (same Bearer token,
 * loopback-by-default). They never instantiate the runtime, never touch the relay
 * or a Node, and never cancel a workflow on timeout/disconnect. Workflow prompts /
 * spec contents are never logged.
 *
 * Recommended host flow: vibe_create_workflow → inspect → vibe_start_workflow →
 * vibe_wait_workflow → vibe_get_workflow/events → vibe_cancel_workflow (explicit).
 */
import { GatewayApiError, type GatewayClient } from './gateway-client.js'

const WF_WAIT_MIN_S = 0.5
const WF_WAIT_MAX_S = 120
const WF_WAIT_DEFAULT_S = 30
const WF_POLL_MIN_S = 0.5
const WF_POLL_MAX_S = 30
const MAX_CURSOR = 2_147_483_647
const MAX_LIST_LIMIT = 200

type ToolContent = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: unknown }
interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<ToolContent> }

function ok(result: unknown): ToolContent { return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result } }
function toolError(code: string, message: string, extra: Record<string, unknown> = {}): ToolContent {
  const body = { error: true, code, message, ...extra }
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true, structuredContent: body }
}
function fromGatewayError(err: unknown): ToolContent {
  if (err instanceof GatewayApiError) return { content: [{ type: 'text', text: JSON.stringify(err.api, null, 2) }], isError: true, structuredContent: err.api }
  return toolError('mcp_internal_error', (err as Error).message ?? 'internal error')
}
function reqString(args: Record<string, unknown>, key: string): { ok: true; value: string } | { ok: false; err: ToolContent } {
  const v = args[key]
  if (typeof v !== 'string' || v.trim() === '') return { ok: false, err: toolError('invalid_request', `\`${key}\` is required (non-empty string)`) }
  return { ok: true, value: v }
}
function parseCursor(args: Record<string, unknown>): { ok: true; value?: number } | { ok: false; err: ToolContent } {
  if (args.after_event_id === undefined) return { ok: true }
  const n = args.after_event_id
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_CURSOR) return { ok: false, err: toolError('invalid_request', `\`after_event_id\` must be an integer in [0, ${MAX_CURSOR}]`) }
  return { ok: true, value: n }
}
function parseWaitMs(args: Record<string, unknown>, min: number, max: number, def: number): { ok: true; ms: number } | { ok: false; err: ToolContent } {
  const raw = args.wait_seconds
  if (raw === undefined) return { ok: true, ms: def * 1000 }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) return { ok: false, err: toolError('invalid_request', `\`wait_seconds\` must be a number in [${min}, ${max}]`) }
  return { ok: true, ms: raw * 1000 }
}

export function createWorkflowTools(client: GatewayClient): ToolDef[] {
  return [
    {
      name: 'vibe_list_workflows',
      description: 'List durable workflow summaries (workflow_id, name, status, current step/round, counters, timestamps, cancel intent). Optional status filter and bounded limit/offset.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['draft', 'ready', 'running', 'blocked', 'completed', 'failed', 'cancelled'] },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
          offset: { type: 'integer', minimum: 0 },
        },
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const q: { status?: string; limit?: number; offset?: number } = {}
        if (typeof args.status === 'string') q.status = args.status
        if (typeof args.limit === 'number') q.limit = args.limit
        if (typeof args.offset === 'number') q.offset = args.offset
        try { return ok(await client.listWorkflows(q)) } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_create_workflow',
      description: 'Validate a WorkflowSpec + input values and CREATE a durable workflow in status "ready". IMPORTANT: this does NOT start execution — no Agent Task runs yet. Inspect the returned spec/state, then call vibe_start_workflow explicitly to begin. (This create-then-explicit-start separation is deliberate, so a future generate→preview→approve→start flow is possible.)',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['spec'],
        properties: {
          spec: { type: 'object', description: 'a WorkflowSpec v1 object (validated server-side)' },
          input_values: { type: 'object', description: 'input values validated against spec.inputs' },
        },
      },
      handler: async (args) => {
        if (typeof args.spec !== 'object' || args.spec === null || Array.isArray(args.spec)) return toolError('invalid_request', '`spec` must be a WorkflowSpec object')
        if (args.input_values !== undefined && (typeof args.input_values !== 'object' || args.input_values === null || Array.isArray(args.input_values))) return toolError('invalid_request', '`input_values` must be an object')
        try {
          const wf = await client.createWorkflow({ spec: args.spec, input_values: args.input_values })
          const id = (wf as { workflow_id?: string }).workflow_id
          return ok({ workflow: wf, note: 'workflow created in status "ready" — it is NOT running. Call vibe_start_workflow to begin.', next: id ? { tool: 'vibe_start_workflow', arguments: { workflow_id: id } } : undefined })
        } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_start_workflow',
      description: 'Explicitly begin execution of a ready workflow (ready→running). Idempotent: a running workflow coalesces, a terminal workflow is returned unchanged, a blocked workflow returns a structured conflict (v1 has no resume). Returns the durable snapshot without waiting for completion — follow with vibe_wait_workflow.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['workflow_id'], properties: { workflow_id: { type: 'string' } } },
      handler: async (args) => {
        const id = reqString(args, 'workflow_id'); if (!id.ok) return id.err
        try { const wf = await client.startWorkflow(id.value); return ok({ workflow: wf, next: { tool: 'vibe_wait_workflow', arguments: { workflow_id: id.value } } }) } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_get_workflow',
      description: 'Get the durable WorkflowSnapshot (validated spec, normalized input values, status, current step/round, counters, context bundle, step executions, current task reference, timestamps, cancel intent, and any terminal/blocked reason).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['workflow_id'], properties: { workflow_id: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const id = reqString(args, 'workflow_id'); if (!id.ok) return id.err
        try { return ok(await client.getWorkflow(id.value)) } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_get_workflow_events',
      description: 'Bounded poll of a workflow\'s events. Returns the current workflow projection, ordered workflow events with sequence greater than after_event_id, next_event_id (a resume CURSOR = the greatest sequence consumed), terminal, blocked, and truncation metadata. Workflow event sequences start at 0 and are DISTINCT from task event ids. Loop with the returned next_event_id. Never cancels the workflow.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['workflow_id'],
        properties: {
          workflow_id: { type: 'string' },
          after_event_id: { type: 'integer', minimum: 0, maximum: MAX_CURSOR, description: 'resume cursor: return only events with sequence strictly greater than this' },
          wait_seconds: { type: 'number', minimum: WF_POLL_MIN_S, maximum: WF_POLL_MAX_S, description: `max seconds to wait for new events; must be in [${WF_POLL_MIN_S}, ${WF_POLL_MAX_S}]` },
        },
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const id = reqString(args, 'workflow_id'); if (!id.ok) return id.err
        const cur = parseCursor(args); if (!cur.ok) return cur.err
        let waitMs: number | undefined
        if (args.wait_seconds !== undefined) { const w = parseWaitMs(args, WF_POLL_MIN_S, WF_POLL_MAX_S, WF_POLL_MIN_S); if (!w.ok) return w.err; waitMs = w.ms }
        try { return ok(await client.collectWorkflowEvents(id.value, { afterId: cur.value, waitMs })) } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_wait_workflow',
      description: 'RESUMABLE BOUNDED WAIT for a workflow. Loops bounded polls within ONE overall wait_seconds budget (default 30s, min 0.5s, max 120s; out-of-range rejected), returning when the workflow becomes terminal (completed/failed/cancelled), becomes blocked (non-terminal), or the budget expires. Distinguish outcomes via terminal, blocked, and ended_by ("terminal"|"blocked"|"timeout"). On timeout the workflow is STILL RUNNING — resume with the returned next_event_id. A timeout or MCP disconnect NEVER cancels the workflow or its Agent Task; only vibe_cancel_workflow does. Authoritative GET workflow status decides truth; terminal events are never fabricated.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['workflow_id'],
        properties: {
          workflow_id: { type: 'string' },
          after_event_id: { type: 'integer', minimum: 0, maximum: MAX_CURSOR, description: 'resume cursor: continue strictly after this workflow event sequence' },
          wait_seconds: { type: 'number', minimum: WF_WAIT_MIN_S, maximum: WF_WAIT_MAX_S, description: `overall seconds to wait; must be in [${WF_WAIT_MIN_S}, ${WF_WAIT_MAX_S}] (default ${WF_WAIT_DEFAULT_S})` },
        },
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const id = reqString(args, 'workflow_id'); if (!id.ok) return id.err
        const cur = parseCursor(args); if (!cur.ok) return cur.err
        const budget = parseWaitMs(args, WF_WAIT_MIN_S, WF_WAIT_MAX_S, WF_WAIT_DEFAULT_S); if (!budget.ok) return budget.err
        try {
          const r = await client.waitForWorkflow(id.value, { afterId: cur.value, overallWaitMs: budget.ms })
          if (r.terminal || r.blocked) return ok(r)
          return ok({ ...r, workflow_id: id.value, resume: { tool: 'vibe_wait_workflow', arguments: { workflow_id: id.value, after_event_id: r.next_event_id } }, note: 'wait budget expired; the workflow is still running — resume with vibe_wait_workflow (no cancellation occurred)' })
        } catch (e) { return fromGatewayError(e) }
      },
    },
    {
      name: 'vibe_cancel_workflow',
      description: 'DESTRUCTIVE: explicitly request cancellation of a workflow and return the durable snapshot. Idempotent and durable: records cancellation intent, cancels the exact current Agent Task where present (an already-completed task keeps its status), marks the workflow cancelled once, and never deletes history. Cancellation happens ONLY through this tool.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['workflow_id'], properties: { workflow_id: { type: 'string' } } },
      annotations: { destructiveHint: true, title: 'Cancel workflow' },
      handler: async (args) => {
        const id = reqString(args, 'workflow_id'); if (!id.ok) return id.err
        try { return ok(await client.cancelWorkflow(id.value)) } catch (e) { return fromGatewayError(e) }
      },
    },
  ]
}
