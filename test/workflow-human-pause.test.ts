/**
 * Workflow Runtime HUMAN PAUSE acceptance (waiting_input / waiting_approval /
 * resume) over an isolated temporary ControlStore + a deterministic fake task
 * client (and a fake lease client for the lease-retention cases). Proves durable
 * input/approval pauses: no Agent Task runs while waiting; a pending request
 * survives a runtime restart; responses are idempotent and conflicting responses
 * fail closed; resume continues from the same checkpoint with no duplicate step or
 * task; leases stay active while waiting and release on cancel/terminal; limits and
 * started_at do not reset. Internal runtime only — no REST/MCP. Never touches prod.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { stepExecutionId, humanRequestId } from '../src/workflow/recovery.js'
import { type AgentTaskClient, type AgentTaskCreateRequest } from '../src/workflow/task-client.js'
import { type WorkspaceLeaseClient } from '../src/workflow/workspace-lease-client.js'
import { workspaceLeaseId, type WorkspaceLeaseV1, type WorkspaceRevision } from '../src/lib/workspace-lease.js'
import type { WorkflowSpec } from '../src/workflow/contract.js'

const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pause-')), 'control.sqlite')

// ── deterministic fake Gateway (durable task rows, result-backed) ─────────────
interface TaskDesc { output?: Record<string, unknown> }
class ScriptedFake implements AgentTaskClient {
  byKey = new Map<string, any>(); byId = new Map<string, any>(); creates: AgentTaskCreateRequest[] = []; n = 0
  constructor(public store: SqliteControlStore, private script: (r: AgentTaskCreateRequest) => TaskDesc) {}
  async createTask(req: AgentTaskCreateRequest): Promise<{ task_id: string }> {
    this.creates.push(req)
    const ex = this.byKey.get(req.idempotency_key); if (ex) return { task_id: ex.task_id }
    const d = this.script(req); const task_id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id, agent: req.agent, node_id: req.node_id ?? null, status: 'queued', idempotency_key: req.idempotency_key, request_fingerprint: 'fp:' + req.idempotency_key }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    const t = { task_id, req, ...d, key: req.idempotency_key }; this.byKey.set(req.idempotency_key, t); this.byId.set(task_id, t); return { task_id }
  }
  private view(t: any) {
    const result_text = t.output !== undefined ? JSON.stringify(t.output) : undefined
    return { status: 'completed', terminal: true, history_complete: true, result_status: t.output !== undefined ? 'available' : 'missing', result_text, events: [], next_event_id: -1 }
  }
  async getTask(id: string) { return { task_id: id, ...this.view(this.byId.get(id)) } }
  async waitForTerminal(id: string) { await sleep(5); return { task_id: id, ...this.view(this.byId.get(id)) } }
  async cancelTask(): Promise<void> { /* no-op */ }
}

// ── fake lease client (for lease-retention cases) ─────────────────────────────
const R0: WorkspaceRevision = { revision_kind: 'unavailable', state_hash: 'a'.repeat(64), observed_at: iso() }
class FakeLeaseClient implements WorkspaceLeaseClient {
  active = new Map<string, string>(); releases: string[] = []
  async acquire(nodeId: string, workflowId: string, workspaceKey: string): Promise<{ lease: WorkspaceLeaseV1; created: boolean }> {
    const id = workspaceLeaseId(workflowId, nodeId, workspaceKey); this.active.set(id, workflowId)
    return { lease: { workspace_lease_id: id, workflow_id: workflowId, node_id: nodeId, workspace_key: workspaceKey, mode: 'exclusive', status: 'active', base_revision: R0, current_revision: R0, acquired_at: iso() }, created: true }
  }
  async observeRevision(): Promise<WorkspaceRevision> { return R0 }
  async release(_n: string, leaseId: string): Promise<WorkspaceLeaseV1> { this.releases.push(leaseId); this.active.delete(leaseId); return { workspace_lease_id: leaseId, workflow_id: '', node_id: _n, workspace_key: '', mode: 'exclusive', status: 'released' } }
}

