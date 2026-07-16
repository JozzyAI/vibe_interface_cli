/**
 * Workflow Runtime behavior + durable crash-recovery over an isolated TEMPORARY
 * ControlStore and a deterministic FAKE AgentTaskClient (which faithfully persists
 * the durable task row the real Gateway would). Covers the happy planner/executor
 * loop, looping/limits, idempotency, recovery boundaries, failure/block/cancel,
 * and persistence. Never touches production or a real relay/node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { plannerExecutorLoopExample } from '../src/workflow/examples.js'
import { stepExecutionId } from '../src/workflow/recovery.js'
import { TransientAgentTaskError, type AgentTaskClient, type AgentTaskCreateRequest } from '../src/workflow/task-client.js'
import type { ControlStore } from '../src/control/store.js'

const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-rt-')), 'control.sqlite')

interface TaskDesc { output?: Record<string, unknown>; status?: string; history_complete?: boolean; running?: boolean; result_status?: string; result_text?: string }
type Script = (req: AgentTaskCreateRequest) => TaskDesc

/** A deterministic fake Gateway: dedupes by idempotency_key, persists the durable
 *  task row (so the step FK holds, exactly as the real Gateway does), and serves
 *  scripted canonical output. Records every call for assertions. */
class ScriptedFake implements AgentTaskClient {
  byKey = new Map<string, any>()
  byId = new Map<string, any>()
  creates: AgentTaskCreateRequest[] = []
  cancels: string[] = []
  n = 0
  constructor(public store: SqliteControlStore, private script: Script) {}
  program(s: Script): void { this.script = s }
  releaseAll(): void { for (const t of this.byId.values()) t.released = true }

  async createTask(req: AgentTaskCreateRequest): Promise<{ task_id: string }> {
    this.creates.push(req)
    const existing = this.byKey.get(req.idempotency_key)
    if (existing) return { task_id: existing.task_id }
    const d = this.script(req)
    const task_id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id, agent: req.agent, node_id: req.node_id ?? null, status: 'queued', idempotency_key: req.idempotency_key, request_fingerprint: 'fp:' + req.idempotency_key }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    const t = { task_id, req, ...d, released: !d.running, key: req.idempotency_key }
    this.byKey.set(req.idempotency_key, t); this.byId.set(task_id, t)
    return { task_id }
  }
  private view(t: any) {
    const running = t.running && !t.released
    const status = running ? 'running' : (t.status ?? 'completed')
    const terminal = !running && ['completed', 'failed', 'cancelled'].includes(status)
    // Misleading event-history text: a DIFFERENT JSON object than the first-class
    // result — the runtime must route on result_text, not on these events.
    const events = (!running && t.output !== undefined) ? [{ type: 'agent.output.delta', payload: { stream: 'stdout', text: JSON.stringify({ status: 'MISLEADING', from: 'events' }) } }, { type: 'task.completed', payload: {} }] : []
    // First-class AgentTaskResult: available (result_text = the scripted output) unless
    // the descriptor overrides result_status (missing/invalid).
    let result_status: string | undefined; let result_text: string | undefined
    if (!running && status === 'completed') {
      result_status = t.result_status ?? (t.output !== undefined ? 'available' : 'missing')
      if (result_status === 'available' && t.output !== undefined) result_text = t.result_text ?? JSON.stringify(t.output)
    }
    return { status, terminal, history_complete: t.history_complete !== false, events, result_status, result_text }
  }
  async getTask(id: string) { const v = this.view(this.byId.get(id)); return { task_id: id, status: v.status, terminal: v.terminal, history_complete: v.history_complete, result_status: v.result_status, result_text: v.result_text } }
  async waitForTerminal(id: string) {
    const t = this.byId.get(id); const v = this.view(t)
    if (!v.terminal) await sleep(15) // simulate a bounded wait window (avoid a busy loop)
    return { task_id: id, status: v.status, terminal: v.terminal, history_complete: v.history_complete, result_status: v.result_status, result_text: v.result_text, events: v.events, next_event_id: v.events.length - 1 }
  }
  async cancelTask(id: string): Promise<void> {
    this.cancels.push(id)
    const t = this.byId.get(id)
    if (t && t.running && !t.released) { t.status = 'cancelled'; t.released = true } // running → cancelled; a completed task stays completed
  }
}

