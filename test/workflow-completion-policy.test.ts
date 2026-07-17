/**
 * Workflow Runtime COMPLETION POLICY + verified-evidence acceptance. An agent's
 * requested `$complete` is a CLAIM — with a declared `completion_policy`, the runtime
 * must verify SYSTEM-OBSERVED evidence (authoritative task status, process exit code,
 * AgentTaskResult content hash + provider-structured evidence refs, and the workspace
 * revision observed before/after the step) before completing. Missing evidence →
 * blocked (verification_required); conflicting evidence → fail closed. Agent prose /
 * `tests_run` claims are never treated as verified evidence. Internal runtime only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { stepExecutionId } from '../src/workflow/recovery.js'
import { type AgentTaskClient, type AgentTaskCreateRequest } from '../src/workflow/task-client.js'
import { type WorkspaceLeaseClient } from '../src/workflow/workspace-lease-client.js'
import { workspaceLeaseId, type WorkspaceLeaseV1, type WorkspaceRevision } from '../src/lib/workspace-lease.js'
import { buildTaskResult, type EvidenceRef } from '../src/lib/agent-task-result.js'
import { buildTaskVerification, type TaskVerificationV1 } from '../src/lib/task-verification.js'
import { evaluateCompletion, assembleEvidence } from '../src/workflow/completion-policy.js'
import { WORKFLOW_EVENT_CONTRACT_VERSION } from '../src/workflow/contract.js'
import type { WorkflowSpec, CompletionPolicy } from '../src/workflow/contract.js'

const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cp-')), 'control.sqlite')
const gitRev = (seed: string): WorkspaceRevision => ({ revision_kind: 'git', head_commit: '0'.repeat(40), dirty: false, state_hash: crypto.createHash('sha256').update(seed).digest('hex'), changed_files: seed === 'after' ? ['a.ts'] : [], observed_at: iso() })
// Harness-owned verification records: the ONLY source of tests_passed/tests_failed.
const PASSED_VERIFICATION: TaskVerificationV1 = buildTaskVerification({ profile: 'node-test', argv: ['node', '--test'], exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', output: 'suite green' })

// ── fake Gateway that persists a durable AgentTaskResult (exit code + evidence) ──
interface TaskDesc { output: Record<string, unknown>; exitCode?: number; evidence?: EvidenceRef[]; verification?: TaskVerificationV1 }
class ScriptedFake implements AgentTaskClient {
  byKey = new Map<string, any>(); byId = new Map<string, any>(); creates: AgentTaskCreateRequest[] = []; n = 0
  constructor(public store: SqliteControlStore, private script: (r: AgentTaskCreateRequest) => TaskDesc) {}
  async createTask(req: AgentTaskCreateRequest): Promise<{ task_id: string }> {
    this.creates.push(req)
    const ex = this.byKey.get(req.idempotency_key); if (ex) return { task_id: ex.task_id }
    const d = this.script(req); const task_id = 'task_' + (++this.n)
    this.store.createTaskDurable({ task_id, agent: req.agent, node_id: req.node_id ?? null, status: 'queued', idempotency_key: req.idempotency_key, request_fingerprint: 'fp:' + req.idempotency_key }, { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
    // Persist the durable AgentTaskResult, exactly as the real Gateway would.
    const text = JSON.stringify(d.output)
    const result = buildTaskResult({ text, processExitCode: d.exitCode ?? 0, evidenceRefs: d.evidence ?? [], ...(d.verification ? { verification: d.verification } : {}) })
    this.store.terminalizeTaskWithResultDurable(task_id, 1, { status: 'completed' }, { sequence: 1, event_type: 'task.completed', ts: iso(), payload: {} }, 'available', result)
    const t = { task_id, req, ...d, key: req.idempotency_key, text }; this.byKey.set(req.idempotency_key, t); this.byId.set(task_id, t); return { task_id }
  }
  private view(t: any) { return { status: 'completed', terminal: true, history_complete: true, result_status: 'available', result_text: t.text, events: [], next_event_id: -1 } }
  async getTask(id: string) { return { task_id: id, ...this.view(this.byId.get(id)) } }
  async waitForTerminal(id: string) { await sleep(4); return { task_id: id, ...this.view(this.byId.get(id)) } }
  async cancelTask(): Promise<void> { /* */ }
}

