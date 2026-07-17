/**
 * Workflow Runtime WORKSPACE-LEASE LIFECYCLE acceptance over an isolated temporary
 * ControlStore, a deterministic fake AgentTaskClient (persists the durable task row
 * the real Gateway would), and a deterministic fake WorkspaceLeaseClient. Proves the
 * runtime integration: no acquire on create; acquire-all before running; the matching
 * lease id on every workspace-bound task; before/after revision observation +
 * out-of-band block; retain-on-blocked; release-on-terminal with in_use retry;
 * idempotent acquire/revision/release recovery; and two-workflow exclusivity.
 * Never touches production or a real relay/node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { plannerExecutorLoopExample } from '../src/workflow/examples.js'
import { type AgentTaskClient, type AgentTaskCreateRequest } from '../src/workflow/task-client.js'
import { type WorkspaceLeaseClient, TransientWorkspaceLeaseError } from '../src/workflow/workspace-lease-client.js'
import { workspaceLeaseId, WorkspaceLeaseError, type WorkspaceLeaseV1, type WorkspaceRevision } from '../src/lib/workspace-lease.js'

const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-lease-')), 'control.sqlite')
const rev = (seed: string): WorkspaceRevision => ({ revision_kind: 'git', head_commit: '0'.repeat(40), dirty: false, state_hash: crypto.createHash('sha256').update(seed).digest('hex'), changed_files: [], observed_at: iso() })
const R0 = rev('R0'), R1 = rev('R1')

// ── deterministic fake Gateway (durable task rows, scripted output) ────────────
interface TaskDesc { output?: Record<string, unknown>; status?: string }
type Script = (req: AgentTaskCreateRequest) => TaskDesc
class ScriptedFake implements AgentTaskClient {
  byKey = new Map<string, any>(); byId = new Map<string, any>(); creates: AgentTaskCreateRequest[] = []; n = 0
  constructor(public store: SqliteControlStore, private script: Script) {}
  async createTask(req: AgentTaskCreateRequest): Promise<{ task_id: string }> {
    this.creates.push(req)
    const existing = this.byKey.get(req.idempotency_key); if (existing) return { task_id: existing.task_id }
    const d = this.script(req); const task_id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id, agent: req.agent, node_id: req.node_id ?? null, status: 'queued', idempotency_key: req.idempotency_key, request_fingerprint: 'fp:' + req.idempotency_key }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    const t = { task_id, req, ...d, key: req.idempotency_key }; this.byKey.set(req.idempotency_key, t); this.byId.set(task_id, t)
    return { task_id }
  }
  private view(t: any) {
    const status = t.status ?? 'completed'; const terminal = ['completed', 'failed', 'cancelled'].includes(status)
    const result_status = status === 'completed' ? (t.output !== undefined ? 'available' : 'missing') : undefined
    const result_text = result_status === 'available' ? JSON.stringify(t.output) : undefined
    return { status, terminal, history_complete: true, result_status, result_text, events: [], next_event_id: -1 }
  }
  async getTask(id: string) { const v = this.view(this.byId.get(id)); return { task_id: id, ...v } }
  async waitForTerminal(id: string) { return { task_id: id, ...this.view(this.byId.get(id)) } }
  async cancelTask(): Promise<void> { /* no-op */ }
}

