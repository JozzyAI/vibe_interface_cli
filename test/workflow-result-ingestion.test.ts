/**
 * Result-ingestion race: a terminal Agent Task can beat its own durable AgentTaskResult
 * by a moment (esp. remote). The runtime must reconcile a PENDING result over a bounded,
 * durable window instead of blocking `task_result_missing` — while still handling a
 * DEFINITIVELY missing/invalid result immediately, and blocking `task_result_timeout`
 * only after a durable deadline.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { stepExecutionId } from '../src/workflow/recovery.js'
import type { AgentTaskClient, AgentTaskCreateRequest } from '../src/workflow/task-client.js'

const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ingest-')), 'control.sqlite')

/** Fake whose terminal task returns `pending` for the first N reads, then the eventual
 *  result_status — simulating a not-yet-ingested durable result. */
class ResultRaceFake implements AgentTaskClient {
  byKey = new Map<string, string>(); n = 0; reads = 0
  pendingReads = 0
  stayPending = false
  eventual: 'available' | 'missing' | 'invalid' = 'available'
  taskStatus: 'completed' | 'failed' | 'cancelled' = 'completed'
  text = '{"status":"done","summary":"ok"}'
  constructor(public store: SqliteControlStore) {}
  async createTask(r: AgentTaskCreateRequest) {
    const ex = this.byKey.get(r.idempotency_key); if (ex) return { task_id: ex }
    const id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id: id, agent: r.agent, node_id: r.node_id ?? null, status: 'queued', idempotency_key: r.idempotency_key, request_fingerprint: 'fp' }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    this.byKey.set(r.idempotency_key, id); return { task_id: id }
  }
  async getTask(id: string) { return { task_id: id, status: this.taskStatus, terminal: true, history_complete: true } }
  async waitForTerminal(id: string) {
    this.reads++
    if (this.taskStatus !== 'completed') return { task_id: id, status: this.taskStatus, terminal: true, history_complete: true, events: [], next_event_id: -1 }
    const pending = this.stayPending || this.reads <= this.pendingReads
    const rs = pending ? 'pending' : this.eventual
    return { task_id: id, status: 'completed', terminal: true, history_complete: true, result_status: rs, result_text: (!pending && this.eventual === 'available') ? this.text : undefined, events: [], next_event_id: -1 }
  }
  async cancelTask() { /* */ }
}

const spec = () => ({
  version: '1', name: 'ingest', entry_step: 'go', inputs: {},
  agents: { solo: { agent: 'mock' } }, // no node_id → no lease → simpler
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 3, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 2 },
  steps: [{ id: 'go', type: 'agent_task', agent_role: 'solo', prompt_template: 'do', output_schema: 'o' }],
  edges: [{ from: 'go', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: {},
})

const events = async (s: SqliteControlStore, wf: string) => (await s.listWorkflowEvents(wf))
const count = (evs: { event_type: string }[], t: string) => evs.filter((e) => e.event_type === t).length
const stepOf = (s: SqliteControlStore, wf: string) => s.getStepExecution(stepExecutionId(wf, 'go', 1, 1))
const waitFor = async (fn: () => Promise<boolean>, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(8) } throw new Error('timeout') }

async function withRt(fake: (s: SqliteControlStore) => ResultRaceFake, opts: Record<string, unknown>, fn: (ctx: { store: SqliteControlStore; f: ResultRaceFake; rt: WorkflowRuntime; mkRt: () => WorkflowRuntime; wf: () => Promise<string> }) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  const f = fake(store)
  const rts: WorkflowRuntime[] = []
  const mkRt = () => { const rt = new WorkflowRuntime({ store, taskClient: f, waitWindowMs: 20, backoffBaseMs: 4, backoffMaxMs: 12, ...opts }); rts.push(rt); return rt }
  const rt = mkRt()
  const wf = async () => (await rt.createWorkflow(spec(), {})).workflow_id
  try { await fn({ store, f, rt, mkRt, wf }) } finally { for (const r of rts) { try { await r.shutdown() } catch { /* */ } } try { store.closeSync() } catch { /* */ } }
}

// ── race resolves: pending reads then available → completes ONCE (duplicate-safe) ─
test('terminal task, result ingests shortly after → workflow reconciles and continues exactly once', async () => {
  await withRt((s) => { const f = new ResultRaceFake(s); f.pendingReads = 3; return f }, {}, async ({ store, rt, wf }) => {
    const id = await wf()
    await rt.startWorkflow(id)
    await waitFor(async () => (await store.getWorkflow(id))!.status === 'completed')
    const evs = await events(store, id)
    assert.equal(count(evs, 'workflow.started'), 1)          // started exactly once
    assert.equal(count(evs, 'step.completed'), 1)            // routed exactly once
    assert.equal(count(evs, 'workflow.completed'), 1)
    assert.equal(count(evs, 'workflow.blocked'), 0)          // never blocked on the race
    assert.equal((await store.getWorkflow(id))!.total_tasks, 1) // one task
  })
})

