/**
 * Ambiguous workspace-lease acquisition recovery: bounded, observable, crash/retry-safe.
 * A lost/timed-out acquire ack is RECONCILED against the Node's authoritative lease
 * (deterministic id + idempotent acquire), never leaving the workflow stuck and never
 * creating a duplicate lease or task, and never starting before the lease is active.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { WorkflowRuntimeError } from '../src/workflow/errors.js'
import { workspaceLeaseId, WorkspaceLeaseError, type WorkspaceLeaseV1, type WorkspaceRevision } from '../src/lib/workspace-lease.js'
import { TransientWorkspaceLeaseError, type WorkspaceLeaseClient } from '../src/workflow/workspace-lease-client.js'
import type { AgentTaskClient, AgentTaskCreateRequest } from '../src/workflow/task-client.js'

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-lease-')), 'control.sqlite')
const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const R0: WorkspaceRevision = { revision_kind: 'git', head_commit: '0'.repeat(40), dirty: false, state_hash: crypto.createHash('sha256').update('R0').digest('hex'), changed_files: [], observed_at: iso() }
const leaseV1 = (id: string, wf: string, node: string, ws: string): WorkspaceLeaseV1 => ({ workspace_lease_id: id, workflow_id: wf, node_id: node, workspace_key: ws, mode: 'exclusive', status: 'active', base_revision: R0, current_revision: R0, acquired_at: iso() })

type AcquireBeh = 'ok' | 'transient_lost_ack' | 'transient_never' | 'conflict'
class ScriptLeaseClient implements WorkspaceLeaseClient {
  acquireCalls = 0; getCalls = 0
  acquireScript: (n: number) => AcquireBeh = () => 'ok'
  getScript: (n: number) => 'authoritative' | 'null' | 'throw' = () => 'authoritative'
  held = new Map<string, { wf: string; node: string; ws: string }>() // node-authoritative lease state
  async acquire(nodeId: string, workflowId: string, workspaceKey: string) {
    const n = ++this.acquireCalls
    const id = workspaceLeaseId(workflowId, nodeId, workspaceKey)
    const beh = this.acquireScript(n)
    if (beh === 'conflict') throw new WorkspaceLeaseError('workspace_lease_conflict', 'held by another workflow')
    if (beh === 'transient_lost_ack') { this.held.set(id, { wf: workflowId, node: nodeId, ws: workspaceKey }); throw new TransientWorkspaceLeaseError('ack lost', 'workspace_lease_unavailable') } // Node DID create it
    if (beh === 'transient_never') throw new TransientWorkspaceLeaseError('never reached node', 'workspace_lease_unavailable') // Node did NOT create it
    this.held.set(id, { wf: workflowId, node: nodeId, ws: workspaceKey })
    return { lease: leaseV1(id, workflowId, nodeId, workspaceKey), created: true }
  }
  async get(nodeId: string, leaseId: string) {
    const n = ++this.getCalls
    const beh = this.getScript(n)
    if (beh === 'throw') throw new TransientWorkspaceLeaseError('probe failed', 'internal_error')
    if (beh === 'null') return null
    const h = this.held.get(leaseId); return h ? leaseV1(leaseId, h.wf, nodeId, h.ws) : null // authoritative
  }
  async observeRevision(): Promise<WorkspaceRevision> { return R0 }
  async release(_n: string, leaseId: string): Promise<WorkspaceLeaseV1> { this.held.delete(leaseId); return { workspace_lease_id: leaseId, workflow_id: '', node_id: _n, workspace_key: '', mode: 'exclusive', status: 'released' } }
}

class TaskFake implements AgentTaskClient {
  creates: string[] = []; byKey = new Map<string, string>(); n = 0
  constructor(public store: SqliteControlStore) {}
  async createTask(r: AgentTaskCreateRequest) {
    const ex = this.byKey.get(r.idempotency_key); if (ex) return { task_id: ex }
    const id = 'task_' + (++this.n); this.creates.push(id); this.byKey.set(r.idempotency_key, id)
    this.store.createTaskDurable({ task_id: id, agent: r.agent, node_id: r.node_id ?? null, status: 'queued', idempotency_key: r.idempotency_key, request_fingerprint: 'fp' }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    return { task_id: id }
  }
  async getTask(id: string) { return { task_id: id, status: 'running', terminal: false, history_complete: true } }
  async waitForTerminal(id: string) { await sleep(3); return { task_id: id, status: 'running', terminal: false, history_complete: true, events: [], next_event_id: -1 } }
  async cancelTask() { /* */ }
}

