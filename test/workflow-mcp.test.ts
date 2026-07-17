/**
 * MCP workflow tools — the seven workflow tools as PURE HTTP clients of the real
 * in-process Gateway workflow routes, backed by a real WorkflowRuntime on a
 * temporary ControlStore + a deterministic fake task backend. Verifies create-not-
 * start, explicit start, get/list projections, event cursor continuity, and
 * wait terminal/blocked/timeout semantics (a timeout never cancels).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { GatewayClient } from '../src/mcp/gateway-client.js'
import { createMcpServer, type McpServer } from '../src/mcp/server.js'
import { plannerExecutorLoopExample } from '../src/workflow/examples.js'
import type { AgentTaskClient, AgentTaskCreateRequest } from '../src/workflow/task-client.js'

const TOKEN = `wfmcp-${Math.random().toString(36).slice(2)}`
const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wfmcp-')), 'control.sqlite')

interface TaskDesc { output?: Record<string, unknown>; status?: string; history_complete?: boolean; running?: boolean }
class Fake implements AgentTaskClient {
  byKey = new Map<string, any>(); byId = new Map<string, any>(); n = 0; cancels: string[] = []
  constructor(public store: SqliteControlStore, private script: (r: AgentTaskCreateRequest) => TaskDesc) {}
  releaseAll(): void { for (const t of this.byId.values()) t.released = true }
  async createTask(req: AgentTaskCreateRequest) {
    const ex = this.byKey.get(req.idempotency_key); if (ex) return { task_id: ex.task_id }
    const d = this.script(req); const task_id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id, agent: req.agent, node_id: req.node_id ?? null, status: 'queued', idempotency_key: req.idempotency_key, request_fingerprint: 'fp:' + req.idempotency_key }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    const t = { task_id, ...d, released: !d.running, key: req.idempotency_key }; this.byKey.set(req.idempotency_key, t); this.byId.set(task_id, t); return { task_id }
  }
  private view(t: any) {
    const running = t.running && !t.released; const status = running ? 'running' : (t.status ?? 'completed')
    const terminal = !running && ['completed', 'failed', 'cancelled'].includes(status)
    const events = (!running && t.output !== undefined) ? [{ type: 'agent.output.delta', payload: { stream: 'stdout', text: JSON.stringify({ from: 'events' }) } }, { type: 'task.completed', payload: {} }] : []
    let result_status: string | undefined; let result_text: string | undefined
    if (!running && status === 'completed') { result_status = t.result_status ?? (t.output !== undefined ? 'available' : 'missing'); if (result_status === 'available' && t.output !== undefined) result_text = t.result_text ?? JSON.stringify(t.output) }
    return { status, terminal, history_complete: t.history_complete !== false, events, result_status, result_text }
  }
  async getTask(id: string) { const v = this.view(this.byId.get(id)); return { task_id: id, status: v.status, terminal: v.terminal, history_complete: v.history_complete, result_status: v.result_status, result_text: v.result_text } }
  async waitForTerminal(id: string) { const t = this.byId.get(id); const v = this.view(t); if (!v.terminal) await sleep(15); return { task_id: id, status: v.status, terminal: v.terminal, history_complete: v.history_complete, result_status: v.result_status, result_text: v.result_text, events: v.events, next_event_id: v.events.length - 1 } }
  async cancelTask(id: string): Promise<void> { this.cancels.push(id); const t = this.byId.get(id); if (t && t.running && !t.released) { t.status = 'cancelled'; t.released = true } }
}
const acceptanceScript = (req: AgentTaskCreateRequest): TaskDesc => {
  const { step_id, round } = req.metadata as { step_id: string; round: number }
  if (step_id === 'plan') return { output: { status: 'continue', summary: 'plan', next_step: 'Implement part A', acceptance_criteria: ['a'] } }
  if (step_id === 'implement' && round === 1) return { output: { status: 'implemented', summary: 'A', changed_files: ['a.ts'], tests_run: ['t1'], remaining_work: [], risks: [] } }
  if (step_id === 'review' && round === 1) return { output: { status: 'continue', summary: 'r', next_step: 'Implement part B' } }
  if (step_id === 'implement' && round === 2) return { output: { status: 'implemented', summary: 'B', changed_files: ['b.ts'], tests_run: ['t2'], remaining_work: [], risks: [] } }
  return { output: { status: 'complete', summary: 'done' } }
}

async function withMcp(taskClientFor: (s: SqliteControlStore) => AgentTaskClient, fn: (ctx: { mcp: McpServer; store: SqliteControlStore; runtime: WorkflowRuntime; fake: AgentTaskClient; gw: GatewayServer }) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  const fake = taskClientFor(store)
  let runtime: WorkflowRuntime | undefined
  const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowRuntime: () => runtime })
  runtime = new WorkflowRuntime({ store, taskClient: fake, waitWindowMs: 50 })
  const mcp = createMcpServer(new GatewayClient(`http://127.0.0.1:${gw.port}`, TOKEN), '0.2.0')
  try { await fn({ mcp, store, runtime, fake, gw }) } finally { try { await runtime.shutdown() } catch { /* */ } try { await gw.close() } catch { /* */ } try { store.closeSync() } catch { /* */ } }
}
let rpcId = 1
const call = (mcp: McpServer, name: string, args: Record<string, unknown> = {}) => mcp.handle({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } })
const sc = (r: any) => r.result.structuredContent