// ── already available → no reconciliation, no wait marker set ──────────────────
test('result already available → routes immediately, no result_awaited_since marker', async () => {
  await withRt((s) => { const f = new ResultRaceFake(s); f.pendingReads = 0; return f }, {}, async ({ store, rt, wf }) => {
    const id = await wf()
    await rt.startWorkflow(id)
    await waitFor(async () => (await store.getWorkflow(id))!.status === 'completed')
    assert.equal((await stepOf(store, id))!.result_awaited_since, null) // never entered the wait window
  })
})

// ── Gateway restart during the wait → recovery resumes reconciliation ONCE ─────
test('Gateway restart while awaiting result → recovery continues once, no duplicate transition', async () => {
  await withRt((s) => { const f = new ResultRaceFake(s); f.stayPending = true; return f }, { resultIngestionDeadlineMs: 60_000 }, async ({ store, f, rt, mkRt, wf }) => {
    const id = await wf()
    await rt.startWorkflow(id)
    // wait until the durable wait marker is set (runtime is mid-reconcile), then "crash"
    await waitFor(async () => (await stepOf(store, id))?.result_awaited_since != null)
    const since = (await stepOf(store, id))!.result_awaited_since
    await rt.shutdown()
    assert.equal((await store.getWorkflow(id))!.status, 'running') // still running, not blocked
    // the result ingests; a FRESH runtime recovers and continues
    f.stayPending = false
    const rt2 = mkRt()
    await rt2.recoverWorkflows()
    await waitFor(async () => (await store.getWorkflow(id))!.status === 'completed')
    const evs = await events(store, id)
    assert.equal(count(evs, 'workflow.started'), 1)   // still exactly once across restart
    assert.equal(count(evs, 'step.completed'), 1)
    assert.equal(count(evs, 'workflow.completed'), 1)
    assert.equal((await store.getWorkflow(id))!.total_tasks, 1) // no duplicate task
    assert.equal((await stepOf(store, id))!.result_awaited_since, since) // durable marker preserved across restart
  })
})

// ── never ingests → bounded durable timeout with a distinct visible reason ─────
test('result never ingests → blocks task_result_timeout past the durable deadline (not task_result_missing)', async () => {
  await withRt((s) => { const f = new ResultRaceFake(s); f.stayPending = true; return f }, { resultIngestionDeadlineMs: 40 }, async ({ store, rt, wf }) => {
    const id = await wf()
    await rt.startWorkflow(id)
    await waitFor(async () => (await store.getWorkflow(id))!.status === 'blocked', 4000)
    const evs = await events(store, id)
    const blocked = evs.find((e) => e.event_type === 'workflow.blocked')!
    assert.equal((blocked.payload as { reason?: string }).reason, 'task_result_timeout') // distinct, visible reason
    assert.equal(count(evs, 'workflow.blocked'), 1)
    assert.notEqual((await stepOf(store, id))!.result_awaited_since, null) // the wait window is durable/visible
  })
})

// ── definitive missing/invalid still terminate immediately (no reconcile delay) ─
test('definitively missing result → blocks task_result_missing immediately (preserved)', async () => {
  await withRt((s) => { const f = new ResultRaceFake(s); f.pendingReads = 0; f.eventual = 'missing'; return f }, {}, async ({ store, rt, wf }) => {
    const id = await wf()
    await rt.startWorkflow(id)
    await waitFor(async () => (await store.getWorkflow(id))!.status === 'blocked')
    const evs = await events(store, id)
    assert.equal((evs.find((e) => e.event_type === 'workflow.blocked')!.payload as { reason?: string }).reason, 'task_result_missing')
    assert.equal((await stepOf(store, id))!.result_awaited_since, null) // never entered the race window
  })
})

test('definitively invalid result → fails task_result_invalid immediately (blocked/failed still routes normally)', async () => {
  await withRt((s) => { const f = new ResultRaceFake(s); f.pendingReads = 0; f.eventual = 'invalid'; return f }, {}, async ({ store, rt, wf }) => {
    const id = await wf()
    await rt.startWorkflow(id)
    await waitFor(async () => (await store.getWorkflow(id))!.status === 'failed')
    const evs = await events(store, id)
    assert.equal((evs.find((e) => e.event_type === 'workflow.failed')!.payload as { reason?: string }).reason, 'task_result_invalid')
    assert.equal((await stepOf(store, id))!.result_awaited_since, null)
  })
})