const leaseSpec = () => ({
  version: '1', name: 'lease-recovery', entry_step: 'go', inputs: {},
  agents: { solo: { agent: 'mock', node_id: 'node_x' } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 1, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
  steps: [{ id: 'go', type: 'agent_task', agent_role: 'solo', workspace_key_template: 'ws-key', prompt_template: 'do', output_schema: 'o' }],
  edges: [{ from: 'go', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: {},
})

async function withRt(fn: (ctx: { store: SqliteControlStore; lease: ScriptLeaseClient; task: TaskFake; mkRt: () => WorkflowRuntime; created: () => Promise<string> }) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  const lease = new ScriptLeaseClient()
  const task = new TaskFake(store)
  const runtimes: WorkflowRuntime[] = []
  const mkRt = () => { const rt = new WorkflowRuntime({ store, taskClient: task, leaseClient: lease, waitWindowMs: 20, backoffBaseMs: 3, backoffMaxMs: 12 }); runtimes.push(rt); return rt }
  const created = async () => (await mkRt().createWorkflow(leaseSpec(), {})).workflow_id
  try { await fn({ store, lease, task, mkRt, created }) } finally { for (const rt of runtimes) { try { await rt.shutdown() } catch { /* */ } } try { store.closeSync() } catch { /* */ } }
}

const startedCount = async (store: SqliteControlStore, wf: string) => (await store.listWorkflowEvents(wf)).filter((e) => e.event_type === 'workflow.started').length
const leaseOf = async (store: SqliteControlStore, wf: string) => (await store.listWorkspaceLeaseProjections(wf))[0]
const waitFor = async (fn: () => Promise<boolean>, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(10) } throw new Error('timeout') }

// ── lost ack, remote active → recovery continues ONCE ─────────────────────────
test('lost acquire ack but Node lease active → reconciled to active, started exactly once, one lease/task', async () => {
  await withRt(async ({ store, lease, task, mkRt, created }) => {
    const wf = await created()
    lease.acquireScript = () => 'transient_lost_ack'  // ack lost, but the Node DID create the lease
    lease.getScript = () => 'authoritative'            // reconcile probe sees it active
    const rt = mkRt()
    await rt.startWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'running')
    assert.equal((await leaseOf(store, wf)).status, 'active')
    assert.equal(await startedCount(store, wf), 1)     // workflow.started exactly once
    assert.equal(lease.held.size, 1)                    // exactly one lease
    await waitFor(async () => task.creates.length === 1)
    assert.equal(task.creates.length, 1)                // one Agent Task
  })
})

// ── remote acquire never happened → pending; safe retry reuses same attempt ───
test('acquire never reached the Node → pending (acquire_unconfirmed), then explicit retry acquires the SAME lease', async () => {
  await withRt(async ({ store, lease, mkRt, created }) => {
    const wf = await created()
    lease.acquireScript = (n) => (n === 1 ? 'transient_never' : 'ok') // 1st never reaches; retry succeeds
    lease.getScript = () => 'null'                                     // probe confirms NOT created
    const rt = mkRt()
    await assert.rejects(rt.startWorkflow(wf), (e) => e instanceof WorkflowRuntimeError && e.code === 'workspace_lease_pending')
    // stays ready, no started, lease acquiring with a durable, visible reason
    assert.equal((await store.getWorkflow(wf))!.status, 'ready')
    assert.equal(await startedCount(store, wf), 0)
    const l1 = await leaseOf(store, wf)
    assert.equal(l1.status, 'acquiring'); assert.equal(l1.acquire_reason, 'acquire_unconfirmed')
    // explicit safe retry → same deterministic lease id, now acquired → started
    await rt.startWorkflow(wf)
    const l2 = await leaseOf(store, wf)
    assert.equal(l2.status, 'active')
    assert.equal(l2.workspace_lease_id, l1.workspace_lease_id) // SAME lease id (no second lease)
    assert.equal(lease.held.size, 1)
    assert.equal(await startedCount(store, wf), 1)
  })
})

// ── outcome unknown → stays pending, then background reconcile resolves it ─────
test('unknown outcome (probe also fails) → pending; background reconcile continues once the Node confirms', async () => {
  await withRt(async ({ store, lease, mkRt, created }) => {
    const wf = await created()
    lease.acquireScript = () => 'transient_lost_ack'  // Node created it; ack lost
    let probes = 0
    lease.getScript = () => (++probes <= 1 ? 'throw' : 'authoritative') // first probe fails (unknown), later succeeds
    const rt = mkRt()
    await assert.rejects(rt.startWorkflow(wf), (e) => e instanceof WorkflowRuntimeError && e.code === 'workspace_lease_pending')
    assert.equal((await leaseOf(store, wf)).acquire_reason, 'lease_outcome_unknown')
    assert.equal(await startedCount(store, wf), 0) // never started while unknown
    // background reconcile (scheduled) resolves it exactly once
    await waitFor(async () => (await store.getWorkflow(wf))!.status === 'running')
    assert.equal(await startedCount(store, wf), 1)
    assert.equal(lease.held.size, 1)
  })
})

// ── Gateway restart with an acquiring lease → reconcile, no duplicate ──────────
test('Gateway restart with an acquiring lease → recovery reconciles, no duplicate lease or task, started once', async () => {
  await withRt(async ({ store, lease, task, mkRt, created }) => {
    const wf = await created()
    // First runtime: leave the lease unknown/acquiring (probe fails), workflow stays ready.
    lease.acquireScript = () => 'transient_lost_ack'
    lease.getScript = () => 'throw'
    const rt1 = mkRt()
    await assert.rejects(rt1.startWorkflow(wf), (e) => e instanceof WorkflowRuntimeError && e.code === 'workspace_lease_pending')
    await rt1.shutdown()
    assert.equal((await leaseOf(store, wf)).status, 'acquiring')
    // Restart: a fresh runtime recovers. The Node authoritatively holds the lease now.
    lease.getScript = () => 'authoritative'
    const rt2 = mkRt()
    await rt2.recoverWorkflows()
    await waitFor(async () => (await store.getWorkflow(wf))!.status === 'running')
    assert.equal(await startedCount(store, wf), 1)   // started exactly once
    assert.equal(lease.held.size, 1)                  // one lease
    await waitFor(async () => task.creates.length === 1)
    assert.equal(task.creates.length, 1)              // one task
  })
})

// ── definitive conflict → blocked, reason durable + visible after reload ──────
test('definitive conflict → workflow stays ready with a durable, reload-visible reason; explicit retry allowed', async () => {
  await withRt(async ({ store, lease, mkRt, created }) => {
    const wf = await created()
    lease.acquireScript = () => 'conflict'
    const rt = mkRt()
    await assert.rejects(rt.startWorkflow(wf), (e) => e instanceof WorkflowRuntimeError && e.code === 'workspace_lease_conflict')
    assert.equal((await store.getWorkflow(wf))!.status, 'ready')
    assert.equal(await startedCount(store, wf), 0)
    const l = await leaseOf(store, wf)                 // durable + observable after reload
    assert.equal(l.status, 'acquiring'); assert.equal(l.acquire_reason, 'workspace_lease_conflict')
    // conflict clears → explicit retry succeeds on the SAME lease
    lease.acquireScript = () => 'ok'
    await rt.startWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'running')
  })
})

// ── repeated concurrent Start calls coalesce onto one acquire attempt ─────────
test('concurrent Start calls coalesce → the Node acquire is attempted once, one lease, started once', async () => {
  await withRt(async ({ store, lease, mkRt, created }) => {
    const wf = await created()
    lease.acquireScript = () => 'ok'
    const rt = mkRt()
    await Promise.all([rt.startWorkflow(wf).catch(() => {}), rt.startWorkflow(wf).catch(() => {}), rt.startWorkflow(wf).catch(() => {})])
    await waitFor(async () => (await store.getWorkflow(wf))!.status === 'running')
    assert.equal(lease.acquireCalls, 1)               // coalesced onto ONE acquire
    assert.equal(lease.held.size, 1)
    assert.equal(await startedCount(store, wf), 1)
  })
})