test('MCP: tools/list exposes the seven task tools plus the fourteen workflow tools', async () => {
  await withMcp((s) => new Fake(s, acceptanceScript), async ({ mcp }) => {
    const list = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const names = ((list as any).result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    assert.equal(names.length, 21)
    for (const n of ['vibe_list_workflows', 'vibe_create_workflow', 'vibe_start_workflow', 'vibe_get_workflow', 'vibe_get_workflow_events', 'vibe_wait_workflow', 'vibe_cancel_workflow', 'vibe_get_pending_request', 'vibe_answer_workflow_input', 'vibe_decide_workflow_approval', 'vibe_resume_workflow', 'vibe_compile_workflow', 'vibe_get_workflow_draft', 'vibe_approve_workflow_draft']) assert.ok(names.includes(n), `has ${n}`)
    for (const n of ['vibe_start_task', 'vibe_run_task', 'vibe_get_task', 'vibe_get_task_events', 'vibe_wait_task', 'vibe_cancel_task', 'vibe_list_agents']) assert.ok(names.includes(n), `retains ${n}`)
  })
})

/** A spec with an input/approval pause gate on its first step, then finish. */
const pauseSpec = (kind: 'input' | 'approval') => ({
  version: '1', name: `pause-${kind}`, entry_step: 'gate', inputs: { objective: { type: 'string', required: true } },
  agents: { solo: { agent: 'mock' } }, output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 5, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 2 },
  steps: [
    { id: 'gate', type: 'agent_task', agent_role: 'solo', prompt_template: 'Do {{ inputs.objective }}', output_schema: 'o', pause_before: { kind, prompt: kind === 'input' ? 'Enter' : 'Approve?' } },
    { id: 'finish', type: 'agent_task', agent_role: 'solo', prompt_template: 'Finish', output_schema: 'o' },
  ],
  edges: [
    { from: 'gate', to: 'finish', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } },
    { from: 'finish', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } },
  ],
  completion_policy: {},
})
const waitWfStatus = async (mcp: any, id: string, want: string[], ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const s = sc(await call(mcp, 'vibe_get_workflow', { workflow_id: id })).status; if (want.includes(s)) return s; await sleep(40) }
  throw new Error(`workflow ${id} did not reach ${want}`)
}

test('MCP input pause: get_pending_request → answer → resume → completes', async () => {
  await withMcp((s) => new Fake(s, () => ({ output: { status: 'done', summary: 'ok' } })), async ({ mcp }) => {
    const id = sc(await call(mcp, 'vibe_create_workflow', { spec: pauseSpec('input'), input_values: { objective: 'x' } })).workflow.workflow_id
    await call(mcp, 'vibe_start_workflow', { workflow_id: id })
    await waitWfStatus(mcp, id, ['waiting_input'])
    const pending = sc(await call(mcp, 'vibe_get_pending_request', { workflow_id: id }))
    assert.equal(pending.request.kind, 'input'); assert.equal(pending.request.status, 'pending')
    const requestId = pending.request.request_id
    const answered = sc(await call(mcp, 'vibe_answer_workflow_input', { workflow_id: id, request_id: requestId, value: 'v' }))
    assert.equal(answered.request.status, 'answered')
    await call(mcp, 'vibe_resume_workflow', { workflow_id: id })
    assert.equal(await waitWfStatus(mcp, id, ['completed']), 'completed')
    // a conflicting answer fails closed (structured error)
    const bad = await call(mcp, 'vibe_answer_workflow_input', { workflow_id: id, request_id: requestId, value: 'other' })
    assert.equal((bad as any).result.isError, true)
  })
})

