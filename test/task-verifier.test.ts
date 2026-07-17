/**
 * Harness-owned test verification — the two security gates:
 *   (1) POLICY-OWNED selection: a step names only an advertised profile ID; raw argv
 *       / interpreters / arguments are rejected and never taken from spec/LLM text.
 *   (2) REAL OS SANDBOX: the verifier runs in a bwrap jail (network off, writes
 *       confined to the workspace, external files absent, children inherited). If the
 *       Node cannot enforce it, verification is UNAVAILABLE and the run fails closed
 *       BEFORE the agent — never a silent degrade.
 *
 * Enforcement-observation tests run only where an enforcing sandbox is present
 * (`detectEnforcingSandbox().enforces`); everywhere else they assert the fail-closed
 * contract, which is the security-critical behavior on a Node without a sandbox.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  validateTaskVerifyConfig, buildTaskVerification, validateTaskVerification,
  verificationTestsResult, computeResolvedCommandHash, type TaskVerificationV1,
} from '../src/lib/task-verification.js'
import { resolveVerifierProfile, isKnownVerifierProfile, VERIFIER_PROFILE_IDS } from '../src/runtime/verifier-profiles.js'
import { verifierPreflight, runVerifier } from '../src/runtime/verifier.js'
import { detectEnforcingSandbox, buildBwrapArgv, wrapVerifierCommand, _resetSandboxDetectionCache } from '../src/runtime/sandbox.js'
import { buildTaskResult, validateTaskResult, resultsEquivalent } from '../src/lib/agent-task-result.js'
import { assembleEvidence, evaluateCompletion } from '../src/workflow/completion-policy.js'
import { openControlStore } from '../src/control/sqlite-store.js'

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const SANDBOX = detectEnforcingSandbox()               // one probe for the whole file
const ENFORCING = SANDBOX.enforces
const skipUnlessSandbox = ENFORCING ? undefined : { skip: `no enforcing sandbox here (${SANDBOX.reason})` }
const mkVerification = (exitCode: number): TaskVerificationV1 => buildTaskVerification({ profile: 'node-test', argv: ['/usr/bin/node', '--test'], exitCode, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', output: 'x' })

// ── GATE 1: policy-owned selection ────────────────────────────────────────────
test('gate1: raw argv (or any non-profile field) is REJECTED — a spec cannot supply a command', () => {
  assert.equal((validateTaskVerifyConfig({ argv: ['node', '--test'] }) as { code: string }).code, 'unknown_field') // a raw argv is not an accepted field
  assert.equal((validateTaskVerifyConfig({}) as { code: string }).code, 'missing_profile')
  assert.equal((validateTaskVerifyConfig({ profile: 'node-test', argv: ['x'] }) as { code: string }).code, 'unknown_field')
  assert.equal((validateTaskVerifyConfig({ profile: 'node-test', cwd: '/etc' }) as { code: string }).code, 'unknown_field')
  assert.equal((validateTaskVerifyConfig('node --test') as { code: string }).code, 'not_object')
})

test('gate1: ONLY advertised profile IDs are accepted; unknown profiles are rejected', () => {
  assert.equal(validateTaskVerifyConfig({ profile: 'node-test' }).ok, true)
  assert.equal((validateTaskVerifyConfig({ profile: 'evil-interpreter' }) as { code: string }).code, 'unknown_profile')
  assert.equal((validateTaskVerifyConfig({ profile: 'Node-Test' }) as { code: string }).code, 'bad_profile') // case/charset locked
  assert.deepEqual([...VERIFIER_PROFILE_IDS], ['node-test'])
  assert.equal(isKnownVerifierProfile('node-test'), true)
  assert.equal(isKnownVerifierProfile('nope'), false)
})

test('gate1: profile resolution is Node-policy-owned (fixed argv; spec cannot influence it)', () => {
  const p = resolveVerifierProfile('node-test')!
  assert.deepEqual(p.argv, ['node', '--test'])
  assert.equal(resolveVerifierProfile('anything-else'), null)
  // the resolved argv is a COPY — mutating it cannot corrupt the registry
  p.argv[0] = 'rm'
  assert.deepEqual(resolveVerifierProfile('node-test')!.argv, ['node', '--test'])
})

// ── verification record: profile + resolved-command hash + exit-code-only kind ─
test('verification record: kind from exit code ONLY; records profile + resolved_command_hash; tamper rejected', () => {
  const passed = mkVerification(0)
  assert.equal(passed.kind, 'tests_passed')
  assert.equal(passed.profile, 'node-test')
  assert.equal(passed.resolved_command_hash, computeResolvedCommandHash(['/usr/bin/node', '--test']))
  assert.equal(mkVerification(1).kind, 'tests_failed')
  assert.equal(validateTaskVerification(passed).ok, true)
  assert.equal((validateTaskVerification({ ...passed, exit_code: 2 }) as { code: string }).code, 'invalid_verification') // kind/exit mismatch
  assert.equal((validateTaskVerification({ ...passed, profile: 'nope' }) as { code: string }).code, 'invalid_verification') // profile must stay advertised
  assert.equal((validateTaskVerification({ ...passed, resolved_command_hash: '0'.repeat(64) }) as { code: string }).code, 'invalid_verification') // hash must match argv
  assert.equal((validateTaskVerification({ ...passed, schema_version: '2' }) as { code: string }).code, 'unsupported_schema_version')
  assert.equal(verificationTestsResult(passed), true)
  assert.equal(verificationTestsResult(mkVerification(1)), false)
  assert.equal(verificationTestsResult(undefined), null)
})

// ── GATE 2: sandbox construction is isolating (deterministic; no sandbox needed) ─
test('gate2: the sandbox command imposes network-off, workspace-confined writes, cleared env, die-with-parent', () => {
  const ws = '/tmp/leased-ws'
  const argv = buildBwrapArgv('/usr/bin/bwrap', ['/usr/bin/node', '--test'], ws, '/usr/bin/node')
  const s = argv.join(' ')
  assert.ok(s.includes('--unshare-all'), 'unshares net (+pid/ipc/uts/user/cgroup) → network off')
  assert.ok(s.includes('--die-with-parent'), 'children die with the jail')
  assert.ok(s.includes('--clearenv'), 'no inherited secrets/tokens/proxies')
  assert.ok(argv.includes('--bind') && argv.includes(ws), 'workspace bound read-WRITE')
  assert.ok(s.includes('--chdir ' + ws), 'runs in the leased workspace')
  assert.ok(s.includes('--ro-bind /usr /usr'), 'system dirs are read-only; no rw outside the workspace')
  assert.ok(!s.includes('--bind /home') && !s.includes('--bind /etc') && !s.includes('--bind /root'), 'external/secret dirs are NOT bound → inaccessible')
  assert.ok(s.endsWith('/usr/bin/node --test'), 'the policy-owned inner command runs last')
})

// ── GATE 2: fail-closed when no enforcing sandbox ─────────────────────────────
test('gate2: no enforcing sandbox → preflight + runVerifier + wrap all fail closed', async () => {
  const prev = process.env.VIBE_VERIFIER_SANDBOX
  process.env.VIBE_VERIFIER_SANDBOX = 'none'; _resetSandboxDetectionCache()
  try {
    const pf = verifierPreflight({ profile: 'node-test' })
    assert.equal(pf.ok, false)
    assert.equal((pf as { code: string }).code, 'sandbox_unavailable')
    assert.equal(wrapVerifierCommand(['/usr/bin/node', '--test'], tmp('vfy-fc-'), '/usr/bin/node').ok, false)
    await assert.rejects(runVerifier({ profile: 'node-test' }, tmp('vfy-fc2-')), /sandbox/i)
    // unknown profile fails closed regardless of sandbox
    assert.equal((verifierPreflight({ profile: 'nope' }) as { code: string }).code, 'unknown_profile')
  } finally { if (prev === undefined) delete process.env.VIBE_VERIFIER_SANDBOX; else process.env.VIBE_VERIFIER_SANDBOX = prev; _resetSandboxDetectionCache() }
})

// ── GATE 2: LIVE enforcement (only where a real sandbox exists) ───────────────
test('gate2 (live): verifier cannot write outside the workspace, cannot reach the network, and confines children', skipUnlessSandbox ?? {}, async () => {
  const ws = tmp('vfy-live-')
  const node = process.execPath
  const probe = `
    const fs=require('fs'),net=require('net');let r={};
    try{fs.writeFileSync('/ws-ok','x')}catch(e){} // (root of jail is ro anyway)
    try{fs.writeFileSync('${ws.replace(/'/g, "")}/inside.txt','ok');r.write_ws='OK'}catch(e){r.write_ws='FAIL:'+e.code}
    try{fs.writeFileSync('/etc/pwn','x');r.write_out='LEAK'}catch(e){r.write_out='blocked:'+e.code}
    try{fs.readFileSync('/etc/shadow');r.read_secret='LEAK'}catch(e){r.read_secret='blocked:'+e.code}
    const child=require('child_process').spawnSync(process.execPath,['-e',"try{require('fs').writeFileSync('/etc/childpwn','x');console.log('CHILDLEAK')}catch(e){console.log('child_blocked')}"],{encoding:'utf8'});
    r.child=(child.stdout||'spawnfail').trim();
    const s=net.connect({host:'1.1.1.1',port:53},()=>{r.net='LEAK';fin()});s.on('error',(e)=>{r.net='blocked:'+e.code;fin()});setTimeout(()=>{r.net='blocked:timeout';fin()},1500);
    function fin(){try{s.destroy()}catch(e){}; require('fs').writeFileSync('${ws.replace(/'/g, "")}/probe.json',JSON.stringify(r));process.exit(0)}
  `
  // Run the probe THROUGH the shipped sandbox wrapper (mirrors real verifier launch).
  const wrap = wrapVerifierCommand([node, '-e', probe], ws, node)
  assert.equal(wrap.ok, true)
  const { spawnSync } = await import('child_process')
  spawnSync((wrap as { argv: string[] }).argv[0], (wrap as { argv: string[] }).argv.slice(1), { timeout: 15000 })
  const r = JSON.parse(fs.readFileSync(path.join(ws, 'probe.json'), 'utf8'))
  assert.equal(r.write_ws, 'OK')
  assert.match(r.write_out, /^blocked:/)
  assert.match(r.read_secret, /^blocked:/)
  assert.equal(r.child, 'child_blocked')
  assert.match(r.net, /^blocked:/)
  assert.ok(!fs.existsSync('/etc/pwn') && !fs.existsSync('/etc/childpwn'), 'no host escape')
})

test('gate2 (live): a passing/failing profile run maps exit code → kind through the real sandbox', skipUnlessSandbox ?? {}, async () => {
  const mk = (pass: boolean) => { const ws = tmp('vfy-prof-'); fs.writeFileSync(path.join(ws, 'x.test.js'), `const t=require('node:test');const a=require('node:assert');t('x',()=>a.equal(1,${pass ? 1 : 2}))\n`); return ws }
  assert.equal((await runVerifier({ profile: 'node-test' }, mk(true))).kind, 'tests_passed')
  assert.equal((await runVerifier({ profile: 'node-test' }, mk(false))).kind, 'tests_failed')
})

// ── AgentTaskResult embedding + wire roundtrip + idempotency + backward compat ─
test('result: verification survives validate/wire roundtrip; tamper rejected; idempotency includes it; legacy compatible', () => {
  const v = mkVerification(0)
  const r = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: v })
  const parsed = validateTaskResult(JSON.parse(JSON.stringify(r)))
  assert.equal(parsed.ok, true)
  assert.deepEqual((parsed as { value: { verification?: TaskVerificationV1 } }).value.verification, v)
  assert.equal(validateTaskResult(JSON.parse(JSON.stringify(buildTaskResult({ text: 'x' })))).ok, true) // no verification = legacy ok
  const bad = JSON.parse(JSON.stringify(r)); bad.verification.kind = 'tests_failed'
  assert.equal(validateTaskResult(bad).ok, false)
  assert.equal(resultsEquivalent(r, buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: v })), true)
  assert.equal(resultsEquivalent(r, buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: mkVerification(1) })), false)
})

// ── completion policy consumes ONLY the durable verification record ────────────
test('policy: trusts ONLY durable Harness verification (passed=complete, failed=fail-closed, absent=blocked, agent claims ignored)', () => {
  const policy = { required_evidence: ['tests_passed' as const], require_tests_passed: true }
  const ev = (v?: TaskVerificationV1) => assembleEvidence({ taskStatus: 'completed', result: buildTaskResult({ text: 'x', processExitCode: 0, ...(v ? { verification: v } : {}) }), revisionBefore: null, revisionAfter: null })
  assert.equal(evaluateCompletion(policy, ev(mkVerification(0)), null).decision, 'complete')
  assert.equal(evaluateCompletion(policy, ev(mkVerification(1)), null).decision, 'failed')
  const blocked = evaluateCompletion(policy, ev(undefined), null)
  assert.equal(blocked.decision, 'blocked')
  // an agent-claimed evidence_ref is NOT verification and does NOT satisfy the policy
  const claimed = assembleEvidence({ taskStatus: 'completed', result: { ...buildTaskResult({ text: 'x' }), evidence_refs: [{ kind: 'tests_passed', summary: 'agent says so' }] }, revisionBefore: null, revisionAfter: null })
  assert.equal(claimed.tests_passed, null)
  assert.equal(evaluateCompletion(policy, claimed, null).decision, 'blocked')
})

// ── durable persistence across reopen (restart does not duplicate) ────────────
test('persistence: verification survives ControlStore close+reopen; re-persist is idempotent (no duplication)', () => {
  const dbPath = path.join(tmp('vfy-store-'), 'control.sqlite')
  const result = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: mkVerification(0) })
  const s0 = openControlStore({ path: dbPath })
  s0.createTaskDurable({ task_id: 'run_v', node_id: 'n1', agent: 'codex', status: 'queued', remote_run_id: 'rr_v' }, { sequence: 0, event_type: 'task.created', ts: '2026-01-01T00:00:00Z', payload: {} })
  assert.equal(s0.persistTaskResultDurable('run_v', 'available', result).applied, true)
  assert.equal(s0.persistTaskResultDurable('run_v', 'available', result).applied, false) // idempotent no-op
  s0.closeSync()
  const s1 = openControlStore({ path: dbPath })
  assert.deepEqual(s1.getTaskResultDurable('run_v')?.result?.verification, mkVerification(0))
  s1.closeSync()
})

test('persistence: verification survives Node-journal close+reopen (remote path durability)', async () => {
  const { openNodeJournal } = await import('../src/node-journal/sqlite-journal.js')
  const dbPath = path.join(tmp('vfy-journal-'), 'journal.sqlite')
  const result = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: mkVerification(1) })
  const j0 = openNodeJournal({ path: dbPath })
  assert.equal(j0.persistRunResult('rr_j', 'available', result).applied, true)
  j0.close()
  const j1 = openNodeJournal({ path: dbPath })
  assert.deepEqual(j1.getRunResult('rr_j')?.result?.verification, mkVerification(1))
  j1.close()
})

// ── supervisor: unknown profile / unavailable sandbox → NO agent runs ──────────
test('supervisor: an unknown profile / unavailable sandbox fails the run closed BEFORE the agent runs (no result)', async (t) => {
  const { runSupervisor } = await import('../src/runtime/supervisor.js')
  const store = await import('../src/store.js')
  const vibeDir = tmp('vfy-sup-')
  const prevVibe = process.env.VIBE_DIR, prevMock = process.env.VIBE_MOCK_OUTPUT, prevSbx = process.env.VIBE_VERIFIER_SANDBOX
  process.env.VIBE_DIR = vibeDir
  process.env.VIBE_MOCK_OUTPUT = JSON.stringify({ status: 'done', summary: 'x' }) // mock WOULD complete if it ran
  process.env.VIBE_VERIFIER_SANDBOX = 'none'; _resetSandboxDetectionCache()
  fs.mkdirSync(path.join(vibeDir, 'runs'), { recursive: true }); fs.mkdirSync(path.join(vibeDir, 'events'), { recursive: true })
  t.after(() => { process.env.VIBE_DIR = prevVibe; if (prevMock === undefined) delete process.env.VIBE_MOCK_OUTPUT; else process.env.VIBE_MOCK_OUTPUT = prevMock; if (prevSbx === undefined) delete process.env.VIBE_VERIFIER_SANDBOX; else process.env.VIBE_VERIFIER_SANDBOX = prevSbx; _resetSandboxDetectionCache() })

  const run = async (run_id: string, verify: { profile: string }) => {
    store.writeRun({ run_id, session_id: '', node_id: 'local', node_selector: 'local', agent: 'mock', status: 'queued', workspace_path: tmp('vfy-ws-'), verify, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never)
    await runSupervisor(run_id); return store.readRun(run_id)
  }
  // sandbox unavailable → fail closed even for a valid profile
  const a = await run('run_sbx', { profile: 'node-test' })
  assert.equal(a.status, 'failed'); assert.equal(a.failure_reason, 'verifier_unavailable'); assert.equal(a.task_result, undefined)
  // unknown profile → fail closed
  const b = await run('run_prof', { profile: 'definitely-not-a-profile' } as never)
  assert.equal(b.status, 'failed'); assert.equal(b.failure_reason, 'verifier_unavailable'); assert.equal(b.task_result, undefined)
})

// ── supervisor happy path (only where a real sandbox exists) ──────────────────
test('supervisor (live): mock agent → sandboxed `node-test` verifier → durable tests_passed → policy completes', skipUnlessSandbox ?? {}, async (t) => {
  const { runSupervisor } = await import('../src/runtime/supervisor.js')
  const store = await import('../src/store.js')
  const vibeDir = tmp('vfy-sup2-')
  const prevVibe = process.env.VIBE_DIR, prevMock = process.env.VIBE_MOCK_OUTPUT
  process.env.VIBE_DIR = vibeDir; process.env.VIBE_MOCK_OUTPUT = JSON.stringify({ status: 'done', summary: 'changed repo' })
  fs.mkdirSync(path.join(vibeDir, 'runs'), { recursive: true }); fs.mkdirSync(path.join(vibeDir, 'events'), { recursive: true })
  t.after(() => { process.env.VIBE_DIR = prevVibe; if (prevMock === undefined) delete process.env.VIBE_MOCK_OUTPUT; else process.env.VIBE_MOCK_OUTPUT = prevMock })
  const ws = tmp('vfy-repo-'); fs.writeFileSync(path.join(ws, 'x.test.js'), "const t=require('node:test');const a=require('node:assert');t('x',()=>a.equal(2,2))\n")
  store.writeRun({ run_id: 'run_ok', session_id: '', node_id: 'local', node_selector: 'local', agent: 'mock', status: 'queued', workspace_path: ws, verify: { profile: 'node-test' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never)
  await runSupervisor('run_ok')
  const rec = store.readRun('run_ok')
  assert.equal(rec.status, 'completed')
  assert.equal((rec.task_result as { verification?: TaskVerificationV1 }).verification?.kind, 'tests_passed')
  const evidence = assembleEvidence({ taskStatus: 'completed', result: (rec.task_result ?? null) as never, revisionBefore: null, revisionAfter: null })
  assert.equal(evaluateCompletion({ required_evidence: ['tests_passed'], require_tests_passed: true }, evidence, null).decision, 'complete')
})