/** Script for the canonical planner/executor acceptance (2 rounds → complete). */
const acceptanceScript: Script = (req) => {
  const { step_id, round } = req.metadata as { step_id: string; round: number }
  if (step_id === 'plan') return { output: { status: 'continue', summary: 'plan', next_step: 'Implement part A', acceptance_criteria: ['a'] } }
  if (step_id === 'implement' && round === 1) return { output: { status: 'implemented', summary: 'Part A complete', changed_files: ['a.ts'], tests_run: ['t1'], remaining_work: [], risks: [] } }
  if (step_id === 'review' && round === 1) return { output: { status: 'continue', summary: 'partial', next_step: 'Implement part B' } }
  if (step_id === 'implement' && round === 2) return { output: { status: 'implemented', summary: 'Part B complete', changed_files: ['b.ts'], tests_run: ['t2'], remaining_work: [], risks: [] } }
  if (step_id === 'review' && round === 2) return { output: { status: 'complete', summary: 'done' } }
  throw new Error(`no script for ${step_id} r${round}`)
}

async function withStore(fn: (store: SqliteControlStore) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  try { await fn(store) } finally { try { store.closeSync() } catch { /* */ } }
}

const eventTypes = async (store: ControlStore, id: string) => (await store.listWorkflowEvents(id)).map((e) => e.event_type)

// ── deterministic planner/executor acceptance ─────────────────────────────────

test('acceptance: planner→executor→review loop reaches completed with correct identity, context, counters', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, acceptanceScript)
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'Build a thing' })
    await rt.startWorkflow(workflow_id)
    await rt.awaitWorkflow(workflow_id)

    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'completed')
    assert.equal(wf.current_round, 2)            // round advanced exactly once
    assert.equal(wf.total_tasks, 5)              // five durable task identities
    assert.equal(wf.total_failures, 0)

    const steps = await store.listStepExecutions(workflow_id)
    assert.equal(steps.length, 5)                // five distinct step executions
    assert.equal(new Set(steps.map((s) => s.task_id)).size, 5)
    // every task call used its step_execution_id as the idempotency_key
    assert.ok(steps.every((s) => fake.byId.get(s.task_id!)?.key === s.step_execution_id))
    // the second executor received the reviewer's next_step
    const implR2 = steps.find((s) => s.step_id === 'implement' && s.round === 2)!
    assert.ok(fake.byId.get(implR2.task_id!)?.req.input.text.includes('Implement part B'))
    // context carries the latest planner decision + executor handoff
    const snap = (await store.getWorkflowSnapshot(workflow_id))!
    assert.equal((snap.context as any).latest_planner_decision.status, 'complete')
    assert.equal((snap.context as any).latest_executor_handoff.status, 'implemented')
    // exactly one terminal workflow event
    const evs = await eventTypes(store, workflow_id)
    assert.equal(evs.filter((e) => e === 'workflow.completed').length, 1)
    assert.equal(evs.filter((e) => e === 'workflow.round_advanced').length, 1)
    // dominated step output still referenceable downstream (plan.output.summary in implement r1 prompt)
    const implR1 = steps.find((s) => s.step_id === 'implement' && s.round === 1)!
    assert.ok(fake.byId.get(implR1.task_id!)?.req.input.text.includes('plan'))
  })
})

// ── looping + limits ──────────────────────────────────────────────────────────

test('limits: max_rounds includes round 1 and prevents an extra task/round', async () => {
  await withStore(async (store) => {
    // reviewer always says continue → would loop forever; max_rounds caps it.
    const script: Script = (req) => {
      const { step_id } = req.metadata as { step_id: string }
      if (step_id === 'plan') return { output: { status: 'continue', summary: 'p', next_step: 'go' } }
      if (step_id === 'implement') return { output: { status: 'implemented', summary: 'i', changed_files: [], tests_run: [], remaining_work: [], risks: [] } }
      return { output: { status: 'continue', summary: 'r', next_step: 'again' } } // review always continues
    }
    const fake = new ScriptedFake(store, script)
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const spec = plannerExecutorLoopExample(); spec.limits.max_rounds = 2
    const { workflow_id } = await rt.createWorkflow(spec, { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'failed')
    assert.equal(wf.current_round, 2) // reached round 2, could not loop to round 3
    const failed = (await store.listWorkflowEvents(workflow_id)).find((e) => e.event_type === 'workflow.failed')!
    assert.equal((failed.payload as any).limit, 'max_rounds')
  })
})

test('limits: max_tasks fails before creating the task that would exceed it', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, acceptanceScript)
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const spec = plannerExecutorLoopExample(); spec.limits.max_tasks = 2
    const { workflow_id } = await rt.createWorkflow(spec, { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'failed')
    assert.equal(wf.total_tasks, 2) // exactly max_tasks bound; the 3rd was never created
    assert.equal(fake.n, 2)         // no backend beyond the limit
    const failed = (await store.listWorkflowEvents(workflow_id)).find((e) => e.event_type === 'workflow.failed')!
    assert.equal((failed.payload as any).limit, 'max_tasks')
  })
})

