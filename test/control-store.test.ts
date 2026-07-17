/**
 * Durable control store — behavioral tests against isolated TEMPORARY SQLite
 * databases. No production DB is ever created; each test uses its own temp dir.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { openControlStore } from '../src/control/sqlite-store.js'
import { ControlStoreError } from '../src/control/records.js'
import { plannerExecutorLoopExample } from '../src/workflow/examples.js'

const tmpDbPath = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-')), 'control.sqlite')
const iso = (): string => new Date().toISOString()
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return '(no error)' } catch (e) { return e instanceof ControlStoreError ? e.code : `(${(e as Error).name})` }
}
const seedTask = (over: Record<string, unknown> = {}) => ({ task_id: 'run_1', agent: 'mock', status: 'running', ...over })

test('create + reopen preserves task and workflow records', async () => {
  const p = tmpDbPath()
  let s = openControlStore({ path: p })
  await s.createTask(seedTask({ node_id: 'node_x', input_text: 'do the thing', metadata: { a: 1 } }))
  await s.createWorkflow({ workflow_id: 'wf_1', spec_version: '1', workflow_name: 'planner-executor-loop', spec: plannerExecutorLoopExample() })
  await s.close()
  s = openControlStore({ path: p })
  const t = await s.getTask('run_1'); assert.equal(t?.node_id, 'node_x'); assert.equal(t?.input_text, 'do the thing'); assert.deepEqual(t?.metadata, { a: 1 })
  const w = await s.getWorkflow('wf_1'); assert.equal(w?.workflow_name, 'planner-executor-loop')
  await s.close()
})

test('WAL + foreign_keys + busy_timeout enabled; healthCheck reports schema version', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  const h = await s.healthCheck()
  assert.equal(h.journal_mode, 'wal'); assert.equal(h.foreign_keys, true); assert.equal(h.schema_version, 14)
  assert.equal(h.busy_timeout, 5000) // default bounded busy timeout
  const s2 = openControlStore({ path: tmpDbPath(), busyTimeoutMs: 1234 })
  assert.equal((await s2.healthCheck()).busy_timeout, 1234) // configurable
  await s.close(); await s2.close()
})

test('close is clean and repeatable; use-after-close is rejected', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createTask(seedTask())
  await s.close()
  await s.close() // repeatable, no throw
  assert.equal(await code(() => s.getTask('run_1')), 'closed')
})

test('optimistic revision conflict on stale update', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createTask(seedTask())
  await s.updateTask('run_1', 1, { status: 'running', remote_run_id: 'r1' }) // revision → 2
  assert.equal(await code(() => s.updateTask('run_1', 1, { status: 'running' })), 'revision_conflict')
  await s.close()
})

test('terminal task cannot regress; terminal_at cannot be cleared', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createTask(seedTask())
  const t = await s.updateTask('run_1', 1, { status: 'completed', terminal_at: iso() })
  assert.equal(await code(() => s.updateTask('run_1', t.revision, { status: 'running' })), 'invalid_transition')
  assert.equal(await code(() => s.updateTask('run_1', t.revision, { terminal_at: null })), 'invalid_transition')
  await s.close()
})

test('task terminalization records the terminal event exactly once', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  const t = await s.createTaskWithCreatedEvent(seedTask(), { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
  const done = await s.terminalizeTask('run_1', t.revision, { status: 'completed' }, { sequence: 1, event_type: 'task.completed', ts: iso(), payload: {} })
  assert.equal(done.terminal_event_recorded, true)
  assert.equal(await code(() => s.terminalizeTask('run_1', done.revision, { status: 'failed' }, { sequence: 2, event_type: 'task.failed', ts: iso(), payload: {} })), 'invalid_transition')
  await s.close()
})

test('event append: idempotent duplicate, conflict, gap detection, reopen', async () => {
  const p = tmpDbPath()
  let s = openControlStore({ path: p })
  await s.createTask(seedTask())
  const ev0 = { sequence: 0, event_type: 'task.created', ts: iso(), payload: { n: 1 } }
  await s.appendTaskEvent('run_1', ev0)
  await s.appendTaskEvent('run_1', ev0) // exact duplicate → no-op
  assert.equal((await s.listTaskEvents('run_1')).length, 1)
  assert.equal(await code(() => s.appendTaskEvent('run_1', { ...ev0, payload: { n: 2 } })), 'event_conflict')
  assert.equal(await code(() => s.appendTaskEvent('run_1', { sequence: 5, event_type: 'task.started', ts: iso(), payload: {} })), 'event_gap')
  await s.appendTaskEvent('run_1', { sequence: 1, event_type: 'task.started', ts: iso(), payload: {} })
  assert.equal(await s.getLatestTaskEventSequence('run_1'), 1)
  await s.close()
  s = openControlStore({ path: p })
  assert.equal(await s.getLatestTaskEventSequence('run_1'), 1)
  assert.deepEqual((await s.listTaskEvents('run_1')).map((e) => e.sequence), [0, 1])
  await s.close()
})

test('transaction rollback: created event gap aborts task creation', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  assert.equal(await code(() => s.createTaskWithCreatedEvent(seedTask(), { sequence: 5, event_type: 'task.created', ts: iso(), payload: {} })), 'event_gap')
  assert.equal(await s.getTask('run_1'), null) // rolled back
  await s.close()
})

test('workflow: blocked resumes to running; completed cannot regress; counters/round monotonic', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createWorkflow({ workflow_id: 'wf_1', spec_version: '1', workflow_name: 'w', spec: {}, status: 'blocked', current_round: 2 })
  const running = await s.updateWorkflow('wf_1', 1, { status: 'running' }) // blocked → running OK
  assert.equal(running.status, 'running')
  assert.equal(await code(() => s.updateWorkflow('wf_1', running.revision, { current_round: 1 })), 'invalid_transition')
  const t2 = await s.updateWorkflow('wf_1', running.revision, { total_tasks: 3 })
  assert.equal(await code(() => s.updateWorkflow('wf_1', t2.revision, { total_tasks: 2 })), 'invalid_transition')
  const done = await s.updateWorkflow('wf_1', t2.revision, { status: 'completed', terminal_at: iso() })
  assert.equal(await code(() => s.updateWorkflow('wf_1', done.revision, { status: 'running' })), 'invalid_transition')
  await s.close()
})

test('workflow step execution identity is unique; retries get distinct ids', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createWorkflow({ workflow_id: 'wf_1', spec_version: '1', workflow_name: 'w', spec: {} })
  await s.createStepExecution({ step_execution_id: 'se_1', workflow_id: 'wf_1', step_id: 'plan', round: 1, attempt: 1 })
  assert.equal(await code(() => s.createStepExecution({ step_execution_id: 'se_dup', workflow_id: 'wf_1', step_id: 'plan', round: 1, attempt: 1 })), 'duplicate')
  const retry = await s.createStepExecution({ step_execution_id: 'se_2', workflow_id: 'wf_1', step_id: 'plan', round: 1, attempt: 2 })
  assert.equal(retry.attempt, 2)
  await s.close()
})

test('completed step output cannot be silently replaced', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createWorkflow({ workflow_id: 'wf_1', spec_version: '1', workflow_name: 'w', spec: {} })
  await s.createStepExecution({ step_execution_id: 'se_1', workflow_id: 'wf_1', step_id: 'plan', round: 1, attempt: 1 })
  const done = await s.updateStepExecution('se_1', 1, { status: 'completed', output: { status: 'continue' } })
  assert.equal(await code(() => s.updateStepExecution('se_1', done.revision, { output: { status: 'complete' } })), 'invalid_transition')
  await s.close()
})

test('workflow events: step-scoped requires ref; workflow-scoped rejects ref', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createWorkflow({ workflow_id: 'wf_1', spec_version: '1', workflow_name: 'w', spec: {} })
  await s.createStepExecution({ step_execution_id: 'se_1', workflow_id: 'wf_1', step_id: 'plan', round: 1, attempt: 1 })
  await s.appendWorkflowEvent('wf_1', { sequence: 0, event_type: 'workflow.started', ts: iso(), payload: {} }) // no ref OK
  assert.equal(await code(() => s.appendWorkflowEvent('wf_1', { sequence: 1, event_type: 'workflow.round_advanced', ts: iso(), step_execution_id: 'se_1', payload: {} })), 'invalid_record')
  assert.equal(await code(() => s.appendWorkflowEvent('wf_1', { sequence: 1, event_type: 'step.started', ts: iso(), payload: {} })), 'invalid_record')
  await s.appendWorkflowEvent('wf_1', { sequence: 1, event_type: 'step.started', ts: iso(), step_execution_id: 'se_1', payload: {} }) // step-scoped w/ ref OK
  await s.close()
})

test('WorkflowSpec and context bundle round-trip through persistence', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  const spec = plannerExecutorLoopExample()
  await s.createWorkflow({ workflow_id: 'wf_1', spec_version: '1', workflow_name: spec.name, spec })
  assert.deepEqual((await s.getWorkflow('wf_1'))?.spec, spec)
  const ctx = { objective: 'ship it', current_round: 2, latest_planner_decision: { status: 'continue', summary: 's', next_step: 'go' }, decisions: ['d1'] }
  const rev = await s.saveWorkflowContext('wf_1', 0, ctx)
  assert.equal(rev, 1)
  const snap = await s.getWorkflowSnapshot('wf_1')
  assert.deepEqual(snap?.context, ctx); assert.equal(snap?.context_revision, 1)
  assert.equal(await code(() => s.saveWorkflowContext('wf_1', 0, ctx)), 'revision_conflict') // stale ctx revision
  await s.close()
})

test('context rejects unknown top-level and credential-like nested fields', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createWorkflow({ workflow_id: 'wf_1', spec_version: '1', workflow_name: 'w', spec: {} })
  assert.equal(await code(() => s.saveWorkflowContext('wf_1', 0, { api_token: 'x' })), 'forbidden_field') // unknown key
  assert.equal(await code(() => s.saveWorkflowContext('wf_1', 0, { decisions: [{ bearer_token: 'x' }] })), 'forbidden_field') // nested secret
  await s.close()
})

test('oversized JSON rejected', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  const big = { blob: 'x'.repeat(20000) }
  assert.equal(await code(() => s.createTask(seedTask({ metadata: big }))), 'too_large')
  await s.close()
})

test('malformed persisted JSON is a corruption error on read', async () => {
  const p = tmpDbPath()
  const s = openControlStore({ path: p })
  await s.createTask(seedTask({ metadata: { a: 1 } }))
  await s.close()
  const raw = new Database(p); raw.prepare('UPDATE tasks SET metadata_json = ? WHERE task_id = ?').run('{not json', 'run_1'); raw.close()
  const s2 = openControlStore({ path: p })
  assert.equal(await code(() => s2.getTask('run_1')), 'corruption')
  await s2.close()
})

test('retention: prune terminal only (never active) + preserves truncation metadata', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createTask(seedTask({ task_id: 'active' }))
  const term = await s.createTask(seedTask({ task_id: 'old' }))
  await s.updateTask('old', term.revision, { status: 'completed', terminal_at: '2000-01-01T00:00:00.000Z' })
  const pruned = await s.pruneTerminalTasks('2020-01-01T00:00:00.000Z')
  assert.equal(pruned.removed, 1)
  assert.equal(await s.getTask('active') !== null, true) // active kept
  assert.equal(await s.getTask('old'), null)
  // event pruning truncation metadata
  await s.appendTaskEvent('active', { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
  await s.appendTaskEvent('active', { sequence: 1, event_type: 'task.started', ts: iso(), payload: {} })
  await s.appendTaskEvent('active', { sequence: 2, event_type: 'task.completed', ts: iso(), payload: {} })
  const ep = await s.pruneTaskEvents('active', 1)
  assert.equal(ep.removed, 2)
  assert.equal((await s.getTask('active'))?.earliest_retained_sequence, 2)
  await s.close()
})

test('database isolation: separate temp DBs do not share data', async () => {
  const a = openControlStore({ path: tmpDbPath() }); const b = openControlStore({ path: tmpDbPath() })
  await a.createTask(seedTask({ task_id: 'only_in_a' }))
  assert.equal(await b.getTask('only_in_a'), null)
  await a.close(); await b.close()
})

test('DB file is user-only where the platform permits (0600)', async () => {
  const p = tmpDbPath()
  const s = openControlStore({ path: p })
  await s.createTask(seedTask())
  if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o077, 0, 'no group/world bits')
  // and no secret sentinel ever lands in the DB bytes (the store never accepts tokens)
  assert.ok(!fs.readFileSync(p).includes(Buffer.from('SUPERSECRET-TOKEN-FIXTURE')))
  await s.close()
})

test('task history-incomplete mark + clear round-trips and survives reopen', async () => {
  const p = tmpDbPath()
  let s = openControlStore({ path: p })
  await s.createTask(seedTask())
  await s.appendTaskEvent('run_1', { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
  s.markTaskHistoryIncomplete('run_1', 'gateway_restart_without_node_replay', 0)
  s.markTaskHistoryIncomplete('run_1', 'gateway_restart_without_node_replay', 9) // idempotent: earliest boundary wins
  assert.equal(s.getTaskRecord('run_1')?.history_incomplete, true)
  assert.equal(s.getTaskRecord('run_1')?.history_boundary_sequence, 0)
  await s.close()
  s = openControlStore({ path: p }) // survives reopen
  assert.equal(s.getTaskRecord('run_1')?.history_reason, 'gateway_restart_without_node_replay')
  s.clearTaskHistoryIncomplete('run_1') // reserved future-Node-journal path
  assert.equal(s.getTaskRecord('run_1')?.history_incomplete, false)
  await s.close()
})

test('source-event ingestion: cursor init, atomic map, idempotent/conflict/gap, terminal', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  await s.createTaskWithCreatedEvent(seedTask({ node_id: 'node_x' }), { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} })
  assert.equal(s.getTaskRecord('run_1')?.last_remote_event_sequence, null) // unknown until initialized
  s.initReplayCursor('run_1'); assert.equal(s.getTaskRecord('run_1')?.last_remote_event_sequence, -1)
  // ingest source 0 → canonical mapped at the NEXT Gateway sequence (independent domain)
  const r0 = s.ingestSourceEventDurable('run_1', 0, { event_type: 'task.started', ts: iso(), payload: {} })
  assert.equal(r0.applied, true); assert.equal(r0.canonicalSequence, 1) // Gateway seq 1 (created was 0); source 0
  assert.equal(s.getTaskRecord('run_1')?.last_remote_event_sequence, 0)
  const ev1 = { event_type: 'agent.output.delta', ts: iso(), payload: { text: 'hi' } }
  const r1 = s.ingestSourceEventDurable('run_1', 1, ev1); assert.equal(r1.canonicalSequence, 2)
  assert.equal(s.ingestSourceEventDurable('run_1', 1, ev1).applied, false) // exact duplicate → idempotent
  assert.equal((() => { try { s.ingestSourceEventDurable('run_1', 1, { ...ev1, payload: { text: 'x' } }); return 'ok' } catch (e) { return (e as any).code } })(), 'event_conflict')
  assert.equal((() => { try { s.ingestSourceEventDurable('run_1', 9, ev1); return 'ok' } catch (e) { return (e as any).code } })(), 'event_gap') // source gap, not normalized
  // terminal source event → terminal recorded once
  const rt = s.ingestSourceEventDurable('run_1', 2, { event_type: 'task.completed', ts: iso(), payload: {}, terminal: true, status: 'completed' })
  assert.equal(rt.record.terminal_event_recorded, true); assert.equal(rt.record.status, 'completed')
  // canonical events carry source_sequence; canonical seq != source seq
  const evs = s.loadTaskEvents('run_1')
  assert.deepEqual(evs.map((e) => e.sequence), [0, 1, 2, 3]) // Gateway sequences
  await s.close()
})

test('createTaskIdempotently: create-or-return, conflict, uniqueness across connections, retention release', async () => {
  const p = tmpDbPath()
  let s = openControlStore({ path: p })
  const mk = (taskId: string, fp: string, over: Record<string, unknown> = {}) =>
    ({ task_id: taskId, agent: 'mock', status: 'running', idempotency_key: 'step:abc-1', request_fingerprint: fp, ...over })
  const created = { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} }
  // new key → created
  const r1 = s.createTaskIdempotently(mk('run_a', 'fp-1'), created)
  assert.equal(r1.created, true); assert.equal(r1.record.task_id, 'run_a'); assert.equal(r1.record.idempotency_key, 'step:abc-1')
  // same key + same fingerprint → the SAME task, created=false, NO second task/event
  const r2 = s.createTaskIdempotently(mk('run_b', 'fp-1'), created)
  assert.equal(r2.created, false); assert.equal(r2.record.task_id, 'run_a')
  assert.equal(s.getTaskRecord('run_b'), null) // the losing task_id was never inserted
  assert.equal(s.loadTaskEvents('run_a').length, 1) // exactly one task.created
  // same key + DIFFERENT fingerprint → conflict (never echoes the request)
  assert.equal(await code(async () => s.createTaskIdempotently(mk('run_c', 'fp-2'), created)), 'idempotency_conflict')
  // read-only pre-check
  assert.equal(s.getTaskByIdempotencyKey('step:abc-1')?.task_id, 'run_a')
  assert.equal(s.getTaskByIdempotencyKey('nope'), null)
  // key + fingerprint survive close/reopen; uniqueness persists
  await s.close(); s = openControlStore({ path: p })
  assert.equal(s.getTaskByIdempotencyKey('step:abc-1')?.request_fingerprint, 'fp-1')
  assert.equal(s.createTaskIdempotently(mk('run_d', 'fp-1'), created).record.task_id, 'run_a') // still deduped after restart
  // legacy/non-idempotent tasks have NULL idempotency fields
  await s.createTask({ task_id: 'run_legacy', agent: 'mock', status: 'running' })
  assert.equal(s.getTaskRecord('run_legacy')?.idempotency_key, null)
  assert.equal(s.getTaskRecord('run_legacy')?.request_fingerprint, null)

  // SQLite uniqueness is the final authority across a SECOND connection.
  const s2 = openControlStore({ path: p })
  assert.equal(s2.createTaskIdempotently(mk('run_e', 'fp-1'), created).created, false) // sees the durable winner
  assert.equal(s2.getTaskByIdempotencyKey('step:abc-1')?.task_id, 'run_a')
  s2.closeSync()

  // retention deletion of the task releases the key for reuse; active tasks are safe.
  await s.updateTask('run_a', s.getTaskRecord('run_a')!.revision, { status: 'completed', terminal_at: iso() })
  await s.deleteTask('run_a')
  assert.equal(s.getTaskByIdempotencyKey('step:abc-1'), null) // key released once the task is gone
  const reuse = s.createTaskIdempotently(mk('run_f', 'fp-9'), created)
  assert.equal(reuse.created, true); assert.equal(reuse.record.task_id, 'run_f') // key reusable after deletion
  await s.close()
})

test('createTaskIdempotently validates the key and fingerprint (bounded before DB writes)', async () => {
  const s = openControlStore({ path: tmpDbPath() })
  const ev = { sequence: 0, event_type: 'task.created', ts: iso(), payload: {} }
  const base = { task_id: 'run_1', agent: 'mock', status: 'running' as const }
  assert.equal(await code(async () => s.createTaskIdempotently({ ...base, request_fingerprint: 'fp' }, ev)), 'invalid_record') // missing key
  assert.equal(await code(async () => s.createTaskIdempotently({ ...base, idempotency_key: 'bad key', request_fingerprint: 'fp' }, ev)), 'invalid_record') // whitespace
  assert.equal(await code(async () => s.createTaskIdempotently({ ...base, idempotency_key: 'a/b', request_fingerprint: 'fp' }, ev)), 'invalid_record') // path sep
  assert.equal(await code(async () => s.createTaskIdempotently({ ...base, idempotency_key: 'ok', request_fingerprint: '' }, ev)), 'invalid_record') // empty fingerprint
  await s.close()
})

test('refuses to open a symlinked database path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-sym-'))
  const real = path.join(dir, 'real.sqlite'); fs.writeFileSync(real, '')
  const link = path.join(dir, 'control.sqlite'); fs.symlinkSync(real, link)
  assert.throws(() => openControlStore({ path: link }), (e: unknown) => e instanceof ControlStoreError && e.code === 'invalid_record')
})