// ── deterministic fake WorkspaceLeaseClient (shared across workflows) ──────────
class FakeLeaseClient implements WorkspaceLeaseClient {
  active = new Map<string, { workflowId: string; leaseId: string }>() // `${node} ${ws}` → owner
  acquires: string[] = []; releases: string[] = []; observes: string[] = []
  inUseUntil = new Map<string, number>()            // leaseId → remaining in_use rejections
  observeScript?: (key: string, n: number) => WorkspaceRevision
  private observeN = new Map<string, number>()
  private key(n: string, w: string): string { return `${n} ${w}` }
  async acquire(nodeId: string, workflowId: string, workspaceKey: string): Promise<{ lease: WorkspaceLeaseV1; created: boolean }> {
    const k = this.key(nodeId, workspaceKey); this.acquires.push(k)
    const cur = this.active.get(k)
    if (cur && cur.workflowId !== workflowId) throw new WorkspaceLeaseError('workspace_lease_conflict', 'held by another workflow')
    const leaseId = workspaceLeaseId(workflowId, nodeId, workspaceKey)
    this.active.set(k, { workflowId, leaseId })
    return { lease: { workspace_lease_id: leaseId, workflow_id: workflowId, node_id: nodeId, workspace_key: workspaceKey, mode: 'exclusive', status: 'active', base_revision: R0, current_revision: R0, acquired_at: iso() }, created: !cur || cur.workflowId !== workflowId }
  }
  async get(nodeId: string, leaseId: string): Promise<WorkspaceLeaseV1 | null> {
    for (const [k, v] of this.active) if (v.leaseId === leaseId) { const ws = k.slice(nodeId.length + 1); return { workspace_lease_id: leaseId, workflow_id: v.workflowId, node_id: nodeId, workspace_key: ws, mode: 'exclusive', status: 'active', base_revision: R0, current_revision: R0, acquired_at: iso() } }
    return null
  }
  async observeRevision(nodeId: string, workspaceKey: string): Promise<WorkspaceRevision> {
    const k = this.key(nodeId, workspaceKey); this.observes.push(k)
    const n = (this.observeN.get(k) ?? 0) + 1; this.observeN.set(k, n)
    return this.observeScript ? this.observeScript(k, n) : R0
  }
  async release(nodeId: string, leaseId: string): Promise<WorkspaceLeaseV1> {
    this.releases.push(leaseId)
    const left = this.inUseUntil.get(leaseId) ?? 0
    if (left > 0) { this.inUseUntil.set(leaseId, left - 1); throw new TransientWorkspaceLeaseError('a bound run is still active', 'workspace_lease_in_use') }
    for (const [k, v] of this.active) if (v.leaseId === leaseId) this.active.delete(k)
    return { workspace_lease_id: leaseId, workflow_id: '', node_id: nodeId, workspace_key: '', mode: 'exclusive', status: 'released' }
  }
}

const acceptanceScript: Script = (req) => {
  const { step_id, round } = req.metadata as { step_id: string; round: number }
  if (step_id === 'plan') return { output: { status: 'continue', summary: 'plan', next_step: 'Implement part A', acceptance_criteria: ['a'] } }
  if (step_id === 'implement' && round === 1) return { output: { status: 'implemented', summary: 'A', changed_files: ['a.ts'], tests_run: ['t1'], remaining_work: [], risks: [] } }
  if (step_id === 'review' && round === 1) return { output: { status: 'continue', summary: 'partial', next_step: 'Implement part B' } }
  if (step_id === 'implement' && round === 2) return { output: { status: 'implemented', summary: 'B', changed_files: ['b.ts'], tests_run: ['t2'], remaining_work: [], risks: [] } }
  if (step_id === 'review' && round === 2) return { output: { status: 'complete', summary: 'done' } }
  throw new Error(`no script for ${step_id} r${round}`)
}

const NODE = 'node_executor', WS = 'proj'
async function withStore(fn: (store: SqliteControlStore) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  try { await fn(store) } finally { try { store.closeSync() } catch { /* */ } }
}
const mkRt = (store: SqliteControlStore, task: AgentTaskClient, lease: WorkspaceLeaseClient) => new WorkflowRuntime({ store, taskClient: task, leaseClient: lease, waitWindowMs: 20, backoffBaseMs: 3, backoffMaxMs: 10 })

test('no lease is acquired when a workspace-bound workflow is only CREATED', async () => {
  await withStore(async (store) => {
    const lease = new FakeLeaseClient()
    const rt = mkRt(store, new ScriptedFake(store, acceptanceScript), lease)
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x', workspace_key: WS })
    assert.equal(lease.acquires.length, 0, 'no acquire on create')
    assert.equal((await store.listWorkspaceLeaseProjections(workflow_id)).length, 0, 'no projection row on create')
  })
})

test('all required leases are acquired before running; each workspace-bound task carries the matching lease id', async () => {
  await withStore(async (store) => {
    const lease = new FakeLeaseClient()
    const fake = new ScriptedFake(store, acceptanceScript)
    const rt = mkRt(store, fake, lease)
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x', workspace_key: WS })
    await rt.startWorkflow(workflow_id)
    // acquired before any task existed (acquire happens in startWorkflow, before the pump)
    assert.deepEqual(lease.acquires, [`${NODE} ${WS}`], 'exactly one lease acquired for the executor workspace')
    const expectId = workspaceLeaseId(workflow_id, NODE, WS)
    const proj = await store.listWorkspaceLeaseProjections(workflow_id)
    assert.equal(proj.length, 1); assert.equal(proj[0].workspace_lease_id, expectId); assert.equal(proj[0].status, 'active')
    await rt.awaitWorkflow(workflow_id)
    assert.equal((await store.getWorkflow(workflow_id))!.status, 'completed')
    // the two executor (implement) tasks carry the lease id; the planner tasks do not
    const impl = fake.creates.filter((c) => (c.metadata as any).step_id === 'implement')
    const plan = fake.creates.filter((c) => (c.metadata as any).step_id !== 'implement')
    assert.ok(impl.length === 2 && impl.every((c) => c.workspace_lease_id === expectId), 'every implement task presents the lease id')
    assert.ok(plan.every((c) => c.workspace_lease_id === undefined), 'unmanaged planner tasks carry no lease id')
    // released after the workflow terminalized
    assert.equal((await store.listWorkspaceLeaseProjections(workflow_id))[0].status, 'released')
    assert.ok(lease.releases.includes(expectId))
  })
})

