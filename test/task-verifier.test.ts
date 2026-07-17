/**
 * Harness-owned test verification: the sandboxed verifier runner, the durable
 * verification contract, its embedding in the AgentTaskResult, completion-policy
 * consumption (trusted evidence ONLY), persistence across a ControlStore reopen,
 * the encrypted-wire roundtrip, and an end-to-end supervisor integration on a
 * disposable repo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  validateTaskVerifyConfig, buildTaskVerification, validateTaskVerification,
  verificationTestsResult, computeVerificationContentHash, type TaskVerificationV1,
} from '../src/lib/task-verification.js'
import { runVerifier, verifierPreflight } from '../src/runtime/verifier.js'
import { buildTaskResult, validateTaskResult, resultsEquivalent } from '../src/lib/agent-task-result.js'
import { assembleEvidence, evaluateCompletion } from '../src/workflow/completion-policy.js'
import { openControlStore } from '../src/control/sqlite-store.js'

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const nodeBin = process.execPath // absolute path to the current node

// ── contract: validateTaskVerifyConfig ───────────────────────────────────────
test('verify config: accepts a bounded argv, rejects empty/non-string/unknown fields', () => {
  assert.equal(validateTaskVerifyConfig({ argv: ['node', '--test'] }).ok, true)
  assert.deepEqual(validateTaskVerifyConfig({ argv: [] }), { ok: false, code: 'empty_argv', message: 'verify.argv must have at least one element (the program)' })
  assert.equal((validateTaskVerifyConfig({ argv: ['x', 3] }) as { code: string }).code, 'argv_item_not_string')
  assert.equal((validateTaskVerifyConfig({ argv: ['x'], cwd: '/etc' }) as { code: string }).code, 'unknown_field')
  assert.equal((validateTaskVerifyConfig({ argv: Array(64).fill('a') }) as { code: string }).code, 'argv_too_long')
  assert.equal((validateTaskVerifyConfig('node --test') as { code: string }).code, 'not_object')
})

// ── contract: build + validate + kind derivation ─────────────────────────────
test('verify record: kind is derived from exit_code ONLY; validation rejects inconsistency', () => {
  const passed = buildTaskVerification({ argv: ['node', '--test'], exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', output: 'ok' })
  assert.equal(passed.kind, 'tests_passed')
  assert.equal(passed.content_hash, computeVerificationContentHash('ok'))
  const failed = buildTaskVerification({ argv: ['node', '--test'], exitCode: 1, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', output: 'boom' })
  assert.equal(failed.kind, 'tests_failed')
  assert.equal(validateTaskVerification(passed).ok, true)
  // tamper: claim passed with a non-zero exit → rejected
  const tampered = { ...passed, exit_code: 2 }
  assert.equal((validateTaskVerification(tampered) as { code: string }).code, 'invalid_verification')
  // newer schema fails closed
  assert.equal((validateTaskVerification({ ...passed, schema_version: '2' }) as { code: string }).code, 'unsupported_schema_version')
  assert.equal(verificationTestsResult(passed), true)
  assert.equal(verificationTestsResult(failed), false)
  assert.equal(verificationTestsResult(undefined), null)
})

// ── runner: exit code → kind, in the fixed workspace cwd ──────────────────────
test('runVerifier: exit 0 → tests_passed; non-zero → tests_failed; runs in the workspace cwd', async () => {
  const ws = tmp('vfy-cwd-')
  const pass = await runVerifier({ argv: [nodeBin, '-e', "require('fs').writeFileSync('ran.txt', process.cwd())"] }, ws)
  assert.equal(pass.kind, 'tests_passed')
  assert.equal(pass.exit_code, 0)
  assert.equal(fs.readFileSync(path.join(ws, 'ran.txt'), 'utf8'), fs.realpathSync(ws)) // wrote INSIDE the workspace
  const fail = await runVerifier({ argv: [nodeBin, '-e', 'process.exit(3)'] }, ws)
  assert.equal(fail.kind, 'tests_failed')
  assert.equal(fail.exit_code, 3)
})

// ── runner: NO shell expansion (argv is literal) ──────────────────────────────
test('runVerifier: no shell — metacharacter args are passed literally, never expanded', async () => {
  const ws = tmp('vfy-shell-')
  const evil = '$(echo pwned); rm -rf / && echo `whoami`'
  await runVerifier({ argv: [nodeBin, '-e', "require('fs').writeFileSync('arg.txt', process.argv[1])", evil] }, ws)
  assert.equal(fs.readFileSync(path.join(ws, 'arg.txt'), 'utf8'), evil) // verbatim — no shell touched it
})

// ── runner: scrubbed env (no secret/proxy leakage; HOME pinned to workspace) ──
test('runVerifier: scrubs the environment — inherited secrets are NOT visible to the verifier', async () => {
  const ws = tmp('vfy-env-')
  process.env.SECRET_SNIFF_TOKEN = 'topsecret-should-not-leak'
  process.env.HTTPS_PROXY = 'http://creds@proxy'
  try {
    await runVerifier({ argv: [nodeBin, '-e', "require('fs').writeFileSync('env.txt', JSON.stringify({s:process.env.SECRET_SNIFF_TOKEN||'ABSENT',p:process.env.HTTPS_PROXY||'ABSENT',home:process.env.HOME}))"] }, ws)
    const seen = JSON.parse(fs.readFileSync(path.join(ws, 'env.txt'), 'utf8'))
    assert.equal(seen.s, 'ABSENT')
    assert.equal(seen.p, 'ABSENT')
    assert.equal(seen.home, ws) // HOME pinned to the workspace, not the caller's home
  } finally { delete process.env.SECRET_SNIFF_TOKEN; delete process.env.HTTPS_PROXY }
})

// ── runner: bounded output + bounded runtime (fail-closed) ────────────────────
test('runVerifier: caps output and kills a runaway/hung verifier (fail-closed)', async () => {
  const ws = tmp('vfy-bound-')
  const flood = await runVerifier({ argv: [nodeBin, '-e', "for(;;)process.stdout.write('x'.repeat(4096))"] }, ws, { maxOutputBytes: 2048, timeoutMs: 15000 })
  assert.equal(flood.kind, 'tests_failed') // killed for exceeding the output cap
  const hung = await runVerifier({ argv: [nodeBin, '-e', 'setTimeout(()=>{}, 60000)'] }, ws, { timeoutMs: 300 })
  assert.equal(hung.kind, 'tests_failed')
  assert.equal(hung.exit_code, 124) // timeout sentinel
})

// ── runner: fail-closed preflight ─────────────────────────────────────────────
test('verifierPreflight: resolves a real program; a missing one fails closed', () => {
  assert.equal(verifierPreflight({ argv: [nodeBin, '--test'] }).ok, true)
  const miss = verifierPreflight({ argv: ['definitely-not-a-real-binary-xyz'] })
  assert.equal(miss.ok, false)
  assert.equal((miss as { code: string }).code, 'program_not_found')
  assert.equal((verifierPreflight({ argv: [] }) as { code: string }).code, 'invalid_config')
})

// ── AgentTaskResult: embeds + validates + idempotency + backward compat ───────
test('AgentTaskResult: verification survives validate roundtrip; tamper rejected; idempotency includes it', () => {
  const v = buildTaskVerification({ argv: [nodeBin, '--test'], exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z', output: 'suite green' })
  const r = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: v })
  const parsed = validateTaskResult(JSON.parse(JSON.stringify(r))) // wire roundtrip (JSON like the encrypted remote path)
  assert.equal(parsed.ok, true)
  assert.deepEqual((parsed as { value: { verification?: TaskVerificationV1 } }).value.verification, v)
  // backward compat: a result with NO verification still validates
  assert.equal(validateTaskResult(JSON.parse(JSON.stringify(buildTaskResult({ text: 'x' })))).ok, true)
  // tampered embedded verification → whole result invalid
  const bad = JSON.parse(JSON.stringify(r)); bad.verification.kind = 'tests_failed'
  assert.equal(validateTaskResult(bad).ok, false)
  // idempotency: same result equivalent; differing verification NOT equivalent
  assert.equal(resultsEquivalent(r, buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: v })), true)
  const v2 = buildTaskVerification({ argv: [nodeBin, '--test'], exitCode: 1, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z', output: 'red' })
  assert.equal(resultsEquivalent(r, buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: v2 })), false)
})

// ── completion policy consumes ONLY the structured verification ───────────────
test('completion policy: trusted verification satisfies; failure conflicts; absence blocks; agent claims are ignored', () => {
  const policy = { required_evidence: ['tests_passed' as const], require_tests_passed: true }
  const withV = (v: TaskVerificationV1 | undefined) => assembleEvidence({ taskStatus: 'completed', result: buildTaskResult({ text: 'x', processExitCode: 0, ...(v ? { verification: v } : {}) }), revisionBefore: null, revisionAfter: null })
  const passedV = buildTaskVerification({ argv: [nodeBin, '--test'], exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', output: 'ok' })
  const failedV = buildTaskVerification({ argv: [nodeBin, '--test'], exitCode: 1, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', output: 'no' })

  assert.equal(evaluateCompletion(policy, withV(passedV), null).decision, 'complete')
  assert.equal(evaluateCompletion(policy, withV(failedV), null).decision, 'failed') // conflict, fail-closed

  const noV = evaluateCompletion(policy, withV(undefined), null)
  assert.equal(noV.decision, 'blocked')
  assert.deepEqual((noV as { missing: string[] }).missing, ['tests_passed'])

  // Agent-CLAIMED success (an evidence_ref) WITHOUT a verifier record does NOT satisfy policy.
  const claimed = assembleEvidence({ taskStatus: 'completed', result: { ...buildTaskResult({ text: 'x' }), evidence_refs: [{ kind: 'tests_passed', summary: 'agent says the tests passed' }] }, revisionBefore: null, revisionAfter: null })
  assert.equal(claimed.tests_passed, null) // agent prose is not evidence
  assert.equal(evaluateCompletion(policy, claimed, null).decision, 'blocked')
})

// ── durable persistence across a ControlStore reopen ──────────────────────────
test('ControlStore: a result with verification survives close + reopen; re-persist is idempotent', async () => {
  const dir = tmp('vfy-store-')
  const dbPath = path.join(dir, 'control.sqlite')
  const v = buildTaskVerification({ argv: [nodeBin, '--test'], exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:03Z', output: 'green' })
  const result = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: v })

  const s0 = openControlStore({ path: dbPath })
  s0.createTaskDurable({ task_id: 'run_v', node_id: 'node_1', agent: 'codex', status: 'queued', remote_run_id: 'rr_v' }, { sequence: 0, event_type: 'task.created', ts: '2026-01-01T00:00:00Z', payload: {} })
  assert.equal(s0.persistTaskResultDurable('run_v', 'available', result).applied, true) // first write
  assert.equal(s0.persistTaskResultDurable('run_v', 'available', result).applied, false) // idempotent duplicate = no-op
  s0.closeSync()

  const s1 = openControlStore({ path: dbPath })
  const back = s1.getTaskResultDurable('run_v')
  assert.equal(back?.result_status, 'available')
  assert.deepEqual(back?.result?.verification, v) // structured evidence intact after reopen
  s1.closeSync()
})

// ── durable persistence in the NODE JOURNAL (remote result path) across reopen ─
test('node journal: a run result with verification survives close + reopen (remote path durability)', async () => {
  const { openNodeJournal } = await import('../src/node-journal/sqlite-journal.js')
  const dir = tmp('vfy-journal-')
  const dbPath = path.join(dir, 'journal.sqlite')
  const v = buildTaskVerification({ argv: [nodeBin, '--test'], exitCode: 1, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:04Z', output: 'red' })
  const result = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: v })
  const j0 = openNodeJournal({ path: dbPath })
  assert.equal(j0.persistRunResult('rr_j', 'available', result).applied, true)
  j0.close()
  const j1 = openNodeJournal({ path: dbPath })
  assert.deepEqual(j1.getRunResult('rr_j')?.result?.verification, v) // intact after reopen
  j1.close()
})

// ── end-to-end: disposable repo → verifier runs → completion policy sees it ───
test('integration: mock agent changes a disposable repo, the harness verifier runs `node --test`, and completion policy sees trusted evidence', async (t) => {
  const { runSupervisor } = await import('../src/runtime/supervisor.js')
  const store = await import('../src/store.js')
  const vibeDir = tmp('vfy-sup-')
  const prevVibe = process.env.VIBE_DIR, prevMock = process.env.VIBE_MOCK_OUTPUT
  process.env.VIBE_DIR = vibeDir
  process.env.VIBE_MOCK_OUTPUT = JSON.stringify({ status: 'done', summary: 'changed the repo' })
  fs.mkdirSync(path.join(vibeDir, 'runs'), { recursive: true })
  fs.mkdirSync(path.join(vibeDir, 'events'), { recursive: true })
  t.after(() => { process.env.VIBE_DIR = prevVibe; if (prevMock === undefined) delete process.env.VIBE_MOCK_OUTPUT; else process.env.VIBE_MOCK_OUTPUT = prevMock })

  // A disposable "repo" the agent (mock) is pretending to have modified, with a test suite.
  const mkWorkspace = (pass: boolean): string => {
    const ws = tmp('vfy-repo-')
    fs.writeFileSync(path.join(ws, 'sum.js'), 'module.exports.sum = (a,b) => a+b\n')
    fs.writeFileSync(path.join(ws, 'sum.test.js'), `const {test}=require('node:test');const a=require('node:assert');const {sum}=require('./sum');test('sum', ()=>a.equal(sum(2,2), ${pass ? 4 : 5}))\n`)
    return ws
  }
  const runOnce = async (run_id: string, ws: string, verify: { argv: string[] } | undefined) => {
    store.writeRun({ run_id, session_id: '', node_id: 'local', node_selector: 'local', agent: 'mock', status: 'queued', workspace_path: ws, ...(verify ? { verify } : {}), created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never)
    await runSupervisor(run_id)
    return store.readRun(run_id)
  }
  const policy = { required_evidence: ['tests_passed' as const], require_tests_passed: true }
  const evidenceFor = (rec: { task_result?: unknown }) => assembleEvidence({ taskStatus: 'completed', result: (rec.task_result ?? null) as never, revisionBefore: null, revisionAfter: null })

  // PASS: verifier `node --test` exits 0 → tests_passed → policy completes.
  const okRec = await runOnce('run_ok', mkWorkspace(true), { argv: [nodeBin, '--test'] })
  assert.equal(okRec.status, 'completed')
  assert.equal((okRec.task_result as { verification?: TaskVerificationV1 }).verification?.kind, 'tests_passed')
  assert.equal(evaluateCompletion(policy, evidenceFor(okRec), null).decision, 'complete')

  // FAIL: verifier exits non-zero → tests_failed → policy fails closed (conflict).
  const badRec = await runOnce('run_bad', mkWorkspace(false), { argv: [nodeBin, '--test'] })
  assert.equal(badRec.status, 'completed') // the AGENT completed…
  assert.equal((badRec.task_result as { verification?: TaskVerificationV1 }).verification?.kind, 'tests_failed')
  assert.equal(evaluateCompletion(policy, evidenceFor(badRec), null).decision, 'failed') // …but verification says no

  // NO verifier configured (agent claim only) → no verification → policy blocks.
  const noRec = await runOnce('run_none', mkWorkspace(true), undefined)
  assert.equal(noRec.status, 'completed')
  assert.equal((noRec.task_result as { verification?: TaskVerificationV1 }).verification, undefined)
  assert.equal(evaluateCompletion(policy, evidenceFor(noRec), null).decision, 'blocked')
})

// ── fail-closed preflight: a missing verifier program stops the run BEFORE the agent ──
test('integration: a missing verifier program fails the run closed BEFORE the agent runs', async (t) => {
  const { runSupervisor } = await import('../src/runtime/supervisor.js')
  const store = await import('../src/store.js')
  const vibeDir = tmp('vfy-pre-')
  const prevVibe = process.env.VIBE_DIR, prevMock = process.env.VIBE_MOCK_OUTPUT
  process.env.VIBE_DIR = vibeDir
  process.env.VIBE_MOCK_OUTPUT = JSON.stringify({ status: 'done', summary: 'x' })
  fs.mkdirSync(path.join(vibeDir, 'runs'), { recursive: true })
  fs.mkdirSync(path.join(vibeDir, 'events'), { recursive: true })
  t.after(() => { process.env.VIBE_DIR = prevVibe; if (prevMock === undefined) delete process.env.VIBE_MOCK_OUTPUT; else process.env.VIBE_MOCK_OUTPUT = prevMock })

  const ws = tmp('vfy-pre-ws-')
  store.writeRun({ run_id: 'run_pre', session_id: '', node_id: 'local', node_selector: 'local', agent: 'mock', status: 'queued', workspace_path: ws, verify: { argv: ['definitely-not-a-real-binary-xyz', '--test'] }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never)
  await runSupervisor('run_pre')
  const rec = store.readRun('run_pre')
  assert.equal(rec.status, 'failed')
  assert.equal(rec.failure_reason, 'verifier_unavailable')
  assert.equal(rec.task_result, undefined) // no result was finalized — the agent never ran
})
