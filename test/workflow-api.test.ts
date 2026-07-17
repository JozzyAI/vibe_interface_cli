/**
 * Workflow REST API — lifecycle, SSE, restart recovery, and a deterministic
 * planner/executor acceptance. The REST server + WorkflowRuntime + ControlStore
 * are REAL (in-process gateway on a temporary DB); the Agent-Task backend is a
 * deterministic fake that faithfully persists the durable task row the Gateway
 * would. A separate test drives a single-step workflow through the REAL Gateway
 * task path with the mock backend. Never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { GatewayClient } from '../src/mcp/gateway-client.js'
import { GatewayAgentTaskClient, type AgentTaskClient, type AgentTaskCreateRequest } from '../src/workflow/task-client.js'
import { plannerExecutorLoopExample } from '../src/workflow/examples.js'
import { WorkflowCompiler } from '../src/workflow/compiler/compiler.js'
import type { WorkflowSpec } from '../src/workflow/contract.js'

const TOKEN = `wfapi-${Math.random().toString(36).slice(2)}`
const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wfapi-')), 'control.sqlite')

interface TaskDesc { output?: Record<string, unknown>; status?: string; history_complete?: boolean; running?: boolean }
class ScriptedFake implements AgentTaskClient {
  byKey = new Map<string, any>(); byId = new Map<string, any>(); creates: AgentTaskCreateRequest[] = []; cancels: string[] = []; n = 0
  constructor(public store: SqliteControlStore, private script: (r: AgentTaskCreateRequest) => TaskDesc) {}
  releaseAll(): void { for (const t of this.byId.values()) t.released = true }
  async createTask(req: AgentTaskCreateRequest) {
    this.creates.push(req)
    const ex = this.byKey.get(req.idempotency_key); if (ex) return { task_id: ex.task_id }
    const d = this.script(req); const task_id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id, agent: req.agent, node_id: req.node_id ?? null, status: 'queued', idempotency_key: req.idempotency_key, request_fingerprint: 'fp:' + req.idempotency_key }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    const t = { task_id, req, ...d, released: !d.running, key: req.idempotency_key }; this.byKey.set(req.idempotency_key, t); this.byId.set(task_id, t); return { task_id }
  }
  private view(t: any) {
    const running = t.running && !t.released; const status = running ? 'running' : (t.status ?? 'completed')
    const terminal = !running && ['completed', 'failed', 'cancelled'].includes(status)
    // Misleading event text ≠ the first-class result — the runtime routes on result_text.
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
  if (step_id === 'implement' && round === 1) return { output: { status: 'implemented', summary: 'Part A complete', changed_files: ['a.ts'], tests_run: ['t1'], remaining_work: [], risks: [] } }
  if (step_id === 'review' && round === 1) return { output: { status: 'continue', summary: 'partial', next_step: 'Implement part B' } }
  if (step_id === 'implement' && round === 2) return { output: { status: 'implemented', summary: 'Part B complete', changed_files: ['b.ts'], tests_run: ['t2'], remaining_work: [], risks: [] } }
  return { output: { status: 'complete', summary: 'done' } }
}

interface Res { status: number; body: any; headers: http.IncomingHttpHeaders }
function req(port: number, method: string, p: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }; if (payload) headers['content-type'] = 'application/json'
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => { let b: any = null; try { b = JSON.parse(t) } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }) }) })
    r.on('error', reject); if (payload) r.write(payload); r.end()
  })
}
/** Collect SSE workflow event frames for `ms` (id + type per frame). */
function sse(port: number, id: string, lastEventId: string | undefined, ms: number): Promise<Array<{ seq: number; type: string }>> {
  return new Promise((resolve) => {
    const out: Array<{ seq: number; type: string }> = []; let buf = ''
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }; if (lastEventId !== undefined) headers['last-event-id'] = lastEventId
    const r = http.request({ host: '127.0.0.1', port, path: `/v1/workflows/${id}/events`, headers }, (res) => {
      res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) !== -1) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^id: (\d+)$/m.exec(f); const t = /^event: (.+)$/m.exec(f); if (m && t) out.push({ seq: Number(m[1]), type: t[1] }) } })
    })
    r.end(); setTimeout(() => { try { r.destroy() } catch { /* */ } resolve(out) }, ms)
  })
}
async function waitStatus(port: number, id: string, want: string[], ms = 12000): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) { const r = await req(port, 'GET', `/v1/workflows/${id}`); if (want.includes(r.body?.status)) return r.body; await sleep(80) }
  throw new Error(`workflow ${id} did not reach ${want}`)
}