test('two workflows competing for one workspace: exactly one runs, the other stays ready (conflict)', async () => {
  await withStore(async (store) => {
    const lease = new FakeLeaseClient() // shared authority
    const a = mkRt(store, new ScriptedFake(store, acceptanceScript), lease)
    const b = mkRt(store, new ScriptedFake(store, acceptanceScript), lease)
    const wfA = (await a.createWorkflow(plannerExecutorLoopExample(), { objective: 'A', workspace_key: WS })).workflow_id
    const wfB = (await b.createWorkflow(plannerExecutorLoopExample(), { objective: 'B', workspace_key: WS })).workflow_id
    await a.startWorkflow(wfA) // acquires the workspace
    await assert.rejects(() => b.startWorkflow(wfB), (e: any) => e.code === 'workspace_lease_conflict', 'B conflicts')
    assert.equal((await store.getWorkflow(wfB))!.status, 'ready', 'B stays ready (no task started)')
    await a.awaitWorkflow(wfA)
    assert.equal((await store.getWorkflow(wfA))!.status, 'completed')
  })
})

test('an out-of-band workspace change BLOCKS before the next task and RETAINS the lease', async () => {
  await withStore(async (store) => {
    const lease = new FakeLeaseClient()
    // The FIRST before-observe on the executor workspace returns a divergent revision.
    lease.observeScript = (key, n) => (key === `${NODE} ${WS}` && n === 1 ? R1 : R0)
    const fake = new ScriptedFake(store, acceptanceScript)
    const rt = mkRt(store, fake, lease)
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x', workspace_key: WS })
    await rt.startWorkflow(workflow_id)
    await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'blocked', 'diverged revision blocked the workflow')
    // no implement task was ever created (blocked BEFORE task creation)
    assert.equal(fake.creates.filter((c) => (c.metadata as any).step_id === 'implement').length, 0)
    // the lease is RETAINED on a blocked workflow
    const proj = (await store.listWorkspaceLeaseProjections(workflow_id))[0]
    assert.equal(proj.status, 'active', 'lease retained while blocked')
    assert.equal(lease.releases.length, 0, 'no release on block')
  })
})

test('a blocked workflow retains its lease; cancelling it releases the lease', async () => {
  await withStore(async (store) => {
    const lease = new FakeLeaseClient()
    lease.observeScript = (key, n) => (key === `${NODE} ${WS}` && n === 1 ? R1 : R0)
    const rt = mkRt(store, new ScriptedFake(store, acceptanceScript), lease)
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x', workspace_key: WS })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    assert.equal((await store.getWorkflow(workflow_id))!.status, 'blocked')
    assert.equal(lease.releases.length, 0)
    await rt.cancelWorkflow(workflow_id)
    assert.equal((await store.getWorkflow(workflow_id))!.status, 'cancelled')
    const proj = (await store.listWorkspaceLeaseProjections(workflow_id))[0]
    assert.equal(proj.status, 'released', 'cancelled (previously blocked) workflow releases its lease')
  })
})

test('release retries through a transient workspace_lease_in_use until it succeeds', async () => {
  await withStore(async (store) => {
    const lease = new FakeLeaseClient()
    const rt = mkRt(store, new ScriptedFake(store, acceptanceScript), lease)
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x', workspace_key: WS })
    const leaseId = workspaceLeaseId(workflow_id, NODE, WS)
    lease.inUseUntil.set(leaseId, 2) // first two release attempts are refused (bound run winding down)
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    assert.equal((await store.getWorkflow(workflow_id))!.status, 'completed')
    assert.ok(lease.releases.filter((r) => r === leaseId).length >= 3, 'retried past the in_use refusals')
    assert.equal((await store.listWorkspaceLeaseProjections(workflow_id))[0].status, 'released')
  })
})