// A two-step spec: step `gate` (agent task) with a pause_before; then `finish`.
const pausedSpec = (kind: 'input' | 'approval', opts: { node?: boolean } = {}): WorkflowSpec => ({
  version: '1', name: `pause-${kind}`, entry_step: 'gate',
  inputs: { objective: { type: 'string', required: true }, ...(opts.node ? { workspace_key: { type: 'string', required: true } } : {}) },
  agents: { solo: { agent: 'mock', ...(opts.node ? { node_id: 'node_x' } : {}) } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 5, max_runtime_seconds: 600, max_step_attempts: 1, max_failures: 2 },
  steps: [
    { id: 'gate', type: 'agent_task', agent_role: 'solo', prompt_template: 'Do {{ inputs.objective }}', output_schema: 'o', pause_before: { kind, prompt: kind === 'input' ? 'Enter a value' : 'Approve?', choices: kind === 'approval' ? ['yes', 'no'] : undefined }, ...(opts.node ? { workspace_key_template: '{{ inputs.workspace_key }}' } : {}) },
    { id: 'finish', type: 'agent_task', agent_role: 'solo', prompt_template: 'Finish', output_schema: 'o', ...(opts.node ? { workspace_key_template: '{{ inputs.workspace_key }}' } : {}) },
  ],
  edges: [
    { from: 'gate', to: 'finish', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } },
    { from: 'finish', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } },
  ],
})
const doneScript = () => ({ output: { status: 'done', summary: 'ok' } })

/** A spec whose input-paused gate step INJECTS the answered response via
 *  `{{ pause.response }}` — proving the response is consumed by the resumed task. */
const inputBindingSpec = (): WorkflowSpec => ({
  version: '1', name: 'pause-bind', entry_step: 'gate',
  inputs: { objective: { type: 'string', required: true } },
  agents: { solo: { agent: 'mock' } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 5, max_runtime_seconds: 600, max_step_attempts: 1, max_failures: 2 },
  steps: [
    { id: 'gate', type: 'agent_task', agent_role: 'solo', prompt_template: 'Use answer: {{ pause.response }}', output_schema: 'o', pause_before: { kind: 'input', prompt: 'Enter a value' } },
    { id: 'finish', type: 'agent_task', agent_role: 'solo', prompt_template: 'Finish', output_schema: 'o' },
  ],
  edges: [
    { from: 'gate', to: 'finish', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } },
    { from: 'finish', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } },
  ],
})

async function withStore(fn: (store: SqliteControlStore) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  try { await fn(store) } finally { try { store.closeSync() } catch { /* */ } }
}
const mkRt = (store: SqliteControlStore, task: AgentTaskClient, lease?: WorkspaceLeaseClient) => new WorkflowRuntime({ store, taskClient: task, leaseClient: lease, waitWindowMs: 20, backoffBaseMs: 3, backoffMaxMs: 10 })
const gateExecId = (wf: string) => stepExecutionId(wf, 'gate', 1, 1)