test('MCP approval pause: reject fails the workflow (structured), approve+resume completes', async () => {
  await withMcp((s) => new Fake(s, () => ({ output: { status: 'done', summary: 'ok' } })), async ({ mcp }) => {
    // reject
    const idR = sc(await call(mcp, 'vibe_create_workflow', { spec: pauseSpec('approval'), input_values: { objective: 'x' } })).workflow.workflow_id
    await call(mcp, 'vibe_start_workflow', { workflow_id: idR })
    await waitWfStatus(mcp, idR, ['waiting_approval'])
    const reqR = sc(await call(mcp, 'vibe_get_pending_request', { workflow_id: idR })).request.request_id
    const rej = sc(await call(mcp, 'vibe_decide_workflow_approval', { workflow_id: idR, request_id: reqR, approved: false }))
    assert.equal(rej.request.status, 'rejected')
    assert.equal(sc(await call(mcp, 'vibe_get_workflow', { workflow_id: idR })).status, 'failed')
    // approve
    const idA = sc(await call(mcp, 'vibe_create_workflow', { spec: pauseSpec('approval'), input_values: { objective: 'x' } })).workflow.workflow_id
    await call(mcp, 'vibe_start_workflow', { workflow_id: idA })
    await waitWfStatus(mcp, idA, ['waiting_approval'])
    const reqA = sc(await call(mcp, 'vibe_get_pending_request', { workflow_id: idA })).request.request_id
    await call(mcp, 'vibe_decide_workflow_approval', { workflow_id: idA, request_id: reqA, approved: true })
    await call(mcp, 'vibe_resume_workflow', { workflow_id: idA })
    assert.equal(await waitWfStatus(mcp, idA, ['completed']), 'completed')
  })
})

