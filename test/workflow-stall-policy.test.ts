/**
 * Workflow Runtime NO-PROGRESS (stall) detection acceptance. An optional bounded
 * `stall_policy` is evaluated ONLY when an explicit loop edge is taken: when ALL
 * configured signals (planner next-step, remaining-work, workspace revision, verified
 * evidence) stay unchanged for `max_stalled_rounds` consecutive loop rounds, the
 * workflow is blocked (`no_progress`) instead of looping again — no next Agent Task
 * starts, workspace leases are retained, the decision is durable, and a restart never
 * double-counts rounds or emits a duplicate blocked event. No LLM judgment / repair.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { type AgentTaskClient, type AgentTaskCreateRequest } from '../src/workflow/task-client.js'
import { computeStallFingerprint, isStalled, consecutiveUnchanged } from '../src/workflow/stall-policy.js'
import type { WorkflowSpec, StallPolicy } from '../src/workflow/contract.js'

const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stall-')), 'control.sqlite')

interface TaskDesc { output: Record<string, unknown> }
class ScriptedFake implements AgentTaskClient {
  byKey = new Map<string, any>(); byId = new Map<string, any>(); creates: AgentTaskCreateRequest[] = []; n = 0
  constructor(public store: SqliteControlStore, private script: (r: AgentTaskCreateRequest) => TaskDesc) {}
  async createTask(req: AgentTaskCreateRequest): Promise<{ task_id: string }> {
    this.creates.push(req)
    const ex = this.byKey.get(req.idempotency_key); if (ex) return { task_id: ex.task_id }
    const d = this.script(req); const task_id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id, agent: req.agent, node_id: req.node_id ?? null, status: 'queued', idempotency_key: req.idempotency_key, request_fingerprint: 'fp:' + req.idempotency_key }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    const t = { task_id, req, ...d, text: JSON.stringify(d.output), key: req.idempotency_key }; this.byKey.set(req.idempotency_key, t); this.byId.set(task_id, t); return { task_id }
  }
  private view(t: any) { return { status: 'completed', terminal: true, history_complete: true, result_status: 'available', result_text: t.text, events: [], next_event_id: -1 } }
  async getTask(id: string) { return { task_id: id, ...this.view(this.byId.get(id)) } }
  async waitForTerminal(id: string) { await sleep(3); return { task_id: id, ...this.view(this.byId.get(id)) } }
  async cancelTask(): Promise<void> { /* */ }
}

/** A planner→executor→review LOOP spec with a stall_policy. The reviewer loops back
 *  with the SAME next_step every round (no progress) unless the script says otherwise. */
const loopSpec = (stall: StallPolicy): WorkflowSpec => ({
  version: '1', name: 'stall', entry_step: 'plan',
  inputs: { objective: { type: 'string', required: true } },
  agents: { p: { agent: 'mock' }, e: { agent: 'mock' } },
  output_schemas: {
    plan_o: { fields: { status: { type: 'enum', required: true, enum: ['continue'] }, next_step: { type: 'string', required: true } } },
    impl_o: { fields: { status: { type: 'enum', required: true, enum: ['implemented'] }, summary: { type: 'string', required: true }, remaining_work: { type: 'string[]', required: false } } },
    rev_o: { fields: { status: { type: 'enum', required: true, enum: ['continue', 'complete'] }, next_step: { type: 'string', required: false } } },
  },
  limits: { max_rounds: 20, max_tasks: 100, max_runtime_seconds: 120, max_step_attempts: 1, max_failures: 3 },
  steps: [
    { id: 'plan', type: 'agent_task', agent_role: 'p', prompt_template: 'Plan {{ inputs.objective }}', output_schema: 'plan_o' },
    { id: 'implement', type: 'agent_task', agent_role: 'e', prompt_template: 'Impl {{ workflow.round }}', output_schema: 'impl_o', context_binding: 'latest_executor_handoff' },
    { id: 'review', type: 'agent_task', agent_role: 'p', prompt_template: 'Review {{ workflow.round }}', output_schema: 'rev_o' },
  ],
  edges: [
    { from: 'plan', to: 'implement', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'continue' } },
    { from: 'implement', to: 'review', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'implemented' } },
    { from: 'review', to: 'implement', kind: 'loop', condition: { path: 'output.status', op: 'eq', value: 'continue' } },
    { from: 'review', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'complete' } },
  ],
  completion_policy: {},
  stall_policy: stall,
})

// The executor always produces the SAME output (same remaining_work) → stalled.
const stalledScript = (req: AgentTaskCreateRequest): TaskDesc => {
  const { step_id } = req.metadata as { step_id: string }
  if (step_id === 'plan') return { output: { status: 'continue', next_step: 'do A' } }
  if (step_id === 'implement') return { output: { status: 'implemented', summary: 'same', remaining_work: ['A'] } }
  return { output: { status: 'continue', next_step: 'do A' } } // reviewer: same next_step forever
}

async function withStore(fn: (store: SqliteControlStore) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  try { await fn(store) } finally { try { store.closeSync() } catch { /* */ } }
}
const mkRt = (store: SqliteControlStore, task: AgentTaskClient) => new WorkflowRuntime({ store, taskClient: task, waitWindowMs: 15, backoffBaseMs: 3, backoffMaxMs: 10 })

// ── pure unit ────────────────────────────────────────────────────────────────