test('revision evidence is persisted per step and survives a store reopen; recovery reuses the same lease id', async () => {
  const db = tmpDb()
  const leaseId = (wf: string) => workspaceLeaseId(wf, NODE, WS)
  let workflowId = ''
  {
    const store = openControlStore({ path: db })
    const lease = new FakeLeaseClient()
    const rt = mkRt(store, new ScriptedFake(store, acceptanceScript), lease)
    workflowId = (await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x', workspace_key: WS })).workflow_id
    await rt.startWorkflow(workflowId); await rt.awaitWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'completed')
    store.closeSync()
  }
  // Reopen: revision evidence + lease projection persisted durably.
  const store = openControlStore({ path: db })
  try {
    const steps = await store.listStepExecutions(workflowId)
    const impl = steps.filter((s) => s.step_id === 'implement')
    assert.ok(impl.length === 2 && impl.every((s) => (s.revision_before as any)?.state_hash && (s.revision_after as any)?.state_hash), 'each implement step persisted revision_before + revision_after')
    const proj = (await store.listWorkspaceLeaseProjections(workflowId))[0]
    assert.equal(proj.workspace_lease_id, leaseId(workflowId), 'stable deterministic lease id survives reopen')
    assert.equal(proj.status, 'released')
    // A recovery pass over the reopened store is idempotent (already released → no-op).
    const rt2 = mkRt(store, new ScriptedFake(store, acceptanceScript), new FakeLeaseClient())
    assert.equal(await rt2.recoverLeaseReleases(), 0, 'no releasable leases remain')
  } finally { store.closeSync() }
})

test('recovery completes a pending release left by a crash after terminalization', async () => {
  const db = tmpDb()
  let workflowId = ''
  {
    // Crash simulation: complete the workflow but drop the release (shutdown mid-release).
    const store = openControlStore({ path: db })
    const lease = new FakeLeaseClient()
    const leaseId0 = () => workspaceLeaseId(workflowId, NODE, WS)
    const rt = mkRt(store, new ScriptedFake(store, acceptanceScript), lease)
    workflowId = (await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x', workspace_key: WS })).workflow_id
    // make every release attempt fail so the workflow terminalizes with lease unreleased
    lease.inUseUntil.set(leaseId0(), 999)
    await rt.startWorkflow(workflowId); await rt.awaitWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'completed')
    assert.notEqual((await store.listWorkspaceLeaseProjections(workflowId))[0].status, 'released')
    store.closeSync()
  }
  // Recover with a healthy lease client → the pending release is completed.
  const store = openControlStore({ path: db })
  try {
    const lease = new FakeLeaseClient()
    const rt = mkRt(store, new ScriptedFake(store, acceptanceScript), lease)
    const n = await rt.recoverLeaseReleases()
    assert.ok(n >= 1, 'recovery found the pending release')
    assert.equal((await store.listWorkspaceLeaseProjections(workflowId))[0].status, 'released')
  } finally { store.closeSync() }
})

test('a workflow with NO workspace-bound steps runs unchanged without a lease client (backward compatible)', async () => {
  await withStore(async (store) => {
    const rt = new WorkflowRuntime({ store, taskClient: new ScriptedFake(store, acceptanceScript), waitWindowMs: 20 })
    // No `workspace_key` input → the implement step's optional workspace key is absent →
    // the workflow is NOT workspace-bound, so no lease client is required.
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    assert.equal((await store.getWorkflow(workflow_id))!.status, 'completed')
    assert.equal((await store.listWorkspaceLeaseProjections(workflow_id)).length, 0, 'no lease projection without a lease client')
  })
})

test('a workspace-bound workflow FAILS CLOSED without a lease client: workspace_lease_unsupported, stays ready, no task', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, acceptanceScript)
    // A workspace_key input makes the implement step workspace-bound; NO lease client.
    const rt = new WorkflowRuntime({ store, taskClient: fake, waitWindowMs: 20 })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x', workspace_key: WS })
    await assert.rejects(() => rt.startWorkflow(workflow_id), (e: any) => e.code === 'workspace_lease_unsupported', 'refused to start unleased')
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'ready', 'workflow stays ready (no ready→running transition)')
    assert.equal(wf.total_tasks, 0)
    assert.equal(fake.creates.length, 0, 'no Agent Task was created')
    assert.equal((await store.listStepExecutions(workflow_id)).length, 0, 'no step execution started')
    // No terminal/started event was emitted.
    const evs = (await store.listWorkflowEvents(workflow_id)).map((e) => e.event_type)
    assert.ok(!evs.includes('workflow.started'), 'no workflow.started event')
  })
})