async function withGw(taskClientFor: (store: SqliteControlStore) => AgentTaskClient, fn: (ctx: { gw: GatewayServer; store: SqliteControlStore; runtime: WorkflowRuntime; fake: AgentTaskClient }) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  const fake = taskClientFor(store)
  let runtime: WorkflowRuntime | undefined
  const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowRuntime: () => runtime })
  runtime = new WorkflowRuntime({ store, taskClient: fake })
  try { await fn({ gw, store, runtime, fake }) } finally { try { await runtime.shutdown() } catch { /* */ } try { await gw.close() } catch { /* */ } try { store.closeSync() } catch { /* */ } }
}

/** A spec with an input/approval pause gate on its first step, then finish. */
const pauseSpec = (kind: 'input' | 'approval'): WorkflowSpec => ({
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

const soloSpec = (): WorkflowSpec => ({
  version: '1', name: 'single', entry_step: 'solo', inputs: { objective: { type: 'string', required: true } },
  agents: { solo: { agent: 'mock' } }, output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 3, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
  steps: [{ id: 'solo', type: 'agent_task', agent_role: 'solo', prompt_template: 'Do {{ inputs.objective }}', output_schema: 'o' }],
  edges: [{ from: 'solo', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: {},
})

/** A workspace-bound spec: the step declares a node_id role + workspace_key_template,
 *  so starting it REQUIRES a workspace lease authority. */
const workspaceBoundSpec = (): WorkflowSpec => ({
  version: '1', name: 'ws-bound', entry_step: 'solo',
  inputs: { objective: { type: 'string', required: true }, workspace_key: { type: 'string', required: true } },
  agents: { solo: { agent: 'mock', node_id: 'node_x' } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 3, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
  steps: [{ id: 'solo', type: 'agent_task', agent_role: 'solo', prompt_template: 'Do {{ inputs.objective }}', workspace_key_template: '{{ inputs.workspace_key }}', output_schema: 'o' }],
  edges: [{ from: 'solo', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: {},
})

// ── REST human pause / approval ──────────────────────────────────────────────────

test('REST input pause: pending-request → answer (idempotent + conflict) → resume → completes', async () => {
  await withGw((s) => new ScriptedFake(s, () => ({ output: { status: 'done', summary: 'ok' } })), async ({ gw, store }) => {
    const created = await req(gw.port, 'POST', '/v1/workflows', { spec: pauseSpec('input'), input_values: { objective: 'ship' } })
    const id = created.body.workflow_id
    await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    await waitStatus(gw.port, id, ['waiting_input'])
    // pending-request
    const pr = await req(gw.port, 'GET', `/v1/workflows/${id}/pending-request`)
    assert.equal(pr.status, 200); assert.equal(pr.body.request.kind, 'input'); assert.equal(pr.body.request.status, 'pending')
    const requestId = pr.body.request.request_id
    // snapshot exposes no task yet
    assert.equal((await req(gw.port, 'GET', `/v1/workflows/${id}`)).body.total_tasks, 0)
    // answer (idempotent) + conflict
    assert.equal((await req(gw.port, 'POST', `/v1/workflows/${id}/answer`, { request_id: requestId, value: 'v1' })).status, 200)
    assert.equal((await req(gw.port, 'POST', `/v1/workflows/${id}/answer`, { request_id: requestId, value: 'v1' })).status, 200)
    const conflict = await req(gw.port, 'POST', `/v1/workflows/${id}/answer`, { request_id: requestId, value: 'v2' })
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'workflow_state_conflict')
    // request not found (wrong id) → 404
    assert.equal((await req(gw.port, 'POST', `/v1/workflows/${id}/answer`, { request_id: 'hr_' + '0'.repeat(32), value: 'x' })).status, 404)
    // resume → completes
    const resumed = await req(gw.port, 'POST', `/v1/workflows/${id}/resume`)
    assert.equal(resumed.status, 200)
    const done = await waitStatus(gw.port, id, ['completed'])
    assert.equal(done.status, 'completed'); assert.equal(done.total_tasks, 2)
  })
})

test('REST approval pause: approve → resume → completes; reject → failed', async () => {
  await withGw((s) => new ScriptedFake(s, () => ({ output: { status: 'done', summary: 'ok' } })), async ({ gw }) => {
    // approve path
    const a = await req(gw.port, 'POST', '/v1/workflows', { spec: pauseSpec('approval'), input_values: { objective: 'x' } })
    const idA = a.body.workflow_id
    await req(gw.port, 'POST', `/v1/workflows/${idA}/start`)
    await waitStatus(gw.port, idA, ['waiting_approval'])
    const reqA = (await req(gw.port, 'GET', `/v1/workflows/${idA}/pending-request`)).body.request.request_id
    assert.equal((await req(gw.port, 'POST', `/v1/workflows/${idA}/decision`, { request_id: reqA, approved: true })).status, 200)
    await req(gw.port, 'POST', `/v1/workflows/${idA}/resume`)
    assert.equal((await waitStatus(gw.port, idA, ['completed'])).status, 'completed')
    // reject path
    const b = await req(gw.port, 'POST', '/v1/workflows', { spec: pauseSpec('approval'), input_values: { objective: 'x' } })
    const idB = b.body.workflow_id
    await req(gw.port, 'POST', `/v1/workflows/${idB}/start`)
    await waitStatus(gw.port, idB, ['waiting_approval'])
    const reqB = (await req(gw.port, 'GET', `/v1/workflows/${idB}/pending-request`)).body.request.request_id
    const rej = await req(gw.port, 'POST', `/v1/workflows/${idB}/decision`, { request_id: reqB, approved: false })
    assert.equal(rej.status, 200); assert.equal(rej.body.status, 'rejected')
    assert.equal((await req(gw.port, 'GET', `/v1/workflows/${idB}`)).body.status, 'failed')
  })
})

// ── REST lifecycle ─────────────────────────────────────────────────────────────

test('REST: a workspace-bound workflow FAILS CLOSED at start without a lease authority (422, stays ready, no task)', async () => {
  // withGw builds a runtime with NO lease client → workspace-bound start must be refused.
  await withGw((s) => new ScriptedFake(s, () => ({ output: { status: 'done', summary: 'ok' } })), async ({ gw, store }) => {
    const created = await req(gw.port, 'POST', '/v1/workflows', { spec: workspaceBoundSpec(), input_values: { objective: 'ship', workspace_key: 'proj' } })
    assert.equal(created.status, 201); assert.equal(created.body.status, 'ready') // create is unaffected
    const id = created.body.workflow_id
    const started = await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    assert.equal(started.status, 422, 'start is refused')
    assert.equal(started.body.code, 'workspace_lease_unsupported')
    const got = await req(gw.port, 'GET', `/v1/workflows/${id}`)
    assert.equal(got.body.status, 'ready', 'workflow stays ready')
    assert.equal(got.body.total_tasks, 0)
    assert.equal((await store.listStepExecutions(id)).length, 0, 'no step/task started')
  })
})

test('REST: create returns ready and starts no task; start transitions to running; get/list/cancel; 404/400/conflict', async () => {
  await withGw((s) => new ScriptedFake(s, () => ({ output: { status: 'done', summary: 'ok' }, running: true })), async ({ gw, store }) => {
    // create → ready, no task
    const created = await req(gw.port, 'POST', '/v1/workflows', { spec: soloSpec(), input_values: { objective: 'ship' } })
    assert.equal(created.status, 201); assert.equal(created.body.status, 'ready'); assert.equal(created.body.total_tasks, 0)
    const id = created.body.workflow_id; assert.ok(id)
    assert.deepEqual(created.body.input_values, { objective: 'ship' })
    // get durable snapshot
    const got = await req(gw.port, 'GET', `/v1/workflows/${id}`)
    assert.equal(got.status, 200); assert.equal(got.body.status, 'ready'); assert.ok(got.body.spec)
    // list (bounded, filtered)
    const list = await req(gw.port, 'GET', '/v1/workflows?status=ready&limit=10')
    assert.equal(list.status, 200); assert.equal(list.body.count, 1); assert.equal(list.body.workflows[0].workflow_id, id)
    // start → running
    const started = await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    assert.equal(started.status, 200); assert.ok(['running', 'ready'].includes(started.body.status))
    await waitStatus(gw.port, id, ['running'])
    // repeated start coalesces (still one running task; no duplicate)
    await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    await sleep(100)
    assert.equal((await store.listStepExecutions(id)).length, 1)
    // cancel idempotent
    const c1 = await req(gw.port, 'POST', `/v1/workflows/${id}/cancel`); assert.equal(c1.status, 200); assert.equal(c1.body.status, 'cancelled')
    const c2 = await req(gw.port, 'POST', `/v1/workflows/${id}/cancel`); assert.equal(c2.body.status, 'cancelled')
    // terminal start does not restart
    const startAfter = await req(gw.port, 'POST', `/v1/workflows/${id}/start`); assert.equal(startAfter.body.status, 'cancelled')
    // 404 unknown
    assert.equal((await req(gw.port, 'GET', '/v1/workflows/wf_missing')).status, 404)
    assert.equal((await req(gw.port, 'POST', '/v1/workflows/wf_missing/start')).status, 404)
    // 400 invalid spec + invalid inputs
    const badSpec = await req(gw.port, 'POST', '/v1/workflows', { spec: { version: '1', name: 'x' } })
    assert.equal(badSpec.status, 400); assert.equal(badSpec.body.code, 'invalid_workflow_spec'); assert.ok(Array.isArray(badSpec.body.details.issues))
    const badIn = await req(gw.port, 'POST', '/v1/workflows', { spec: soloSpec(), input_values: { objective: 5 } })
    assert.equal(badIn.status, 400); assert.equal(badIn.body.code, 'invalid_workflow_inputs')
  })
})

test('REST: a blocked workflow returns a 409 state conflict on start (no silent resume)', async () => {
  await withGw((s) => new ScriptedFake(s, () => ({ output: { status: 'blocked', summary: 'need input' } })), async ({ gw }) => {
    const created = await req(gw.port, 'POST', '/v1/workflows', { spec: plannerExecutorLoopExample(), input_values: { objective: 'x' } })
    const id = created.body.workflow_id
    await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    await waitStatus(gw.port, id, ['blocked'])
    const restart = await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    assert.equal(restart.status, 409); assert.equal(restart.body.code, 'workflow_state_conflict')
  })
})

// ── deterministic planner/executor acceptance over REST ────────────────────────

test('REST acceptance: planner→executor→review loop completes with one round; SSE cursor has no gap/duplicate; terminal once', async () => {
  await withGw((s) => new ScriptedFake(s, acceptanceScript), async ({ gw, store }) => {
    const created = await req(gw.port, 'POST', '/v1/workflows', { spec: plannerExecutorLoopExample(), input_values: { objective: 'Build a thing' } })
    assert.equal(created.status, 201); assert.equal(created.body.status, 'ready')
    const id = created.body.workflow_id
    // SSE from cursor -1 while running → replay + live, then closes on terminal.
    const framesP = sse(gw.port, id, undefined, 9000)
    await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    const done = await waitStatus(gw.port, id, ['completed', 'failed'])
    assert.equal(done.status, 'completed')
    assert.equal(done.current_round, 2)
    assert.equal(done.total_tasks, 5)
    assert.equal(done.step_executions.length, 5)
    // context handoff across rounds
    assert.equal(done.context.latest_planner_decision.status, 'complete')
    assert.equal(done.context.latest_executor_handoff.status, 'implemented')

    const frames = await framesP
    const seqs = frames.map((f) => f.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'events in ascending order')
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicate event at replay/live boundary')
    // contiguous from 0 (initial cursor -1 replays from event 0)
    assert.equal(seqs[0], 0)
    assert.equal(seqs.filter((_, i) => i > 0 && seqs[i] !== seqs[i - 1] + 1).length, 0, 'contiguous sequences')
    assert.equal(frames.filter((f) => f.type === 'workflow.completed').length, 1, 'terminal workflow event exactly once')
    assert.equal(frames.filter((f) => f.type === 'workflow.round_advanced').length, 1)

    // Last-Event-ID returns strictly greater events (no re-delivery)
    const cutoff = 3
    const resume = await sse(gw.port, id, String(cutoff), 1500)
    assert.ok(resume.every((f) => f.seq > cutoff), 'resume replays strictly after the cursor')
  })
})

// ── restart / recovery ─────────────────────────────────────────────────────────

test('REST restart acceptance: API restart mid-run recovers the same workflow/task identities without duplication', async () => {
  const dbPath = tmpDb()
  let store = openControlStore({ path: dbPath })
  let planReleased = false
  const fake = new ScriptedFake(store, (req) => { const d = acceptanceScript(req); if ((req.metadata as any).step_id === 'plan' && !planReleased) return { ...d, running: true }; return d })
  let runtime: WorkflowRuntime | undefined
  let gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowRuntime: () => runtime })
  runtime = new WorkflowRuntime({ store, taskClient: fake, waitWindowMs: 30 })

  const created = await req(gw.port, 'POST', '/v1/workflows', { spec: plannerExecutorLoopExample(), input_values: { objective: 'x' } })
  const id = created.body.workflow_id
  await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
  for (let i = 0; i < 60 && fake.n < 1; i++) await sleep(20) // plan task bound + running
  const planTaskId = (await store.getStepExecutionByKey(id, 'plan', 1, 1))!.task_id
  assert.ok(planTaskId)

  // "restart" the API process: shut down runtime + gateway, reopen the same DB.
  await runtime.shutdown(); await gw.close(); store.closeSync()
  planReleased = true; fake.releaseAll()
  store = openControlStore({ path: dbPath }); fake.store = store
  runtime = undefined
  gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowRuntime: () => runtime })
  runtime = new WorkflowRuntime({ store, taskClient: fake })
  await runtime.recoverWorkflows()

  const done = await waitStatus(gw.port, id, ['completed', 'failed'])
  assert.equal(done.status, 'completed')
  assert.equal(done.total_tasks, 5)
  assert.equal((await store.getStepExecutionByKey(id, 'plan', 1, 1))!.task_id, planTaskId) // same task after restart
  assert.equal(new Set((await store.listStepExecutions(id)).map((s) => s.task_id)).size, 5) // no duplicate tasks
  // completed workflow remains queryable
  assert.equal((await req(gw.port, 'GET', `/v1/workflows/${id}`)).body.status, 'completed')
  await runtime.shutdown(); await gw.close(); store.closeSync()
})

// ── SSE disconnect never cancels ───────────────────────────────────────────────

test('REST: a workflow SSE client disconnect never cancels the workflow', async () => {
  await withGw((s) => new ScriptedFake(s, (r) => { const d = acceptanceScript(r); if ((r.metadata as any).step_id === 'plan') return { ...d, running: true }; return d }), async ({ gw, store }) => {
    const created = await req(gw.port, 'POST', '/v1/workflows', { spec: plannerExecutorLoopExample(), input_values: { objective: 'x' } })
    const id = created.body.workflow_id
    await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    await waitStatus(gw.port, id, ['running'])
    await sse(gw.port, id, undefined, 300) // open + drop the SSE
    await sleep(200)
    const after = await req(gw.port, 'GET', `/v1/workflows/${id}`)
    assert.equal(after.body.status, 'running', 'disconnect did not cancel the workflow')
    assert.equal(after.body.cancel_requested, false)
  })
})

// ── security ───────────────────────────────────────────────────────────────────

test('REST security: the API token / secrets never appear in workflow rows or events; malformed requests do not leak internals', async () => {
  await withGw((s) => new ScriptedFake(s, acceptanceScript), async ({ gw, store }) => {
    const created = await req(gw.port, 'POST', '/v1/workflows', { spec: plannerExecutorLoopExample(), input_values: { objective: 'SECRET-OBJECTIVE' } })
    const id = created.body.workflow_id
    await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    await waitStatus(gw.port, id, ['completed'])
    // the API token is never persisted in any workflow event payload
    const evs = JSON.stringify(await store.listWorkflowEvents(id))
    assert.ok(!evs.includes(TOKEN))
    // a malformed create body returns a structured 400 without SQL/stack/DB path
    const bad = await req(gw.port, 'POST', '/v1/workflows', { spec: [] })
    assert.equal(bad.status, 400)
    const blob = JSON.stringify(bad.body)
    assert.ok(!/select |insert |sqlite|\.sqlite|at Object\.|node:internal/i.test(blob), 'no SQL/stack/DB path leak')
  })
})

// ── real Gateway boundary (single-step through the mock backend) ────────────────

test('REST real-Gateway acceptance: a single-step workflow runs through the real Gateway task path + mock backend to completed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfapi-real-'))
  process.env.VIBE_DIR = path.join(root, 'vibe'); fs.mkdirSync(process.env.VIBE_DIR, { recursive: true })
  process.env.VIBE_MOCK_OUTPUT = JSON.stringify({ status: 'done', summary: 'mock did it' })
  const store = openControlStore({ path: path.join(root, 'control.sqlite') })
  let runtime: WorkflowRuntime | undefined
  const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowRuntime: () => runtime })
  runtime = new WorkflowRuntime({ store, taskClient: new GatewayAgentTaskClient(new GatewayClient(`http://127.0.0.1:${gw.port}`, TOKEN)) })
  try {
    const created = await req(gw.port, 'POST', '/v1/workflows', { spec: soloSpec(), input_values: { objective: 'ship' } })
    assert.equal(created.status, 201); assert.equal(created.body.status, 'ready')
    const id = created.body.workflow_id
    await req(gw.port, 'POST', `/v1/workflows/${id}/start`)
    const done = await waitStatus(gw.port, id, ['completed', 'failed'], 15000)
    assert.equal(done.status, 'completed')
    assert.equal(done.total_tasks, 1)
    assert.deepEqual(done.step_executions[0].output, { status: 'done', summary: 'mock did it' })
    // the runtime used the step_execution_id as the Gateway idempotency_key
    const sec = done.step_executions[0].step_execution_id
    assert.equal(store.getTaskByIdempotencyKey(sec)?.task_id, done.step_executions[0].task_id)
  } finally {
    delete process.env.VIBE_MOCK_OUTPUT
    try { await runtime.shutdown() } catch { /* */ } try { await gw.close() } catch { /* */ } try { store.closeSync() } catch { /* */ }
  }
})

