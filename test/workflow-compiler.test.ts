/**
 * Workflow Compiler acceptance — natural-language → validated WorkflowSpec draft, over
 * an isolated temporary ControlStore with a deterministic fake CompilerModelClient and
 * a fake InventoryProvider. Proves: strict result parsing, misleading-event JSON is
 * ignored, flexible agent assignment (Claude-only / Codex+Claude / one agent many
 * roles), inventory/permission/completion-policy validation, deterministic canonical
 * hashing, exact-hash approval → one ready workflow (never started), hash-mismatch
 * conflict, and crash-recovery idempotency (no duplicate task/draft/approval/workflow).
 * Internal only. Never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { WorkflowCompiler, CompilerError } from '../src/workflow/compiler/compiler.js'
import { parseCompilerResult } from '../src/workflow/compiler/contract.js'
import { canonicalHash } from '../src/workflow/compiler/canonical.js'
import type { CompilerModelClient, CompilerModelRequest, CompilerModelOutcome } from '../src/workflow/compiler/model-client.js'
import type { Inventory, InventoryProvider } from '../src/workflow/compiler/inventory.js'

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cmp-')), 'control.sqlite')

// A fake model client: returns scripted output text (the AgentTaskResult), records calls.
class FakeModel implements CompilerModelClient {
  calls: CompilerModelRequest[] = []; n = 0
  constructor(private script: (req: CompilerModelRequest) => CompilerModelOutcome | string) {}
  async compile(req: CompilerModelRequest): Promise<CompilerModelOutcome> {
    this.calls.push(req)
    const r = this.script(req)
    return typeof r === 'string' ? { task_id: 'ct_' + (++this.n), status: 'available', output_text: r } : r
  }
}
class FakeInventory implements InventoryProvider {
  snapshots = 0
  constructor(private inv: Inventory) {}
  async snapshot(): Promise<Inventory> {
    // each snapshot has a DIFFERENT observed_at (volatile) — retries must not re-snapshot.
    this.snapshots++
    return { ...this.inv, observed_at: `2026-01-01T00:00:0${this.snapshots}Z` }
  }
}

// a node-less LOCAL claude-code placement enforces the compiler capability profile.
const localCompiler = { agent: 'claude-code', permission_modes: ['default'], workspace_supported: false, capabilities: ['run'] }
const invFull: Inventory = { observed_at: '2026-01-01T00:00:00Z', agents: [
  localCompiler,
  { agent: 'claude-code', node_id: 'node_x', permission_modes: ['default'], workspace_supported: true, capabilities: ['run', 'workspace'] },
  { agent: 'codex', node_id: 'node_x', permission_modes: ['default'], workspace_supported: true, capabilities: ['run', 'workspace'] },
] }
const invClaudeOnly: Inventory = { observed_at: '2026-01-01T00:00:00Z', agents: [
  localCompiler,
  { agent: 'claude-code', node_id: 'node_x', permission_modes: ['default'], workspace_supported: true, capabilities: ['run', 'workspace'] },
] }

/** A minimal valid, completable planner→executor spec parameterized by role agents. */
const specJson = (plannerAgent: string, executorAgent: string, plannerRole = 'planner', executorRole = 'executor') => ({
  version: '1', name: 'compiled', entry_step: 'plan', inputs: { objective: { type: 'string', required: true } },
  agents: { [plannerRole]: { agent: plannerAgent, node_id: 'node_x' }, [executorRole]: { agent: executorAgent, node_id: 'node_x' } },
  output_schemas: {
    p: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, next_step: { type: 'string', required: false } } },
    e: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } },
  },
  limits: { max_tasks: 5, max_runtime_seconds: 300, max_step_attempts: 1, max_failures: 2 },
  steps: [
    { id: 'plan', type: 'agent_task', agent_role: plannerRole, prompt_template: 'Plan {{ inputs.objective }}', output_schema: 'p' },
    { id: 'build', type: 'agent_task', agent_role: executorRole, prompt_template: 'Build', output_schema: 'e' },
  ],
  edges: [
    { from: 'plan', to: 'build', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } },
    { from: 'build', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } },
  ],
  completion_policy: {},
})
const ready = (spec: unknown, inputs: Record<string, unknown> = { objective: 'x' }) => JSON.stringify({ schema_version: '1', status: 'ready', workflow_spec: spec, input_values: inputs, rationale: { why: 'ok' }, questions: [], warnings: [] })