// ── failure / block / cancel ──────────────────────────────────────────────────

test('invalid structured output fails the step + workflow and increments total_failures once', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, () => ({ output: { status: 'not-an-enum-value', summary: 'x' } })) // planner enum violation
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'failed'); assert.equal(wf.total_failures, 1)
    const evs = await eventTypes(store, workflow_id)
    assert.equal(evs.filter((e) => e === 'step.failed').length, 1)
    assert.equal(evs.filter((e) => e === 'workflow.failed').length, 1)
    // the sanitized failure never contains the raw malformed output
    const failed = (await store.listWorkflowEvents(workflow_id)).find((e) => e.event_type === 'workflow.failed')!
    assert.ok(!JSON.stringify(failed.payload).includes('not-an-enum-value'))
  })
})

test('a terminal Agent Task failure maps to a single step + workflow failure', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, () => ({ status: 'failed' }))
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'failed'); assert.equal(wf.total_failures, 1)
  })
})

test('a missing AgentTaskResult blocks the workflow (never guesses from events)', async () => {
  await withStore(async (store) => {
    // The backend completed but produced no authoritative final result.
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 's' }, result_status: 'missing' }))
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'blocked') // non-terminal, no auto-resume
    const blocked = (await store.listWorkflowEvents(workflow_id)).find((e) => e.event_type === 'workflow.blocked')!
    assert.equal((blocked.payload as any).reason, 'task_result_missing')
    assert.equal(wf.total_tasks, 1) // no further task started
  })
})

test('$blocked is non-terminal and starts no next task', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, () => ({ output: { status: 'blocked', summary: 'need input' } })) // plan → $blocked
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'blocked'); assert.equal(wf.total_tasks, 1)
    const evs = await eventTypes(store, workflow_id)
    assert.equal(evs.filter((e) => e === 'workflow.blocked').length, 1)
  })
})

test('cancellation is idempotent, records intent, and an already-completed task keeps its status', async () => {
  await withStore(async (store) => {
    // plan runs long; we cancel while it is running.
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 's' }, running: true }))
    const rt = new WorkflowRuntime({ store, taskClient: fake, waitWindowMs: 50 })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rt.startWorkflow(workflow_id)
    // wait until the plan task is created + bound
    for (let i = 0; i < 50 && fake.n < 1; i++) await sleep(20)
    await rt.cancelWorkflow(workflow_id)
    const wf1 = (await store.getWorkflow(workflow_id))!
    assert.equal(wf1.status, 'cancelled'); assert.equal(wf1.cancel_requested, true)
    assert.ok(fake.cancels.length >= 1) // the exact current task was cancelled
    // idempotent second cancel
    const wf2 = await rt.cancelWorkflow(workflow_id)
    assert.equal(wf2.status, 'cancelled')
    const evs = await eventTypes(store, workflow_id)
    assert.equal(evs.filter((e) => e === 'workflow.cancelled').length, 1)
  })
})

test('already-completed task wins over a cancellation race (task stays completed)', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 's' } })) // completes immediately
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    // the plan task completed → the workflow completed; a late cancel is a no-op.
    const before = (await store.getWorkflow(workflow_id))!.status
    assert.equal(before, 'completed')
    const wf = await rt.cancelWorkflow(workflow_id)
    assert.equal(wf.status, 'completed') // terminal completed wins; cancel is idempotent no-op
    const planTask = (await store.listStepExecutions(workflow_id))[0].task_id!
    assert.equal(fake.byId.get(planTask).status ?? 'completed', 'completed') // task never force-cancelled
  })
})