/** Workspace-bound spec: a node_id role + workspace_key_template → start requires a lease. */
const workspaceBoundSpec = () => ({
  version: '1', name: 'ws-bound', entry_step: 'solo',
  inputs: { objective: { type: 'string', required: true }, workspace_key: { type: 'string', required: true } },
  agents: { solo: { agent: 'mock', node_id: 'node_x' } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 3, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
  steps: [{ id: 'solo', type: 'agent_task', agent_role: 'solo', prompt_template: 'Do {{ inputs.objective }}', workspace_key_template: '{{ inputs.workspace_key }}', output_schema: 'o' }],
  edges: [{ from: 'solo', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: {},
})

test('MCP: a workspace-bound workflow cannot START without a lease authority (structured workspace_lease_unsupported, stays ready)', async () => {
  // withMcp builds a runtime with NO lease client.
  await withMcp((s) => new Fake(s, acceptanceScript), async ({ mcp, store }) => {
    const created = sc(await call(mcp, 'vibe_create_workflow', { spec: workspaceBoundSpec(), input_values: { objective: 'ship', workspace_key: 'proj' } }))
    assert.equal(created.workflow.status, 'ready') // create is unaffected
    const id = created.workflow.workflow_id
    const started = await call(mcp, 'vibe_start_workflow', { workflow_id: id })
    assert.equal((started as any).result.isError, true, 'start surfaces a structured error')
    assert.equal(sc(started).code, 'workspace_lease_unsupported')
    // durable state: still ready, nothing started (vibe_get_workflow returns the raw snapshot)
    const got = sc(await call(mcp, 'vibe_get_workflow', { workflow_id: id }))
    assert.equal(got.status, 'ready')
    assert.equal((await store.listStepExecutions(id)).length, 0)
  })
})

test('MCP: create persists a ready workflow only; start begins it; get/list project durable state; wait returns on completed', async () => {
  await withMcp((s) => new Fake(s, acceptanceScript), async ({ mcp, store }) => {
    const created = sc(await call(mcp, 'vibe_create_workflow', { spec: plannerExecutorLoopExample(), input_values: { objective: 'x' } }))
    assert.equal(created.workflow.status, 'ready'); assert.equal(created.workflow.total_tasks, 0)
    assert.ok(/not running|not.*start/i.test(created.note))
    const id = created.workflow.workflow_id
    assert.equal((await store.listStepExecutions(id)).length, 0) // create started nothing

    const started = sc(await call(mcp, 'vibe_start_workflow', { workflow_id: id }))
    assert.ok(['running', 'ready'].includes(started.workflow.status))

    const waited = sc(await call(mcp, 'vibe_wait_workflow', { workflow_id: id, wait_seconds: 10 }))
    assert.equal(waited.terminal, true); assert.equal(waited.blocked, false); assert.equal(waited.ended_by, 'terminal')
    assert.equal(waited.workflow.status, 'completed')
    // event cursor: no gap/duplicate across the aggregated wait
    const seqs = waited.events.map((e: any) => e.seq)
    assert.equal(new Set(seqs).size, seqs.length); assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b))

    const got = sc(await call(mcp, 'vibe_get_workflow', { workflow_id: id }))
    assert.equal(got.status, 'completed'); assert.equal(got.total_tasks, 5)
    const listed = sc(await call(mcp, 'vibe_list_workflows', { status: 'completed' }))
    assert.equal(listed.count, 1)
  })
})

test('MCP: get_workflow_events resumes strictly after the cursor with no gap/duplicate', async () => {
  await withMcp((s) => new Fake(s, acceptanceScript), async ({ mcp }) => {
    const created = sc(await call(mcp, 'vibe_create_workflow', { spec: plannerExecutorLoopExample(), input_values: { objective: 'x' } }))
    const id = created.workflow.workflow_id
    await call(mcp, 'vibe_start_workflow', { workflow_id: id })
    // first window from the start
    const first = sc(await call(mcp, 'vibe_get_workflow_events', { workflow_id: id, wait_seconds: 5 }))
    const firstSeqs = first.events.map((e: any) => e.seq)
    // resume from the returned cursor
    let cursor = first.next_event_id
    const all = [...firstSeqs]
    for (let i = 0; i < 10; i++) {
      const r = sc(await call(mcp, 'vibe_get_workflow_events', { workflow_id: id, after_event_id: cursor, wait_seconds: 1 }))
      for (const e of r.events) { assert.ok(e.seq > cursor, 'strictly greater than cursor'); all.push(e.seq) }
      cursor = r.next_event_id
      if (r.terminal) break
    }
    assert.equal(new Set(all).size, all.length, 'no duplicate across resume boundaries')
  })
})

test('MCP: wait returns blocked=true terminal=false on a blocked workflow', async () => {
  await withMcp((s) => new Fake(s, () => ({ output: { status: 'blocked', summary: 'need input' } })), async ({ mcp }) => {
    const created = sc(await call(mcp, 'vibe_create_workflow', { spec: plannerExecutorLoopExample(), input_values: { objective: 'x' } }))
    const id = created.workflow.workflow_id
    await call(mcp, 'vibe_start_workflow', { workflow_id: id })
    const w = sc(await call(mcp, 'vibe_wait_workflow', { workflow_id: id, wait_seconds: 10 }))
    assert.equal(w.terminal, false); assert.equal(w.blocked, true); assert.equal(w.ended_by, 'blocked')
    assert.equal(w.workflow.status, 'blocked')
  })
})

test('MCP: wait returns terminal on a failed workflow', async () => {
  await withMcp((s) => new Fake(s, () => ({ status: 'failed' })), async ({ mcp }) => {
    const created = sc(await call(mcp, 'vibe_create_workflow', { spec: plannerExecutorLoopExample(), input_values: { objective: 'x' } }))
    const id = created.workflow.workflow_id
    await call(mcp, 'vibe_start_workflow', { workflow_id: id })
    const w = sc(await call(mcp, 'vibe_wait_workflow', { workflow_id: id, wait_seconds: 10 }))
    assert.equal(w.terminal, true); assert.equal(w.workflow.status, 'failed')
  })
})

test('MCP: wait timeout leaves the workflow running and never cancels; explicit cancel is idempotent', async () => {
  await withMcp((s) => new Fake(s, (r) => { const d = acceptanceScript(r); if ((r.metadata as any).step_id === 'plan') return { ...d, running: true }; return d }), async ({ mcp, store, fake }) => {
    const created = sc(await call(mcp, 'vibe_create_workflow', { spec: plannerExecutorLoopExample(), input_values: { objective: 'x' } }))
    const id = created.workflow.workflow_id
    await call(mcp, 'vibe_start_workflow', { workflow_id: id })
    // wait a short budget → times out while the plan task runs
    const w = sc(await call(mcp, 'vibe_wait_workflow', { workflow_id: id, wait_seconds: 0.5 }))
    assert.equal(w.terminal, false); assert.equal(w.blocked, false); assert.equal(w.ended_by, 'timeout')
    assert.ok(w.resume?.arguments?.workflow_id === id, 'offers a resume cursor')
    // timeout did NOT cancel
    assert.equal((await store.getWorkflow(id))!.status, 'running')
    assert.equal((fake as Fake).cancels.length, 0)
    // explicit cancel is idempotent
    const c1 = sc(await call(mcp, 'vibe_cancel_workflow', { workflow_id: id })); assert.equal(c1.status, 'cancelled')
    const c2 = sc(await call(mcp, 'vibe_cancel_workflow', { workflow_id: id })); assert.equal(c2.status, 'cancelled')
    assert.ok((fake as Fake).cancels.length >= 1)
  })
})

test('MCP: create rejects a malformed spec/inputs with a structured error (no crash)', async () => {
  await withMcp((s) => new Fake(s, acceptanceScript), async ({ mcp }) => {
    const bad = await call(mcp, 'vibe_create_workflow', { spec: { version: '1', name: 'x' } })
    assert.equal((bad as any).result.isError, true)
    assert.equal(sc(bad).code, 'invalid_workflow_spec')
    const badArg = await call(mcp, 'vibe_create_workflow', { spec: 'not-an-object' })
    assert.equal((badArg as any).result.isError, true)
  })
})