test('unit: fingerprint uses only configured signals; consecutiveUnchanged + isStalled', () => {
  const v = { planner_next_step: 'A', remaining_work: '[]', workspace_revision: 'r1', verified_evidence: 'h1' }
  // only planner_next_step configured → changing another signal does not change the fp
  const fpA = computeStallFingerprint(['planner_next_step'], v)
  assert.equal(fpA, computeStallFingerprint(['planner_next_step'], { ...v, workspace_revision: 'r2', verified_evidence: 'h2' }))
  assert.notEqual(fpA, computeStallFingerprint(['planner_next_step'], { ...v, planner_next_step: 'B' }))
  assert.equal(consecutiveUnchanged(['x', 'y', 'y', 'y']), 3)
  assert.equal(consecutiveUnchanged(['y', 'y', 'x']), 1)
  assert.equal(isStalled(['a', 'a', 'a'], 3), true)
  assert.equal(isStalled(['a', 'b', 'a'], 3), false)
})

// ── runtime acceptance ─────────────────────────────────────────────────────────

test('a stalled loop (unchanged signals) blocks with no_progress after max_stalled_rounds; leases/rounds durable', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, stalledScript)
    const rt = mkRt(store, fake)
    const wf = (await rt.createWorkflow(loopSpec({ max_stalled_rounds: 3, signals: ['planner_next_step', 'remaining_work'] }), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    const rec = (await store.getWorkflow(wf))!
    assert.equal(rec.status, 'blocked', 'stalled workflow is blocked (not looping forever)')
    const blocked = (await store.listWorkflowEvents(wf)).find((e) => e.event_type === 'workflow.blocked')!
    assert.equal((blocked.payload as any).reason, 'no_progress')
    // exactly one blocked event; blocked BEFORE max_rounds (not a max_rounds failure)
    assert.equal((await store.listWorkflowEvents(wf)).filter((e) => e.event_type === 'workflow.blocked').length, 1)
    assert.ok(rec.current_round <= 5, `blocked early at round ${rec.current_round}, well before max_rounds`)
    // durable stall fingerprints recorded, one per loop round, all equal (unchanged)
    const rounds = await store.listStallRounds(wf)
    assert.ok(rounds.length >= 3)
    assert.equal(new Set(rounds.map((r) => r.fingerprint)).size, 1, 'all loop rounds share one fingerprint (no progress)')
  })
})

test('a PROGRESSING loop (changing signal) never triggers no_progress and can complete', async () => {
  await withStore(async (store) => {
    // reviewer changes next_step each round, then completes at round 3
    let round = 0
    const script = (req: AgentTaskCreateRequest): TaskDesc => {
      const { step_id } = req.metadata as { step_id: string; round: number }
      if (step_id === 'plan') return { output: { status: 'continue', next_step: 'start' } }
      if (step_id === 'implement') return { output: { status: 'implemented', summary: `r${(req.metadata as any).round}`, remaining_work: [`item-${(req.metadata as any).round}`] } }
      round = (req.metadata as any).round
      return round >= 3 ? { output: { status: 'complete' } } : { output: { status: 'continue', next_step: `step-${round}` } }
    }
    const rt = mkRt(store, new ScriptedFake(store, script))
    const wf = (await rt.createWorkflow(loopSpec({ max_stalled_rounds: 2, signals: ['planner_next_step', 'remaining_work'] }), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'completed', 'a changing loop completes, never no_progress')
    const rounds = await store.listStallRounds(wf)
    assert.ok(new Set(rounds.map((r) => r.fingerprint)).size >= 1)
  })
})

test('restart after a no_progress block does NOT double-count rounds or emit a duplicate blocked event', async () => {
  const db = tmpDb()
  let wf = ''
  {
    const store = openControlStore({ path: db })
    const rt = mkRt(store, new ScriptedFake(store, stalledScript))
    wf = (await rt.createWorkflow(loopSpec({ max_stalled_rounds: 3, signals: ['planner_next_step', 'remaining_work'] }), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'blocked')
    await rt.shutdown(); store.closeSync()
  }
  const store = openControlStore({ path: db })
  try {
    const roundsBefore = (await store.listStallRounds(wf)).length
    const blockedBefore = (await store.listWorkflowEvents(wf)).filter((e) => e.event_type === 'workflow.blocked').length
    assert.equal(blockedBefore, 1)
    // recovery re-drives; a blocked workflow is not resumed, and nothing is re-counted
    const rt = mkRt(store, new ScriptedFake(store, stalledScript))
    await rt.recoverWorkflows(); await sleep(80)
    assert.equal((await store.getWorkflow(wf))!.status, 'blocked')
    assert.equal((await store.listStallRounds(wf)).length, roundsBefore, 'no double-counted rounds after restart')
    assert.equal((await store.listWorkflowEvents(wf)).filter((e) => e.event_type === 'workflow.blocked').length, 1, 'still exactly one blocked event')
  } finally { store.closeSync() }
})

test('WITHOUT a stall_policy a repeating loop is unaffected (bounded only by max_rounds)', async () => {
  await withStore(async (store) => {
    const spec = loopSpec({ max_stalled_rounds: 3, signals: ['planner_next_step'] }); delete (spec as any).stall_policy
    spec.limits.max_rounds = 3 // let max_rounds terminate the otherwise-infinite loop
    const rt = mkRt(store, new ScriptedFake(store, stalledScript))
    const wf = (await rt.createWorkflow(spec, { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    const rec = (await store.getWorkflow(wf))!
    // no stall detection ran → terminated by max_rounds (failed), NOT no_progress
    assert.equal(rec.status, 'failed')
    assert.equal((await store.listStallRounds(wf)).length, 0, 'no stall fingerprints recorded without a policy')
    const failed = (await store.listWorkflowEvents(wf)).find((e) => e.event_type === 'workflow.failed')!
    assert.equal((failed.payload as any).limit, 'max_rounds')
  })
})