// ── idempotency + durable crash recovery ──────────────────────────────────────

test('duplicate start calls coalesce onto one pump', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, acceptanceScript)
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await Promise.all([rt.startWorkflow(workflow_id), rt.startWorkflow(workflow_id), rt.startWorkflow(workflow_id)])
    await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'completed'); assert.equal(wf.total_tasks, 5) // no duplicated executions
    assert.equal((await store.listStepExecutions(workflow_id)).length, 5)
  })
})

test('restart while a task is running does not duplicate the task; recovery completes the workflow', async () => {
  await withStore(async (store) => {
    // plan stays running until released; the rest complete normally.
    let planReleased = false
    const script: Script = (req) => {
      const d = acceptanceScript(req)
      if ((req.metadata as any).step_id === 'plan' && !planReleased) return { ...d, running: true }
      return d
    }
    const fake = new ScriptedFake(store, script)
    const rtA = new WorkflowRuntime({ store, taskClient: fake, waitWindowMs: 30 })
    const { workflow_id } = await rtA.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rtA.startWorkflow(workflow_id)
    for (let i = 0; i < 50 && fake.n < 1; i++) await sleep(20) // wait until the plan task is bound
    const planStep = (await store.getStepExecutionByKey(workflow_id, 'plan', 1, 1))!
    assert.ok(planStep.task_id) // bound
    await rtA.shutdown() // "crash" while the plan task is still running

    planReleased = true; fake.releaseAll()
    const rtB = new WorkflowRuntime({ store, taskClient: fake })
    await rtB.recoverWorkflows(); await rtB.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'completed'); assert.equal(wf.total_tasks, 5)
    // the plan step kept the SAME task_id across the restart (no duplicate backend run)
    assert.equal((await store.getStepExecutionByKey(workflow_id, 'plan', 1, 1))!.task_id, planStep.task_id)
    assert.equal(new Set((await store.listStepExecutions(workflow_id)).map((s) => s.task_id)).size, 5)
  })
})

test('crash before task_id binding returns the SAME task on recovery (one backend start)', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, acceptanceScript)
    // Runtime A: bindStepTaskOnce always throws (transient) → A creates the task but
    // never binds, then we "crash" A. Recovery re-uses the same idempotency_key.
    const crashStore = new Proxy(store, { get(t, p) { if (p === 'bindStepTaskOnce') return async () => { throw new TransientAgentTaskError('crash-before-bind') }; const v: any = (t as any)[p]; return typeof v === 'function' ? v.bind(t) : v } }) as unknown as ControlStore
    const rtA = new WorkflowRuntime({ store: crashStore, taskClient: fake, backoffBaseMs: 5, backoffMaxMs: 10 })
    const { workflow_id } = await rtA.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rtA.startWorkflow(workflow_id)
    for (let i = 0; i < 50 && fake.n < 1; i++) await sleep(20) // A created the gateway task but cannot bind
    await rtA.shutdown()
    const planStep = (await store.getStepExecutionByKey(workflow_id, 'plan', 1, 1))!
    assert.equal(planStep.task_id, null) // never bound before the crash
    const firstTaskId = fake.byKey.get(planStep.step_execution_id)!.task_id
    const createsBefore = fake.n

    const rtB = new WorkflowRuntime({ store, taskClient: fake })
    await rtB.recoverWorkflows(); await rtB.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'completed')
    // the plan step bound the SAME task the crashed runtime had already created
    assert.equal((await store.getStepExecutionByKey(workflow_id, 'plan', 1, 1))!.task_id, firstTaskId)
    assert.equal(fake.n - createsBefore, 4) // only the remaining 4 NEW tasks; plan was reused (one backend start)
  })
})

test('repeated recovery does not double-count tasks/failures/round or re-route', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, acceptanceScript)
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    const { workflow_id } = await rt.createWorkflow(plannerExecutorLoopExample(), { objective: 'x' })
    await rt.startWorkflow(workflow_id); await rt.awaitWorkflow(workflow_id)
    const wf1 = (await store.getWorkflow(workflow_id))!
    // recover repeatedly on a fresh runtime — the workflow is terminal, nothing changes.
    const rt2 = new WorkflowRuntime({ store, taskClient: fake })
    await rt2.recoverWorkflows(); await rt2.recoverWorkflows()
    const wf2 = (await store.getWorkflow(workflow_id))!
    assert.equal(wf2.total_tasks, wf1.total_tasks); assert.equal(wf2.current_round, wf1.current_round)
    assert.equal((await store.listStepExecutions(workflow_id)).length, 5)
  })
})