test('input pause → restart preserves the pending request → answer → resume → completes (no task while waiting)', async () => {
  const db = tmpDb()
  let workflowId = ''
  {
    const store = openControlStore({ path: db })
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    workflowId = (await rt.createWorkflow(pausedSpec('input'), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    // settle into the pause
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_input'; i++) await sleep(20)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'waiting_input')
    assert.equal(fake.creates.length, 0, 'no Agent Task created while waiting')
    const pending = await rt.getPendingRequest(workflowId)
    assert.ok(pending && pending.kind === 'input' && pending.status === 'pending' && pending.prompt === 'Enter a value')
    await rt.shutdown(); store.closeSync()
  }
  // Restart: the pending request survived.
  const store = openControlStore({ path: db })
  try {
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    const pending = await rt.getPendingRequest(workflowId)
    assert.ok(pending && pending.status === 'pending', 'pending request survived restart')
    assert.equal((await store.getWorkflow(workflowId))!.status, 'waiting_input')
    // answer + resume
    const req = humanRequestId(gateExecId(workflowId))
    await rt.answerInput(req, 'the-answer')
    await rt.resumeWorkflow(workflowId)
    await rt.awaitWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'completed')
    // exactly the two agent tasks (gate + finish) — the pause added no extra task
    const steps = await store.listStepExecutions(workflowId)
    assert.deepEqual(steps.map((s) => s.step_id).sort(), ['finish', 'gate'])
    assert.equal(new Set(steps.map((s) => s.task_id)).size, 2)
    assert.equal((await store.getHumanRequest(req))!.response_value, 'the-answer')
  } finally { store.closeSync() }
})

test('approval pause → approve → resume → completes', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    const workflowId = (await rt.createWorkflow(pausedSpec('approval'), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_approval'; i++) await sleep(20)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'waiting_approval')
    assert.equal(fake.creates.length, 0)
    const req = humanRequestId(gateExecId(workflowId))
    await rt.decideApproval(req, true)
    assert.equal((await store.getHumanRequest(req))!.status, 'approved')
    await rt.resumeWorkflow(workflowId)
    await rt.awaitWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'completed')
  })
})

test('approval REJECTION fails the workflow (documented policy) and creates no task', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    const workflowId = (await rt.createWorkflow(pausedSpec('approval'), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_approval'; i++) await sleep(20)
    const req = humanRequestId(gateExecId(workflowId))
    await rt.decideApproval(req, false)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'failed')
    assert.equal((await store.getHumanRequest(req))!.status, 'rejected')
    assert.equal(fake.creates.length, 0, 'no Agent Task ever ran')
    const evs = (await store.listWorkflowEvents(workflowId)).map((e) => e.event_type)
    assert.ok(evs.includes('workflow.failed'))
  })
})