// A fake lease client whose before/after revisions differ (simulating a repo change).
class ChangeLeaseClient implements WorkspaceLeaseClient {
  private obs = 0
  async acquire(nodeId: string, workflowId: string, workspaceKey: string): Promise<{ lease: WorkspaceLeaseV1; created: boolean }> {
    return { lease: { workspace_lease_id: workspaceLeaseId(workflowId, nodeId, workspaceKey), workflow_id: workflowId, node_id: nodeId, workspace_key: workspaceKey, mode: 'exclusive', status: 'active', base_revision: gitRev('before'), current_revision: gitRev('before'), acquired_at: iso() }, created: true }
  }
  async get(nodeId: string, leaseId: string): Promise<WorkspaceLeaseV1 | null> { return { workspace_lease_id: leaseId, workflow_id: '', node_id: nodeId, workspace_key: '', mode: 'exclusive', status: 'active', base_revision: gitRev('before'), current_revision: gitRev('before'), acquired_at: iso() } }
  // first observe (before task) = 'before'; subsequent (after task) = 'after' → a change.
  async observeRevision(): Promise<WorkspaceRevision> { return gitRev(this.obs++ === 0 ? 'before' : 'after') }
  async release(_n: string, leaseId: string): Promise<WorkspaceLeaseV1> { return { workspace_lease_id: leaseId, workflow_id: '', node_id: _n, workspace_key: '', mode: 'exclusive', status: 'released' } }
}

/** A one-step workflow: `review` requests $complete; the completion_policy gates it. */
const policySpec = (policy: CompletionPolicy, opts: { node?: boolean } = {}): WorkflowSpec => ({
  version: '1', name: 'cp', entry_step: 'review',
  inputs: { objective: { type: 'string', required: true }, ...(opts.node ? { workspace_key: { type: 'string', required: true } } : {}) },
  agents: { rev: { agent: 'mock', ...(opts.node ? { node_id: 'node_x' } : {}) } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['complete'] }, summary: { type: 'string', required: true }, remaining_work: { type: 'string[]', required: false }, tests_run: { type: 'string[]', required: false } } } },
  limits: { max_tasks: 3, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 2 },
  steps: [{ id: 'review', type: 'agent_task', agent_role: 'rev', prompt_template: 'Review {{ inputs.objective }}', output_schema: 'o', ...(opts.node ? { workspace_key_template: '{{ inputs.workspace_key }}' } : {}) }],
  edges: [{ from: 'review', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'complete' } }],
  completion_policy: policy,
})

async function withStore(fn: (store: SqliteControlStore) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  try { await fn(store) } finally { try { store.closeSync() } catch { /* */ } }
}
const mkRt = (store: SqliteControlStore, task: AgentTaskClient, lease?: WorkspaceLeaseClient) => new WorkflowRuntime({ store, taskClient: task, leaseClient: lease, waitWindowMs: 20, backoffBaseMs: 3, backoffMaxMs: 10 })
const reviewExec = (wf: string) => stepExecutionId(wf, 'review', 1, 1)

// ── pure evaluator (unit) ──────────────────────────────────────────────────────

test('unit: evaluateCompletion — satisfied/complete, missing/blocked, conflicting/fail; tests never inferred', () => {
  const base: import('../src/workflow/completion-policy.js').VerifiedEvidence = { task_status: 'completed', exit_code: 0, content_hash: 'h', revision_before: 'a', revision_after: 'b', repository_changed: true, changed_files: ['a.ts'], changed_files_hash: 'x', tests_passed: null }
  // satisfied
  assert.deepEqual(evaluateCompletion({ required_evidence: ['task_status', 'exit_code'] }, { ...base }, null), { decision: 'complete' })
  // missing tests evidence → blocked (NOT inferred from a repo change or prose)
  assert.equal(evaluateCompletion({ require_tests_passed: true }, { ...base, tests_passed: null }, null).decision, 'blocked')
  // provider says tests failed → conflict → fail
  assert.equal(evaluateCompletion({ require_tests_passed: true }, { ...base, tests_passed: false }, null).decision, 'failed')
  // required repository change not observed → blocked
  assert.equal(evaluateCompletion({ require_repository_change: true }, { ...base, repository_changed: false }, null).decision, 'blocked')
  // conflicting task status / nonzero exit → fail
  assert.equal(evaluateCompletion({}, { ...base, task_status: 'failed' }, null).decision, 'failed')
  assert.equal(evaluateCompletion({}, { ...base, exit_code: 2 }, null).decision, 'failed')
  // remaining work declared → blocked
  assert.equal(evaluateCompletion({ require_no_remaining_work: true }, { ...base }, [{ item: 'x' }]).decision, 'blocked')
  // assembleEvidence: repository_changed is SYSTEM-derived from revisions (before != after)
  const ev = assembleEvidence({ taskStatus: 'completed', result: buildTaskResult({ text: '{}', processExitCode: 0, verification: PASSED_VERIFICATION }), revisionBefore: gitRev('before'), revisionAfter: gitRev('after') })
  assert.equal(ev.repository_changed, true); assert.equal(ev.tests_passed, true); assert.equal(ev.exit_code, 0)
})

