/**
 * Canonical Agent Task Contract — pure type/mapping tests. No HTTP, no relay,
 * no fs, no process. Exercises every RunStatus/RunEvent branch, the state
 * machine, request validation (incl. array rejection for every object-shaped
 * field), agent discovery, error mapping, the identifier NON-leakage guarantee,
 * and JSON serialization shape.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RunRecord, RunStatus, RunEvent } from '../src/types.js'
import type { VibeError } from '../src/types.js'
import type { RunErrorCode } from '../src/lib/run-error.js'
import {
  TASK_CONTRACT_VERSION, TASK_STATUSES, TERMINAL_TASK_STATUSES,
  taskIdForRun, runIdForTask, isValidTaskId,
  runStatusToTaskStatus, isTerminalTaskStatus, isLegalTaskTransition, TASK_TRANSITIONS,
  runRecordToTask,
  validateCreateTaskRequest, isPlainObject,
  runEventToTaskEvent,
  buildAgentDescriptors,
  apiError, apiErrorHttpStatus, vibeErrorToApiError, runErrorToApiError,
  type TaskStatus, type ApiErrorCode,
} from '../src/lib/agent-task-contract.js'

// ── identity ─────────────────────────────────────────────────────────────────

test('task_id == run_id (1:1), round-trips, validated', () => {
  assert.equal(taskIdForRun('run_abc'), 'run_abc')
  assert.equal(runIdForTask('run_abc'), 'run_abc')
  assert.equal(runIdForTask(taskIdForRun('run_x')), 'run_x')
  assert.ok(isValidTaskId('run_x'))
  assert.ok(!isValidTaskId(''))
  assert.ok(!isValidTaskId(123))
})

// ── status projection (every RunStatus) ──────────────────────────────────────

test('runStatusToTaskStatus covers every RunStatus', () => {
  const cases: Array<[RunStatus, TaskStatus]> = [
    ['queued', 'queued'], ['running', 'running'], ['completed', 'completed'],
    ['failed', 'failed'], ['stopped', 'cancelled'], ['cancelled', 'cancelled'],
    ['blocked', 'running'], // no runtime path preserves a paused state today
  ]
  for (const [rs, ts] of cases) assert.equal(runStatusToTaskStatus(rs), ts, `${rs} -> ${ts}`)
})

test('terminal task statuses (timed_out deferred in v1)', () => {
  assert.deepEqual([...TERMINAL_TASK_STATUSES].sort(), ['cancelled', 'completed', 'failed'])
  assert.ok(isTerminalTaskStatus('completed'))
  assert.ok(isTerminalTaskStatus('failed'))
  assert.ok(!isTerminalTaskStatus('running'))
  assert.ok(!isTerminalTaskStatus('starting'))
  // timed_out is NOT part of contract v1
  assert.ok(!(TASK_STATUSES as readonly string[]).includes('timed_out'))
})

// ── state machine ────────────────────────────────────────────────────────────

test('legal + illegal task transitions', () => {
  assert.ok(isLegalTaskTransition('queued', 'running'))
  assert.ok(isLegalTaskTransition('queued', 'starting'))
  assert.ok(isLegalTaskTransition('starting', 'running'))
  assert.ok(isLegalTaskTransition('running', 'completed'))
  assert.ok(isLegalTaskTransition('running', 'failed'))
  assert.ok(isLegalTaskTransition('running', 'cancelled'))
  // illegal
  assert.ok(!isLegalTaskTransition('completed', 'running'), 'terminal is sticky')
  assert.ok(!isLegalTaskTransition('failed', 'completed'))
  assert.ok(!isLegalTaskTransition('cancelled', 'running'))
  assert.ok(!isLegalTaskTransition('running', 'queued'), 'no going back')
  assert.ok(!isLegalTaskTransition('queued', 'completed'), 'must start before completing')
})

test('every terminal status has no outgoing transitions', () => {
  for (const s of TERMINAL_TASK_STATUSES) assert.equal(TASK_TRANSITIONS[s].length, 0, `${s} is a sink`)
})

// ── record projection + NON-leakage ──────────────────────────────────────────

function baseRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'run_leak', session_id: 'tmux-secret-session', node_id: 'node_1',
    agent: 'claude-code', status: 'running', workspace_path: '/mnt/e/secret/ws',
    prompt_file: '/tmp/secret-prompt', child_pid: 4242,
    event_aes_key: 'AESAESAES', stop_aes_key: 'STOPKEY', approval_aes_key: 'APPRKEY',
    repo_url: 'https://example.com/r.git', branch: 'feature',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:01:00.000Z',
    ...over,
  }
}

test('runRecordToTask projects safe fields and NEVER leaks backend identifiers', () => {
  const task = runRecordToTask(baseRecord({ status: 'running', metadata: { issue: 'JOZ-1' } }))
  assert.equal(task.task_id, 'run_leak')
  assert.equal(task.status, 'running')
  assert.equal(task.node_id, 'node_1')
  assert.equal(task.agent, 'claude-code')
  assert.equal(task.contract_version, TASK_CONTRACT_VERSION)
  assert.deepEqual(task.metadata, { issue: 'JOZ-1' })
  const json = JSON.stringify(task)
  for (const secret of ['tmux-secret-session', '/mnt/e/secret/ws', '/tmp/secret-prompt', '4242', 'AESAESAES', 'STOPKEY', 'APPRKEY', 'example.com']) {
    assert.ok(!json.includes(secret), `must not leak ${secret}`)
  }
  for (const key of ['session_id', 'child_pid', 'workspace_path', 'prompt_file', 'event_aes_key', 'stop_aes_key', 'approval_aes_key', 'repo_url', 'branch']) {
    assert.ok(!(key in task), `Task must not carry ${key}`)
  }
})

test('completed record projects result (final_agent/switched/exit_code)', () => {
  const task = runRecordToTask(baseRecord({ status: 'completed', final_agent: 'codex', switched: true, exit_code: 0 }))
  assert.equal(task.status, 'completed')
  assert.equal(task.agent, 'codex', 'agent reflects final_agent after a switch')
  assert.deepEqual(task.result, { final_agent: 'codex', switched: true, exit_code: 0 })
  assert.equal(task.error, undefined)
})

test('failed record projects error; a timed-out run projects to failed (no string inference in v1)', () => {
  const failed = runRecordToTask(baseRecord({ status: 'failed', error: 'tests failed hard', failure_reason: 'tests_failed', recoverable: false, exit_code: 1 }))
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.error, { message: 'tests failed hard', reason: 'tests_failed', recoverable: false, exit_code: 1 })

  const timed = runRecordToTask(baseRecord({ status: 'failed', error: 'run timed out after 1800000ms', failure_reason: 'unknown' }))
  assert.equal(timed.status, 'failed', 'a timed-out run is plain failed in v1 — no diagnostic-string refinement')
  assert.equal(timed.error?.message, 'run timed out after 1800000ms')
})

test('stopped/cancelled records project to cancelled', () => {
  assert.equal(runRecordToTask(baseRecord({ status: 'stopped' })).status, 'cancelled')
  assert.equal(runRecordToTask(baseRecord({ status: 'cancelled' })).status, 'cancelled')
})

// ── request validation ───────────────────────────────────────────────────────

test('isPlainObject rejects null, arrays, and primitives', () => {
  assert.ok(isPlainObject({}))
  assert.ok(isPlainObject({ a: 1 }))
  assert.ok(!isPlainObject(null))
  assert.ok(!isPlainObject([]))
  assert.ok(!isPlainObject([{ a: 1 }]))
  assert.ok(!isPlainObject('s'))
  assert.ok(!isPlainObject(3))
  assert.ok(!isPlainObject(undefined))
})

test('validateCreateTaskRequest accepts a valid v1 request (supported fields only)', () => {
  const r = validateCreateTaskRequest({
    agent: 'claude-code', node_id: 'node_1', input: { text: 'fix it' },
    workspace: { workspace_key: 'ws.key-1' },
    execution: { permission_mode: 'default' }, metadata: { a: 1 },
  })
  assert.ok(r.ok)
  if (r.ok) {
    assert.equal(r.value.agent, 'claude-code')
    assert.equal(r.value.input.text, 'fix it')
    assert.deepEqual(r.value.workspace, { workspace_key: 'ws.key-1' })
    assert.equal(r.value.execution?.permission_mode, 'default')
    assert.deepEqual(r.value.metadata, { a: 1 })
  }
  // omitting workspace_key stays valid (runtime generates its own)
  const noKey = validateCreateTaskRequest({ agent: 'mock', input: { text: 'x' }, workspace: {} })
  assert.ok(noKey.ok)
})

test('validateCreateTaskRequest accepts a valid idempotency_key and rejects malformed keys (invalid_request, no echo)', () => {
  const ok = validateCreateTaskRequest({ agent: 'mock', input: { text: 'x' }, idempotency_key: 'step:exec-01.a-B' })
  assert.ok(ok.ok); if (ok.ok) assert.equal(ok.value.idempotency_key, 'step:exec-01.a-B')
  // a step_execution_id-shaped key is valid (the intended future caller value)
  assert.ok(validateCreateTaskRequest({ agent: 'mock', input: { text: 'x' }, idempotency_key: 'wf_1.plan.r1.a1' }).ok)
  for (const key of ['has space', 'a/b', 'a\\b', 'x'.repeat(129), '', 'ünïcode', 42, '.leading']) {
    const r = validateCreateTaskRequest({ agent: 'mock', input: { text: 'x' }, idempotency_key: key })
    assert.ok(!r.ok, `should reject ${JSON.stringify(key)}`)
    if (!r.ok) assert.equal(r.error.code, 'invalid_request')
  }
})

test('validateCreateTaskRequest rejects each malformed shape with invalid_request', () => {
  const bad: unknown[] = [
    null, 'str', 7,
    { agent: '', input: { text: 'x' } },
    { agent: 'a' },
    { agent: 'a', input: {} },
    { agent: 'a', input: { text: '   ' } },
    { agent: 'a', node_id: 5, input: { text: 'x' } },
    { agent: 'a', input: { text: 'x' }, execution: { permission_mode: 'wild' } },
  ]
  for (const b of bad) {
    const r = validateCreateTaskRequest(b)
    assert.ok(!r.ok, `should reject ${JSON.stringify(b)}`)
    if (!r.ok) { assert.equal(r.error.code, 'invalid_request'); assert.equal(r.error.error, true) }
  }
})

test('validateCreateTaskRequest fails CLOSED on deferred workspace/execution fields (no echo of values)', () => {
  const cases: Array<[string, unknown, string]> = [
    ['workspace.path', { agent: 'a', input: { text: 'x' }, workspace: { path: '/etc/passwd' } }, '/etc/passwd'],
    ['workspace.repo_url', { agent: 'a', input: { text: 'x' }, workspace: { repo_url: 'https://secret.example/r.git' } }, 'secret.example'],
    ['workspace.branch', { agent: 'a', input: { text: 'x' }, workspace: { branch: 'super-secret-branch' } }, 'super-secret-branch'],
    ['execution.timeout_seconds', { agent: 'a', input: { text: 'x' }, execution: { timeout_seconds: 999 } }, '999'],
  ]
  for (const [label, body, secret] of cases) {
    const r = validateCreateTaskRequest(body)
    assert.ok(!r.ok, `${label} must be rejected`)
    if (!r.ok) {
      assert.equal(r.error.code, 'invalid_request')
      assert.ok(!r.error.message.includes(secret), `${label} error must NOT echo the submitted value`)
    }
  }
})

test('validateCreateTaskRequest: workspace_key must be an opaque safe key (no paths/traversal)', () => {
  const ok = ['a', 'A1', 'run.key_9-x', 'x'.repeat(128)]
  for (const k of ok) assert.ok(validateCreateTaskRequest({ agent: 'a', input: { text: 'x' }, workspace: { workspace_key: k } }).ok, `accept ${k.slice(0, 12)}`)
  const bad: unknown[] = ['', '/abs/path', 'win-back-'+String.fromCharCode(92)+'path', '..', '.', '../escape', 'a/b', 'a'+String.fromCharCode(92)+'b', '.hidden', '-lead', 'x'.repeat(129), 'a'+String.fromCharCode(1)+'b', 'sp ace', 42]
  for (const k of bad) {
    const r = validateCreateTaskRequest({ agent: 'a', input: { text: 'x' }, workspace: { workspace_key: k } })
    assert.ok(!r.ok, `reject ${JSON.stringify(k).slice(0, 16)}`)
    // The message is a static regex hint and never reflects the submitted value.
    // (Check distinctive keys; single chars like "." trivially appear in the regex text.)
    if (!r.ok) { assert.equal(r.error.code, 'invalid_request'); if (typeof k === 'string' && k.length >= 4) assert.ok(!r.error.message.includes(k), 'unsafe key not echoed') }
  }
})

test('arrays are rejected for EVERY object-shaped field (no silent accept)', () => {
  const arrayCases: Array<[string, unknown]> = [
    ['root body', []],
    ['input', { agent: 'a', input: [] }],
    ['execution', { agent: 'a', input: { text: 'x' }, execution: [] }],
    ['workspace', { agent: 'a', input: { text: 'x' }, workspace: [] }],
    ['metadata', { agent: 'a', input: { text: 'x' }, metadata: [] }],
    ['metadata (array of pairs)', { agent: 'a', input: { text: 'x' }, metadata: [['k', 'v']] }],
  ]
  for (const [label, body] of arrayCases) {
    const r = validateCreateTaskRequest(body)
    assert.ok(!r.ok, `array must be rejected for ${label}`)
    if (!r.ok) assert.equal(r.error.code, 'invalid_request')
  }
})

// ── event mapping (every RunEvent type) ──────────────────────────────────────

const ev = (e: Partial<RunEvent> & { type: RunEvent['type'] }): RunEvent =>
  ({ run_id: 'run_e', ts: '2026-01-01T00:00:00.000Z', ...(e as object) }) as RunEvent

test('runEventToTaskEvent maps status + log; drops the rest', () => {
  assert.equal(runEventToTaskEvent(ev({ type: 'status', status: 'running' } as RunEvent), 1)?.type, 'task.started')
  assert.equal(runEventToTaskEvent(ev({ type: 'status', status: 'completed' } as RunEvent), 2)?.type, 'task.completed')
  assert.equal(runEventToTaskEvent(ev({ type: 'status', status: 'failed' } as RunEvent), 3)?.type, 'task.failed')
  assert.equal(runEventToTaskEvent(ev({ type: 'status', status: 'stopped' } as RunEvent), 4)?.type, 'task.cancelled')
  assert.equal(runEventToTaskEvent(ev({ type: 'status', status: 'cancelled' } as RunEvent), 5)?.type, 'task.cancelled')
  assert.equal(runEventToTaskEvent(ev({ type: 'status', status: 'queued' } as RunEvent), 6), null)
  assert.equal(runEventToTaskEvent(ev({ type: 'status', status: 'blocked' } as RunEvent), 7), null)

  const log = runEventToTaskEvent(ev({ type: 'log', stream: 'stdout', message: 'hi' } as RunEvent), 8)
  assert.equal(log?.type, 'agent.output.delta')
  assert.deepEqual(log?.payload, { stream: 'stdout', text: 'hi' })
  assert.equal(log?.seq, 8)
  assert.equal(log?.task_id, 'run_e')
  assert.equal(log?.contract_version, TASK_CONTRACT_VERSION)

  // deferred run events map to null (no invented tool/artifact/error types yet)
  assert.equal(runEventToTaskEvent(ev({ type: 'tool_call', tool: 'bash' } as RunEvent), 9), null)
  assert.equal(runEventToTaskEvent(ev({ type: 'pr_created', url: 'u' } as RunEvent), 10), null)
  assert.equal(runEventToTaskEvent(ev({ type: 'approval_required', approval_id: 'a', message: 'm' } as RunEvent), 11), null)
  assert.equal(runEventToTaskEvent(ev({ type: 'error', message: 'boom' } as RunEvent), 12), null)
})

// ── agent discovery ──────────────────────────────────────────────────────────

test('buildAgentDescriptors: streaming only when known; node_id optional', () => {
  const local = buildAgentDescriptors(['mock', 'claude-code'])
  assert.deepEqual(local, [
    { id: 'mock', available: true, streaming: true },
    { id: 'claude-code', available: true, streaming: true },
  ])
  const remote = buildAgentDescriptors(['codex', 'exotic-agent'], { node_id: 'node_1' })
  assert.deepEqual(remote, [
    { id: 'codex', node_id: 'node_1', available: true, streaming: true },
    { id: 'exotic-agent', node_id: 'node_1', available: true }, // streaming unknown -> omitted
  ])
})

// ── error mapping ────────────────────────────────────────────────────────────

test('apiError applies default retryability + http status per code', () => {
  const codes: ApiErrorCode[] = ['invalid_request', 'unauthorized', 'agent_unavailable', 'node_offline', 'service_unavailable', 'task_not_found', 'invalid_state_transition', 'cancellation_conflict', 'idempotency_conflict', 'internal_error']
  const status: Record<ApiErrorCode, number> = {
    invalid_request: 400, unauthorized: 401, task_not_found: 404, cancellation_conflict: 409,
    invalid_state_transition: 409, idempotency_conflict: 409, agent_unavailable: 422, node_offline: 503, service_unavailable: 503, internal_error: 500,
  }
  const retryable: Record<ApiErrorCode, boolean> = {
    invalid_request: false, unauthorized: false, agent_unavailable: false, node_offline: true,
    service_unavailable: true, task_not_found: false, invalid_state_transition: false, cancellation_conflict: false, idempotency_conflict: false, internal_error: true,
  }
  for (const c of codes) {
    const e = apiError(c, 'msg', { ts: 'T' })
    assert.equal(e.error, true); assert.equal(e.code, c); assert.equal(e.ts, 'T')
    assert.equal(e.retryable, retryable[c], `${c} retryable`)
    assert.equal(apiErrorHttpStatus(c), status[c], `${c} -> ${status[c]}`)
    assert.ok(!('run_id' in e), 'ApiError never carries run_id')
  }
  const withCtx = apiError('task_not_found', 'nope', { task_id: 'run_1', details: { a: 1 } })
  assert.equal(withCtx.task_id, 'run_1'); assert.deepEqual(withCtx.details, { a: 1 })
})

test('vibeErrorToApiError maps every VibeErrorCode and exposes run_id as task_id only', () => {
  const map: Array<[VibeError['code'], ApiErrorCode]> = [
    ['user_error', 'invalid_request'], ['not_found', 'task_not_found'], ['backend_error', 'internal_error'],
    ['read_only', 'invalid_request'], ['node_not_found', 'node_offline'],
    ['agent_not_supported', 'agent_unavailable'], ['no_runner_available', 'agent_unavailable'],
  ]
  for (const [vc, ac] of map) {
    const out = vibeErrorToApiError({ error: true, code: vc, message: 'm', run_id: 'run_1', ts: 'T' })
    assert.equal(out.code, ac, `${vc} -> ${ac}`)
    assert.equal(out.task_id, 'run_1', 'run_id surfaced as task_id')
    assert.ok(!('run_id' in out), 'internal run_id never on the wire')
  }
  const noRun = vibeErrorToApiError({ error: true, code: 'user_error', message: 'm', ts: 'T' })
  assert.equal(noRun.task_id, undefined)
})

test('runErrorToApiError maps every RunErrorCode; relay_unavailable -> service_unavailable (no "relay" exposed)', () => {
  const map: Array<[RunErrorCode, ApiErrorCode]> = [
    ['relay_unavailable', 'service_unavailable'], ['node_offline', 'node_offline'], ['unauthorized', 'unauthorized'],
    ['run_not_found', 'task_not_found'], ['agent_not_supported', 'agent_unavailable'],
    ['already_terminal', 'cancellation_conflict'], ['remote_error', 'internal_error'], ['unknown_error', 'internal_error'],
  ]
  for (const [rc, ac] of map) assert.equal(runErrorToApiError(rc, 'm').code, ac, `${rc} -> ${ac}`)
})

// ── serialization / JSON-shape stability ─────────────────────────────────────

test('resources JSON round-trip with stable field names', () => {
  const task = runRecordToTask(baseRecord({ status: 'completed', exit_code: 0 }))
  assert.deepEqual(JSON.parse(JSON.stringify(task)), task)
  const evt = runEventToTaskEvent(ev({ type: 'log', stream: 'stderr', message: 'x' } as RunEvent), 1)!
  assert.deepEqual(Object.keys(evt).sort(), ['contract_version', 'payload', 'seq', 'task_id', 'ts', 'type'])
  const err = apiError('node_offline', 'down', { ts: 'T' })
  assert.deepEqual(Object.keys(err).sort(), ['code', 'error', 'message', 'retryable', 'ts'])
  assert.equal(TASK_STATUSES.length, 6)
})