test('duplicate identical response is idempotent; a conflicting response fails closed', async () => {
  await withStore(async (store) => {
    const rt = mkRt(store, new ScriptedFake(store, doneScript))
    // input
    const wfIn = (await rt.createWorkflow(pausedSpec('input'), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wfIn)
    for (let i = 0; i < 20 && (await store.getWorkflow(wfIn))!.status !== 'waiting_input'; i++) await sleep(20)
    const reqIn = humanRequestId(gateExecId(wfIn))
    await rt.answerInput(reqIn, 'v1')
    await rt.answerInput(reqIn, 'v1') // idempotent — no throw
    await assert.rejects(() => rt.answerInput(reqIn, 'v2'), /conflicting input response/, 'different value fails closed')
    // approval
    const wfAp = (await rt.createWorkflow(pausedSpec('approval'), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wfAp)
    for (let i = 0; i < 20 && (await store.getWorkflow(wfAp))!.status !== 'waiting_approval'; i++) await sleep(20)
    const reqAp = humanRequestId(gateExecId(wfAp))
    await rt.decideApproval(reqAp, true)
    await rt.decideApproval(reqAp, true) // idempotent
    await assert.rejects(() => rt.decideApproval(reqAp, false), /already approved/, 'opposite decision fails closed')
  })
})

test('cancellation while waiting cancels the workflow (and releases leases); lease retained while waiting', async () => {
  await withStore(async (store) => {
    const lease = new FakeLeaseClient()
    const rt = mkRt(store, new ScriptedFake(store, doneScript), lease)
    const workflowId = (await rt.createWorkflow(pausedSpec('approval', { node: true }), { objective: 'x', workspace_key: 'proj' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_approval'; i++) await sleep(20)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'waiting_approval')
    // lease was acquired at start and is RETAINED while waiting
    const leaseId = workspaceLeaseId(workflowId, 'node_x', 'proj')
    assert.equal((await store.getWorkspaceLeaseProjection(leaseId))!.status, 'active')
    assert.equal(lease.releases.length, 0, 'no release while waiting')
    // cancel while waiting → cancelled + lease released
    await rt.cancelWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'cancelled')
    assert.equal((await store.getWorkspaceLeaseProjection(leaseId))!.status, 'released')
    assert.ok(lease.releases.includes(leaseId))
  })
})

// ── pause.response binding (answered input consumed by the resumed task) ──────

test('binding 1+3: a task referencing pause.response starts NO task until answered, then the response appears in the resumed prompt', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    const workflowId = (await rt.createWorkflow(inputBindingSpec(), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_input'; i++) await sleep(20)
    // (3) missing response → no task created while waiting
    assert.equal((await store.getWorkflow(workflowId))!.status, 'waiting_input')
    assert.equal(fake.creates.length, 0, 'no task starts before a response exists')
    // answer + resume
    await rt.answerInput(humanRequestId(gateExecId(workflowId)), 'MAGIC-42')
    await rt.resumeWorkflow(workflowId)
    await rt.awaitWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'completed')
    // (1) the answered response is rendered into the gate task's prompt
    const gateReq = fake.creates.find((c) => (c.metadata as any).step_id === 'gate')!
    assert.ok(gateReq.input.text.includes('MAGIC-42'), `gate prompt must contain the answer: ${gateReq.input.text}`)
    assert.equal(gateReq.input.text, 'Use answer: MAGIC-42')
  })
})

test('binding 2: restart BEFORE resume preserves the exact response, then renders it deterministically', async () => {
  const db = tmpDb()
  let workflowId = ''
  {
    const store = openControlStore({ path: db })
    const rt = mkRt(store, new ScriptedFake(store, doneScript))
    workflowId = (await rt.createWorkflow(inputBindingSpec(), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_input'; i++) await sleep(20)
    await rt.answerInput(humanRequestId(gateExecId(workflowId)), 'exact-value-✓')
    await rt.shutdown(); store.closeSync() // crash BEFORE resume
  }
  const store = openControlStore({ path: db })
  try {
    // the exact response survived the restart
    assert.equal((await store.getHumanRequest(humanRequestId(gateExecId(workflowId))))!.response_value, 'exact-value-✓')
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    await rt.resumeWorkflow(workflowId)
    await rt.awaitWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'completed')
    const gateReq = fake.creates.find((c) => (c.metadata as any).step_id === 'gate')!
    assert.equal(gateReq.input.text, 'Use answer: exact-value-✓', 'deterministic render of the preserved response')
  } finally { store.closeSync() }
})

test('binding 4: a duplicate resume creates no second task (idempotent)', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    const workflowId = (await rt.createWorkflow(inputBindingSpec(), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_input'; i++) await sleep(20)
    await rt.answerInput(humanRequestId(gateExecId(workflowId)), 'v')
    await rt.resumeWorkflow(workflowId)
    await rt.awaitWorkflow(workflowId)
    await rt.resumeWorkflow(workflowId) // duplicate resume after completion
    await rt.resumeWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'completed')
    assert.equal(fake.creates.filter((c) => (c.metadata as any).step_id === 'gate').length, 1, 'exactly one gate task despite repeated resume')
    assert.equal((await store.getWorkflow(workflowId))!.total_tasks, 2)
  })
})

test('binding 5: approval pauses inject nothing (execution gate only) and a rejection still fails', async () => {
  await withStore(async (store) => {
    // pause.response on an APPROVAL step is rejected at validation (input gate only).
    const badSpec: any = pausedSpec('approval')
    badSpec.steps[0].prompt_template = 'Approve got {{ pause.response }}'
    const rt = mkRt(store, new ScriptedFake(store, doneScript))
    await assert.rejects(() => rt.createWorkflow(badSpec, { objective: 'x' }), (e: any) => e.code === 'invalid_spec', 'pause.response on an approval step is invalid')
    // a normal approval step injects nothing and its rejection fails the workflow
    const fake = new ScriptedFake(store, doneScript)
    const rt2 = mkRt(store, fake)
    const wf = (await rt2.createWorkflow(pausedSpec('approval'), { objective: 'x' })).workflow_id
    await rt2.startWorkflow(wf)
    for (let i = 0; i < 20 && (await store.getWorkflow(wf))!.status !== 'waiting_approval'; i++) await sleep(20)
    await rt2.decideApproval(humanRequestId(gateExecId(wf)), false)
    assert.equal((await store.getWorkflow(wf))!.status, 'failed')
    assert.equal(fake.creates.length, 0)
  })
})

test('transition: a PENDING request cannot resume (resume before answer is a no-op; stays waiting, no task)', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    const workflowId = (await rt.createWorkflow(pausedSpec('input'), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_input'; i++) await sleep(20)
    // resume WITHOUT answering → no-op; the workflow stays waiting and starts no task
    await rt.resumeWorkflow(workflowId)
    await rt.resumeWorkflow(workflowId)
    await sleep(60)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'waiting_input', 'still waiting (pending cannot resume)')
    assert.equal(fake.creates.length, 0, 'no Agent Task created')
    assert.equal((await rt.getPendingRequest(workflowId))!.status, 'pending')
  })
})