// ── runtime acceptance ─────────────────────────────────────────────────────────

test('reviewer requests complete with SUFFICIENT evidence → completed (exactly one completion event)', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done' }, exitCode: 0, verification: PASSED_VERIFICATION }))
    const rt = mkRt(store, fake)
    const wf = (await rt.createWorkflow(policySpec({ required_evidence: ['task_status', 'exit_code', 'content_hash'], require_tests_passed: true }), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'completed')
    const evs = (await store.listWorkflowEvents(wf)).map((e) => e.event_type)
    assert.equal(evs.filter((e) => e === 'workflow.completed').length, 1, 'completion event exactly once')
    const evidence = (await store.getCompletionEvidence(reviewExec(wf)))!
    assert.equal(evidence.decision, 'complete'); assert.equal((evidence.evidence as any).tests_passed, true)
  })
})

test('completion BLOCKED (verification_required) when required evidence is missing — no completion', async () => {
  await withStore(async (store) => {
    // policy requires tests_passed but the result carries NO test evidence
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done' }, exitCode: 0, evidence: [] }))
    const rt = mkRt(store, fake)
    const wf = (await rt.createWorkflow(policySpec({ require_tests_passed: true }), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    const rec = (await store.getWorkflow(wf))!
    assert.equal(rec.status, 'blocked')
    const blocked = (await store.listWorkflowEvents(wf)).find((e) => e.event_type === 'workflow.blocked')!
    assert.equal((blocked.payload as any).reason, 'verification_required')
    assert.ok((blocked.payload as any).missing.includes('tests_passed'))
    assert.equal((await store.getCompletionEvidence(reviewExec(wf)))!.decision, 'blocked')
  })
})

test('agent CLAIMS tests passed (tests_run) but NO verified test evidence → blocked (prose is not evidence)', async () => {
  await withStore(async (store) => {
    // the output declares tests_run (a CLAIM) but the durable result has no tests_passed ref
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done', tests_run: ['t1', 't2'] }, exitCode: 0, evidence: [] }))
    const rt = mkRt(store, fake)
    const wf = (await rt.createWorkflow(policySpec({ require_tests_passed: true }), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'blocked', 'a tests_run claim does not satisfy require_tests_passed')
    assert.equal((await store.getCompletionEvidence(reviewExec(wf)))!.decision, 'blocked')
  })
})

test('repository-change evidence is SYSTEM-OWNED (from before/after revisions, not agent claims)', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done' }, exitCode: 0 }))
    const rt = mkRt(store, fake, new ChangeLeaseClient())
    const wf = (await rt.createWorkflow(policySpec({ require_repository_change: true }, { node: true }), { objective: 'x', workspace_key: 'proj' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'completed', 'a real before≠after revision satisfies require_repository_change')
    const ev = (await store.getCompletionEvidence(reviewExec(wf)))!.evidence as any
    assert.equal(ev.repository_changed, true)
    assert.notEqual(ev.revision_before, ev.revision_after, 'the change is derived from system-observed revisions')
  })
})

test('restart PRESERVES evidence and does not re-complete; completion event stays exactly once', async () => {
  const db = tmpDb()
  let wf = ''
  {
    const store = openControlStore({ path: db })
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done' }, exitCode: 0, verification: PASSED_VERIFICATION }))
    const rt = mkRt(store, fake)
    wf = (await rt.createWorkflow(policySpec({ require_tests_passed: true }), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'completed')
    await rt.shutdown(); store.closeSync()
  }
  const store = openControlStore({ path: db })
  try {
    // evidence persisted
    assert.equal((await store.getCompletionEvidence(reviewExec(wf)))!.decision, 'complete')
    // recovery does not re-drive/re-complete a terminal workflow
    const rt = mkRt(store, new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done' }, exitCode: 0, verification: PASSED_VERIFICATION })))
    await rt.recoverWorkflows()
    await sleep(60)
    assert.equal((await store.getWorkflow(wf))!.status, 'completed')
    assert.equal((await store.listWorkflowEvents(wf)).filter((e) => e.event_type === 'workflow.completed').length, 1, 'still exactly one completion event')
  } finally { store.closeSync() }
})

test('conflicting evidence FAILS CLOSED: a non-zero process exit with a requested complete', async () => {
  await withStore(async (store) => {
    const fake = new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done' }, exitCode: 3 }))
    const rt = mkRt(store, fake)
    const wf = (await rt.createWorkflow(policySpec({ required_evidence: ['exit_code'] }), { objective: 'x' })).workflow_id
    await rt.startWorkflow(wf); await rt.awaitWorkflow(wf)
    assert.equal((await store.getWorkflow(wf))!.status, 'failed')
    const failed = (await store.listWorkflowEvents(wf)).find((e) => e.event_type === 'workflow.failed')!
    assert.equal((failed.payload as any).reason, 'evidence_conflict_nonzero_exit')
  })
})

test('a NEW completable spec WITHOUT a completion_policy is REJECTED at create', async () => {
  await withStore(async (store) => {
    const spec = policySpec({}); delete (spec as any).completion_policy // completable ($complete) + no policy
    const rt = mkRt(store, new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done' } })))
    await assert.rejects(() => rt.createWorkflow(spec, { objective: 'x' }), (e: any) => e.code === 'completion_policy_required')
  })
})

test('a NON-completable spec (no $complete route) may OMIT the completion_policy', async () => {
  await withStore(async (store) => {
    const spec: WorkflowSpec = {
      version: '1', name: 'noncompletable', entry_step: 'review', inputs: { objective: { type: 'string', required: true } },
      agents: { rev: { agent: 'mock' } }, output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['blocked'] }, summary: { type: 'string', required: true } } } },
      limits: { max_tasks: 3, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 2 },
      steps: [{ id: 'review', type: 'agent_task', agent_role: 'rev', prompt_template: 'x', output_schema: 'o' }],
      edges: [{ from: 'review', to: '$blocked', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'blocked' } }],
    }
    const rt = mkRt(store, new ScriptedFake(store, () => ({ output: { status: 'blocked', summary: 's' } })))
    const r = await rt.createWorkflow(spec, { objective: 'x' }) // must NOT throw
    assert.ok(r.workflow_id)
  })
})