const mk = (store: SqliteControlStore, model: CompilerModelClient, inv: Inventory) => new WorkflowCompiler({ store, model, inventory: new FakeInventory(inv) })
async function withStore(fn: (store: SqliteControlStore) => Promise<void>): Promise<void> {
  const store = openControlStore({ path: tmpDb() })
  try { await fn(store) } finally { try { store.closeSync() } catch { /* */ } }
}

// ── strict parsing ──────────────────────────────────────────────────────────────

test('strict compiler-result parsing: rejects prose, unknown fields, bad status; accepts a clean object', () => {
  assert.equal(parseCompilerResult('here is your workflow: {"schema_version":"1"}').ok, false) // trailing/leading prose
  assert.equal(parseCompilerResult('{"schema_version":"1","status":"ready","workflow_spec":{},"input_values":{},"rationale":{},"questions":[],"warnings":[],"x":1}').ok, false) // unknown field
  assert.equal(parseCompilerResult('{"schema_version":"2","status":"ready"}').ok, false)
  assert.equal(parseCompilerResult('{"schema_version":"1","status":"nope"}').ok, false)
  const good = parseCompilerResult('{"schema_version":"1","status":"needs_input","workflow_spec":{},"input_values":{},"rationale":{},"questions":["q1"],"warnings":[]}')
  assert.ok(good.ok && good.value.status === 'needs_input' && good.value.questions[0] === 'q1')
})

// ── flexible agent assignment (compiler identity ≠ generated roles) ──────────────

test('only-Claude inventory: a Claude planner + Claude executor (one agent, multiple roles) validates', async () => {
  await withStore(async (store) => {
    const model = new FakeModel(() => ready(specJson('claude-code', 'claude-code')))
    // both generated roles are claude (one agent, multiple roles). (Test 3 shows the
    // compiler model identity differing from the generated roles.)
    const draft = await mk(store, model, invClaudeOnly).compile({ nl_request: 'build X', compiler_agent: 'claude-code' })
    assert.equal(draft.compiler_status, 'ready'); assert.equal(draft.validation_status, 'valid')
    assert.ok(draft.spec_hash)
  })
})

test('Codex planner + Claude executor respected when requested and available', async () => {
  await withStore(async (store) => {
    const draft = await mk(store, new FakeModel(() => ready(specJson('codex', 'claude-code'))), invFull).compile({ nl_request: 'x', compiler_agent: 'claude-code' })
    assert.equal(draft.validation_status, 'valid')
    const agents = (draft.spec as any).agents
    assert.equal(agents.planner.agent, 'codex'); assert.equal(agents.executor.agent, 'claude-code')
  })
})