test('transition: a REJECTED approval cannot resume (terminal wins; no task)', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    const workflowId = (await rt.createWorkflow(pausedSpec('approval'), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_approval'; i++) await sleep(20)
    await rt.decideApproval(humanRequestId(gateExecId(workflowId)), false)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'failed')
    // resume on a rejected (failed) workflow is a no-op — it stays failed, no task
    await rt.resumeWorkflow(workflowId)
    await rt.resumeWorkflow(workflowId)
    await sleep(40)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'failed', 'rejection is terminal; resume cannot revive it')
    assert.equal(fake.creates.length, 0)
    // completion/terminal event exactly once
    const evs = (await store.listWorkflowEvents(workflowId)).map((e) => e.event_type)
    assert.equal(evs.filter((e) => e === 'workflow.failed').length, 1)
  })
})

test('resume after restart re-drives without duplicating the Agent Task; started_at is preserved', async () => {
  const db = tmpDb()
  let workflowId = ''; let startedAt = ''
  {
    const store = openControlStore({ path: db })
    const rt = mkRt(store, new ScriptedFake(store, doneScript))
    workflowId = (await rt.createWorkflow(pausedSpec('input'), { objective: 'x' })).workflow_id
    await rt.startWorkflow(workflowId)
    for (let i = 0; i < 20 && (await store.getWorkflow(workflowId))!.status !== 'waiting_input'; i++) await sleep(20)
    startedAt = (await store.getWorkflow(workflowId))!.started_at!
    await rt.answerInput(humanRequestId(gateExecId(workflowId)), 'v')
    await rt.shutdown(); store.closeSync()
  }
  // Restart, resume twice (idempotent), and complete.
  const store = openControlStore({ path: db })
  try {
    const fake = new ScriptedFake(store, doneScript)
    const rt = mkRt(store, fake)
    await rt.resumeWorkflow(workflowId)
    await rt.resumeWorkflow(workflowId) // idempotent re-drive
    await rt.awaitWorkflow(workflowId)
    const wf = (await store.getWorkflow(workflowId))!
    assert.equal(wf.status, 'completed')
    assert.equal(wf.started_at, startedAt, 'started_at not reset by resume')
    const steps = await store.listStepExecutions(workflowId)
    assert.equal(steps.filter((s) => s.step_id === 'gate').length, 1, 'no duplicate gate step')
    assert.equal(wf.total_tasks, 2, 'exactly two tasks (gate + finish), no duplication')
  } finally { store.closeSync() }
})