// ── limits: runtime deadline uses persisted started_at ────────────────────────

test('runtime deadline is measured from persisted started_at and does not reset on restart; no auto task-cancel', async () => {
  await withStore(async (store) => {
    let clock = Date.now() // same wall-clock base as the store's persisted started_at
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 's' }, running: true })) // never completes
    const rt = new WorkflowRuntime({ store, taskClient: fake, waitWindowMs: 20, now: () => clock })
    const spec = plannerExecutorLoopExample(); spec.limits.max_runtime_seconds = 5
    const { workflow_id } = await rt.createWorkflow(spec, { objective: 'x' })
    await rt.startWorkflow(workflow_id)
    for (let i = 0; i < 50 && fake.n < 1; i++) await sleep(20) // plan task running
    clock += 6000 // advance past the 5s deadline
    await rt.awaitWorkflow(workflow_id)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'failed')
    const failed = (await store.listWorkflowEvents(workflow_id)).find((e) => e.event_type === 'workflow.failed')!
    assert.equal((failed.payload as any).limit, 'max_runtime_seconds')
    assert.equal(fake.cancels.length, 0) // the still-running Agent Task is NOT auto-cancelled
  })
})

// ── persistence ───────────────────────────────────────────────────────────────

test('spec + input values + context + step output survive close/reopen and resume', async () => {
  const dbPath = tmpDb()
  let store = openControlStore({ path: dbPath })
  let planReleased = false
  // ONE fake stands in for the durable Gateway across the runtime restart (the real
  // Gateway likewise retains its durable tasks); only its store handle is re-pointed.
  const fake = new ScriptedFake(store, (req) => { const d = acceptanceScript(req); if ((req.metadata as any).step_id === 'plan' && !planReleased) return { ...d, running: true }; return d })
  const rtA = new WorkflowRuntime({ store, taskClient: fake, waitWindowMs: 30 })
  const { workflow_id } = await rtA.createWorkflow(plannerExecutorLoopExample(), { objective: 'Persist me' })
  await rtA.startWorkflow(workflow_id)
  for (let i = 0; i < 50 && fake.n < 1; i++) await sleep(20)
  await rtA.shutdown()
  store.closeSync()

  // reopen the SAME DB in a fresh process-like store; input values + spec persisted.
  store = openControlStore({ path: dbPath })
  assert.equal((await store.getWorkflow(workflow_id))!.input_values!.objective, 'Persist me')
  planReleased = true; fake.releaseAll(); fake.store = store // the "Gateway" retained the plan task; now release it + write to the reopened DB
  const rtB = new WorkflowRuntime({ store, taskClient: fake })
  await rtB.recoverWorkflows(); await rtB.awaitWorkflow(workflow_id)
  const wf = (await store.getWorkflow(workflow_id))!
  assert.equal(wf.status, 'completed')
  const snap = (await store.getWorkflowSnapshot(workflow_id))!
  assert.equal((snap.context as any).latest_planner_decision.status, 'complete')
  store.closeSync()
})

test('malformed persisted spec fails the workflow closed rather than throwing', async () => {
  await withStore(async (store) => {
    const ts = iso()
    // craft a running workflow with a spec that fails validation
    await store.createWorkflowWithLifecycleEvents({ workflow_id: 'wf_bad', spec_version: '1', workflow_name: 'bad', spec: { version: '1', name: 'bad' /* missing agents/steps/etc */ }, input_values: {} }, { objective: 'o', current_round: 1 }, { event_type: 'workflow.created', ts, payload: {} }, { event_type: 'workflow.validated', ts, payload: {} })
    await store.startWorkflowDurably('wf_bad', { event_type: 'workflow.started', ts, payload: {} })
    const fake = new ScriptedFake(store, acceptanceScript)
    const rt = new WorkflowRuntime({ store, taskClient: fake })
    await rt.recoverWorkflows(); await rt.awaitWorkflow('wf_bad')
    assert.equal((await store.getWorkflow('wf_bad'))!.status, 'failed')
    assert.equal(fake.n, 0) // no task ever created for an invalid spec
  })
})

void stepExecutionId