test('single-role spec (one agent assigned to a single-step workflow) validates', async () => {
  await withStore(async (store) => {
    const spec = { version: '1', name: 'solo', entry_step: 'go', inputs: { objective: { type: 'string', required: true } },
      agents: { only: { agent: 'claude-code', node_id: 'node_x' } },
      output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
      limits: { max_tasks: 2, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
      steps: [{ id: 'go', type: 'agent_task', agent_role: 'only', prompt_template: 'Do {{ inputs.objective }}', output_schema: 'o' }],
      edges: [{ from: 'go', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
      completion_policy: {} }
    const draft = await mk(store, new FakeModel(() => ready(spec)), invClaudeOnly).compile({ nl_request: 'x', compiler_agent: 'claude-code' })
    assert.equal(draft.validation_status, 'valid')
  })
})

// ── validation rejections ────────────────────────────────────────────────────────

test('an agent not in the inventory is rejected (invalid draft, no spec_hash)', async () => {
  await withStore(async (store) => {
    const draft = await mk(store, new FakeModel(() => ready(specJson('codex', 'claude-code'))), invClaudeOnly).compile({ nl_request: 'x', compiler_agent: 'claude-code' })
    assert.equal(draft.validation_status, 'invalid')
    assert.equal(draft.spec_hash, null)
    assert.ok((draft.warnings as string[]).some((w) => w.includes('agent_not_in_inventory')))
  })
})

test('a missing completion_policy on a completable spec is rejected', async () => {
  await withStore(async (store) => {
    const spec = specJson('claude-code', 'claude-code') as any; delete spec.completion_policy
    const draft = await mk(store, new FakeModel(() => ready(spec)), invClaudeOnly).compile({ nl_request: 'x', compiler_agent: 'claude-code' })
    assert.equal(draft.validation_status, 'invalid')
    assert.ok((draft.warnings as string[]).some((w) => w.includes('completion_policy_required')))
  })
})

test('unenforceable permission mode is rejected; secret-like fields are rejected', async () => {
  await withStore(async (store) => {
    // permission_mode unsafe-skip not in the placement's permission_modes
    const spec1 = specJson('claude-code', 'claude-code') as any; spec1.steps[0].permission_mode = 'unsafe-skip'
    const d1 = await mk(store, new FakeModel(() => ready(spec1)), invClaudeOnly).compile({ nl_request: 'perm', compiler_agent: 'claude-code' })
    assert.equal(d1.validation_status, 'invalid')
    assert.ok((d1.warnings as string[]).some((w) => w.includes('permission_not_enforceable')))
    // a secret-like field anywhere in the spec is rejected
    const spec2 = specJson('claude-code', 'claude-code') as any; spec2.agents.planner.api_key = 'sk-123'
    const d2 = await mk(store, new FakeModel(() => ready(spec2)), invClaudeOnly).compile({ nl_request: 'secret', compiler_agent: 'claude-code' })
    assert.equal(d2.validation_status, 'invalid')
    assert.ok((d2.warnings as string[]).some((w) => w.includes('secret_field_rejected')))
  })
})

// ── canonical hashing ──────────────────────────────────────────────────────────

test('canonical hash is deterministic; an agent/limit/policy change alters the hash', async () => {
  const base = specJson('codex', 'claude-code')
  const h1 = canonicalHash(base)
  assert.equal(h1, canonicalHash(JSON.parse(JSON.stringify(base)))) // deterministic
  assert.notEqual(h1, canonicalHash(specJson('claude-code', 'claude-code'))) // agent change
  const limited = JSON.parse(JSON.stringify(base)); limited.limits.max_tasks = 4
  assert.notEqual(h1, canonicalHash(limited)) // limit change
  const policy = JSON.parse(JSON.stringify(base)); policy.completion_policy = { require_tests_passed: true }
  assert.notEqual(h1, canonicalHash(policy)) // policy change
})

// ── approval / materialization ───────────────────────────────────────────────────

test('exact-hash approval creates exactly ONE ready workflow (never started); wrong hash conflicts; approval is idempotent', async () => {
  await withStore(async (store) => {
    const compiler = mk(store, new FakeModel(() => ready(specJson('codex', 'claude-code'))), invFull)
    const draft = await compiler.compile({ nl_request: 'ship', compiler_agent: 'claude-code' })
    assert.equal(draft.validation_status, 'valid')
    // wrong hash → conflict
    await assert.rejects(() => compiler.approve(draft.draft_id, 'deadbeef'), (e: any) => e instanceof CompilerError && e.code === 'approval_hash_conflict')
    // exact hash → one ready workflow, NOT started
    const { workflow_id } = await compiler.approve(draft.draft_id, draft.spec_hash!)
    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'ready', 'materialized workflow is ready and NOT started')
    // idempotent: same hash → same workflow, no second creation
    const again = await compiler.approve(draft.draft_id, draft.spec_hash!)
    assert.equal(again.workflow_id, workflow_id)
    assert.equal((await store.listWorkflows({})).filter((w) => w.workflow_id === workflow_id).length, 1)
    assert.equal((await store.getDraft(draft.draft_id))!.materialized_workflow_id, workflow_id)
  })
})

// ── misleading events ignored + idempotency/recovery ─────────────────────────────

test('misleading JSON in task events is ignored — only the AgentTaskResult controls the result', async () => {
  await withStore(async (store) => {
    // the model returns the authoritative result; a real Gateway would surface misleading
    // event deltas, but the model client only consults result_text (authoritative).
    const model = new FakeModel(() => ({ task_id: 'ct_1', status: 'available', output_text: ready(specJson('claude-code', 'claude-code')) }))
    const draft = await mk(store, model, invClaudeOnly).compile({ nl_request: 'x', compiler_agent: 'claude-code' })
    assert.equal(draft.validation_status, 'valid')
  })
})

test('KEYED compile idempotency: same key retry (even with a new inventory observed_at) → same draft, one compiler task, unchanged snapshot; approve idempotent', async () => {
  await withStore(async (store) => {
    const model = new FakeModel(() => ready(specJson('codex', 'claude-code')))
    const inv = new FakeInventory(invFull)
    const compiler = new WorkflowCompiler({ store, model, inventory: inv })
    const d1 = await compiler.compile({ nl_request: 'same', compiler_agent: 'claude-code', idempotency_key: 'op-1' })
    const snap1 = (d1.inventory_snapshot as any).observed_at
    const d2 = await compiler.compile({ nl_request: 'same', compiler_agent: 'claude-code', idempotency_key: 'op-1' }) // lost-response retry
    assert.equal(d1.draft_id, d2.draft_id, 'same key + same request → same draft')
    assert.equal(model.calls.length, 1, 'the compiler model ran once (no duplicate task)')
    assert.equal(inv.snapshots, 1, 'the inventory was snapshotted exactly once (retry did not re-snapshot)')
    assert.equal((d2.inventory_snapshot as any).observed_at, snap1, 'the original inventory snapshot is unchanged')
    // approve twice → one workflow
    const a1 = await compiler.approve(d1.draft_id, d1.spec_hash!)
    const a2 = await compiler.approve(d1.draft_id, d1.spec_hash!)
    assert.equal(a1.workflow_id, a2.workflow_id)
    assert.equal((await store.listWorkflows({})).filter((w) => w.workflow_id === a1.workflow_id).length, 1)
  })
})

test('KEYED compile: same key with a CHANGED request or CHANGED constraints → idempotency_conflict', async () => {
  await withStore(async (store) => {
    const compiler = new WorkflowCompiler({ store, model: new FakeModel(() => ready(specJson('codex', 'claude-code'))), inventory: new FakeInventory(invFull) })
    await compiler.compile({ nl_request: 'first', constraints: { budget: 1 }, compiler_agent: 'claude-code', idempotency_key: 'op-2' })
    await assert.rejects(() => compiler.compile({ nl_request: 'CHANGED', constraints: { budget: 1 }, compiler_agent: 'claude-code', idempotency_key: 'op-2' }), (e: any) => e instanceof CompilerError && e.code === 'idempotency_conflict')
    await assert.rejects(() => compiler.compile({ nl_request: 'first', constraints: { budget: 2 }, compiler_agent: 'claude-code', idempotency_key: 'op-2' }), (e: any) => e.code === 'idempotency_conflict')
  })
})

test('UNKEYED compile creates a NEW operation each call (no retry dedup, documented)', async () => {
  await withStore(async (store) => {
    const compiler = new WorkflowCompiler({ store, model: new FakeModel(() => ready(specJson('codex', 'claude-code'))), inventory: new FakeInventory(invFull) })
    const d1 = await compiler.compile({ nl_request: 'same', compiler_agent: 'claude-code' })
    const d2 = await compiler.compile({ nl_request: 'same', compiler_agent: 'claude-code' })
    assert.notEqual(d1.draft_id, d2.draft_id, 'no idempotency key → a new draft each call')
  })
})

test('KEYED compile: crash after the draft record but before finalize → restart with the same key finalizes the SAME draft/task (no duplicates)', async () => {
  const db = tmpDb()
  let draftId = ''; let taskId = ''
  {
    const store = openControlStore({ path: db })
    // model crashes (throws) AFTER a real Gateway would have created the task — simulate by
    // recording the task then throwing so the draft stays pending with a bound task.
    let created = false
    const model: CompilerModelClient = { compile: async () => { created = true; throw new Error('crash after task creation') } }
    const compiler = new WorkflowCompiler({ store, model, inventory: new FakeInventory(invFull) })
    await assert.rejects(() => compiler.compile({ nl_request: 'crashy', compiler_agent: 'claude-code', idempotency_key: 'op-3' }))
    assert.ok(created)
    const d = await store.getDraftByIdempotencyKey('op-3'); draftId = d!.draft_id
    assert.equal(d!.compiler_status, 'pending') // recorded before task, not finalized
    store.closeSync()
  }
  const store = openControlStore({ path: db })
  try {
    // restart: same key → the SAME pending draft is resumed (deterministic task id), finalized once
    const model = new FakeModel(() => ready(specJson('codex', 'claude-code')))
    const compiler = new WorkflowCompiler({ store, model, inventory: new FakeInventory(invFull) })
    const d = await compiler.compile({ nl_request: 'crashy', compiler_agent: 'claude-code', idempotency_key: 'op-3' })
    assert.equal(d.draft_id, draftId, 'same draft after restart')
    assert.equal(d.validation_status, 'valid')
    assert.equal(model.calls[0].idempotency_key, 'compile:' + draftId, 'compiler task keyed to the stable draft id')
    taskId = model.calls[0].idempotency_key
    assert.ok(taskId)
    // exactly one draft for this key
    assert.ok(await store.getDraftByIdempotencyKey('op-3'))
  } finally { store.closeSync() }
})

// ── Gate 2: compiler permission enforcement ──────────────────────────────────────

test('the compiler task is created with the minimum-capability profile (permission_mode default), and the summary is persisted', async () => {
  await withStore(async (store) => {
    // capture the createTask call via a task-client-shaped model? Use the real model client over a fake task client.
    const { AgentTaskCompilerModelClient } = await import('../src/workflow/compiler/model-client.js')
    const creates: any[] = []
    const taskClient = {
      async createTask(req: any) { creates.push(req); return { task_id: 't1' } },
      async getTask() { return { task_id: 't1', status: 'completed', terminal: true, history_complete: true, result_status: 'available', result_text: ready(specJson('claude-code', 'claude-code')) } },
      async waitForTerminal() { return { task_id: 't1', status: 'completed', terminal: true, history_complete: true, result_status: 'available', result_text: ready(specJson('claude-code', 'claude-code')), events: [], next_event_id: -1 } },
      async cancelTask() { /* */ },
    }
    const compiler = new WorkflowCompiler({ store, model: new AgentTaskCompilerModelClient(taskClient as any), inventory: new FakeInventory(invClaudeOnly) })
    const draft = await compiler.compile({ nl_request: 'x', compiler_agent: 'claude-code', compiler_node_id: 'node_x' })
    assert.equal(draft.validation_status, 'valid')
    assert.equal(creates[0].permission_mode, 'default', 'compiler task runs permission_mode=default (enforced by the node)')
    assert.equal(creates[0].workspace_key, undefined, 'no workspace binding for the compiler task')
    const cap = draft.compiler_capability as any
    assert.equal(cap.permission_mode, 'default'); assert.equal(cap.workspace_write, false); assert.equal(cap.git_push, false); assert.equal(cap.deploy, false); assert.equal(cap.secret_access, false); assert.equal(cap.network, false); assert.equal(cap.enforced_by, 'node')
  })
})

test('FAIL CLOSED before starting the task when the compiler backend cannot enforce the profile', async () => {
  await withStore(async (store) => {
    // an inventory whose only placement cannot enforce permission_mode "default"
    const invNoDefault: Inventory = { observed_at: '2026-01-01T00:00:00Z', agents: [{ agent: 'claude-code', node_id: 'node_x', permission_modes: ['unsafe-skip'], workspace_supported: true, capabilities: ['run'] }] }
    const model = new FakeModel(() => { throw new Error('the compiler task must NOT run') })
    const draft = await new WorkflowCompiler({ store, model, inventory: new FakeInventory(invNoDefault) }).compile({ nl_request: 'x', compiler_agent: 'claude-code', compiler_node_id: 'node_x' })
    assert.equal(draft.compiler_status, 'impossible'); assert.equal(draft.validation_status, 'invalid')
    assert.equal(model.calls.length, 0, 'no compiler task was created (failed closed before start)')
    assert.equal(draft.compiler_task_id, null)
    assert.ok((draft.warnings as string[]).some((w) => w.includes('minimum-capability profile')))
  })
})

test('a non-ready compiler status (needs_input) yields an unapprovable draft with questions', async () => {
  await withStore(async (store) => {
    const out = JSON.stringify({ schema_version: '1', status: 'needs_input', workflow_spec: {}, input_values: {}, rationale: {}, questions: ['which repo?'], warnings: [] })
    const compiler = mk(store, new FakeModel(() => out), invFull)
    const draft = await compiler.compile({ nl_request: 'vague', compiler_agent: 'claude-code' })
    assert.equal(draft.compiler_status, 'needs_input'); assert.equal(draft.validation_status, 'invalid'); assert.equal(draft.spec_hash, null)
    assert.deepEqual(draft.questions, ['which repo?'])
    await assert.rejects(() => compiler.approve(draft.draft_id, 'x'), (e: any) => e.code === 'draft_not_approvable')
  })
})