test('a LEGACY policy-less completable workflow completes only as legacy_unverified (never verified)', async () => {
  await withStore(async (store) => {
    // Simulate a workflow persisted BEFORE the completion-policy rule (bypass create validation).
    const spec = policySpec({}); delete (spec as any).completion_policy
    const workflowId = 'wf_' + crypto.randomBytes(9).toString('hex'); const ts = iso(); const CV = WORKFLOW_EVENT_CONTRACT_VERSION
    await store.createWorkflowWithLifecycleEvents(
      { workflow_id: workflowId, spec_version: '1', workflow_name: spec.name, spec, input_values: { objective: 'x' } },
      { objective: 'x', current_round: 1 },
      { event_type: 'workflow.created', ts, payload: { name: spec.name }, contract_version: CV } as any,
      { event_type: 'workflow.validated', ts, payload: {}, contract_version: CV } as any,
    )
    const rt = mkRt(store, new ScriptedFake(store, () => ({ output: { status: 'complete', summary: 'done' } })))
    await rt.startWorkflow(workflowId); await rt.awaitWorkflow(workflowId)
    assert.equal((await store.getWorkflow(workflowId))!.status, 'completed')
    const completed = (await store.listWorkflowEvents(workflowId)).find((e) => e.event_type === 'workflow.completed')!
    assert.equal((completed.payload as any).legacy_unverified, true, 'marked legacy_unverified')
    assert.notEqual((completed.payload as any).verified, true, 'NEVER verified: true')
    assert.equal(await store.getCompletionEvidence(reviewExec(workflowId)), null, 'no verified-evidence gate ran for a legacy completion')
  })
})