// ── REST compiler (compile → get → approve → start) ──────────────────────────────

test('REST compiler: compile → draft → approve by exact spec_hash creates a ready workflow (not started); start begins it; wrong hash conflicts', async () => {
  const store = openControlStore({ path: tmpDb() })
  let runtime: WorkflowRuntime | undefined
  // a fake compiler model returning a valid ready spec; a fake inventory with claude on node_x
  const readySpec = {
    version: '1', name: 'compiled', entry_step: 'go', inputs: { objective: { type: 'string', required: true } },
    agents: { only: { agent: 'mock', node_id: 'node_x' } },
    output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
    limits: { max_tasks: 2, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
    steps: [{ id: 'go', type: 'agent_task', agent_role: 'only', prompt_template: 'Do {{ inputs.objective }}', output_schema: 'o' }],
    edges: [{ from: 'go', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
    completion_policy: {},
  }
  const model = { compile: async () => ({ task_id: 'ct_1', status: 'available' as const, output_text: JSON.stringify({ schema_version: '1', status: 'ready', workflow_spec: readySpec, input_values: { objective: 'ship' }, rationale: {}, questions: [], warnings: [] }) }) }
  const inventory = { snapshot: async () => ({ observed_at: '2026-01-01T00:00:00Z', agents: [{ agent: 'mock', permission_modes: ['default'], workspace_supported: false, capabilities: ['run'] }, { agent: 'mock', node_id: 'node_x', permission_modes: ['default'], workspace_supported: true, capabilities: ['run', 'workspace'] }] }) }
  const compiler = new WorkflowCompiler({ store, model, inventory })
  const gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store, controlStore: store, getWorkflowRuntime: () => runtime, getWorkflowCompiler: () => compiler })
  runtime = new WorkflowRuntime({ store, taskClient: new ScriptedFake(store, () => ({ output: { status: 'done', summary: 'ok' } })), waitWindowMs: 20 })
  try {
    // compile
    const c = await req(gw.port, 'POST', '/v1/workflow-drafts/compile', { nl_request: 'build a thing', compiler_agent: 'mock' })
    assert.equal(c.status, 201); assert.equal(c.body.compiler_status, 'ready'); assert.equal(c.body.validation_status, 'valid')
    const draftId = c.body.draft_id; const specHash = c.body.spec_hash
    assert.ok(draftId && specHash); assert.ok(c.body.preview && c.body.policy_summary)
    // get
    const g = await req(gw.port, 'GET', `/v1/workflow-drafts/${draftId}`)
    assert.equal(g.status, 200); assert.equal(g.body.spec_hash, specHash)
    // approve with wrong hash → 409
    const bad = await req(gw.port, 'POST', `/v1/workflow-drafts/${draftId}/approve`, { spec_hash: 'nope' })
    assert.equal(bad.status, 409); assert.equal(bad.body.code, 'approval_hash_conflict')
    // approve with exact hash → a ready workflow (NOT started)
    const a = await req(gw.port, 'POST', `/v1/workflow-drafts/${draftId}/approve`, { spec_hash: specHash })
    assert.equal(a.status, 200); const wfId = a.body.workflow_id; assert.ok(wfId)
    assert.equal((await req(gw.port, 'GET', `/v1/workflows/${wfId}`)).body.status, 'ready', 'approve does not start')
    // starting still requires the explicit start action
    const started = await req(gw.port, 'POST', `/v1/workflows/${wfId}/start`)
    assert.ok(['running', 'ready'].includes(started.body.status))
  } finally { try { await runtime.shutdown() } catch { /* */ } try { await gw.close() } catch { /* */ } try { store.closeSync() } catch { /* */ } }
})
