/**
 * Spawned-CLI adapters must record the AUTHORITATIVE child process exit code on
 * both success and failure — so a clean exit 0 survives all the way to
 * AgentTaskResult.process_exit_code and satisfies a completion policy that
 * requires `exit_code` evidence. (The dogfood wf_bf4c93e9 blocked because the
 * success path dropped exitCode → durable process_exit_code was null.)
 *
 * The failing SOURCE was exec.ts; the downstream chain already treats 0 as a
 * real value (`?? null`, `!== undefined`, `!== null`). These tests cover the
 * source and the full 0-propagation path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Isolate the store BEFORE importing modules that resolve VIBE_DIR.
const VIBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-exitcode-'))
process.env.VIBE_DIR = VIBE_DIR

const { writeRun } = await import('../src/store.js')
const { execAgent } = await import('../src/runtime/adapters/exec.js')
const { buildTaskResult, validateTaskResult } = await import('../src/lib/agent-task-result.js')
const { buildTaskVerification } = await import('../src/lib/task-verification.js')
const { assembleEvidence, evaluateCompletion } = await import('../src/workflow/completion-policy.js')
const { openNodeJournal } = await import('../src/node-journal/sqlite-journal.js')
import type { RunRecord } from '../src/types.js'
import type { WorkspaceRevision } from '../src/lib/workspace-lease.js'

// ── fake spawned binaries on PATH (exit 0 / exit 3 / self-signal) ─────────────
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-exitbin-'))
const mkbin = (name: string, body: string) => {
  const p = path.join(binDir, name)
  fs.writeFileSync(p, `#!/usr/bin/env node\nlet s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{${body}});\n`)
  fs.chmodSync(p, 0o755)
}
mkbin('agok', 'process.exit(0)')
mkbin('agfail', 'process.exit(3)')
mkbin('agsig', "process.kill(process.pid,'SIGKILL')")
process.env.PATH = binDir + path.delimiter + process.env.PATH

let n = 0
async function runBinary(binary: string): Promise<{ result: string; exitCode?: number; failureMessage?: string }> {
  const run_id = `run_exit_${++n}_${Math.random().toString(36).slice(2, 6)}`
  const ws = path.join(VIBE_DIR, 'ws', run_id)
  fs.mkdirSync(ws, { recursive: true })
  const now = new Date().toISOString()
  writeRun({ run_id, session_id: '', node_id: 'local', agent: 'codex', status: 'running', workspace_path: ws, created_at: now, updated_at: now } as RunRecord)
  const out = await execAgent({ run_id, session_id: '', workspace_path: ws } as RunRecord, {}, {
    binary, label: binary, buildArgs: () => [], onStdoutLine: () => { /* */ },
  })
  return { result: out.result, exitCode: out.exitCode, failureMessage: out.failureMessage }
}

// ── 1–4: exec adapter records the real exit code ─────────────────────────────
test('exec: successful spawned process (exit 0) → AgentOutcome.exitCode === 0', async () => {
  const o = await runBinary('agok')
  assert.equal(o.result, 'completed')
  assert.equal(o.exitCode, 0)          // the real 0, not undefined
  assert.notEqual(o.exitCode, undefined)
})
test('exec: non-zero process exit → the real code is preserved', async () => {
  const o = await runBinary('agfail')
  assert.equal(o.result, 'failed')
  assert.equal(o.exitCode, 3)
})
test('exec: signal termination → failed, NOT a false exit 0', async () => {
  const o = await runBinary('agsig')
  assert.equal(o.result, 'failed')
  assert.equal(o.exitCode, undefined)  // never synthesized to 0
  assert.match(o.failureMessage ?? '', /signal/)
})
test('exec: spawn failure (missing binary) → existing failure behavior, no false exit code', async () => {
  const o = await runBinary('ag-does-not-exist-xyz')
  assert.equal(o.result, 'failed')
  assert.equal(o.exitCode, undefined)
  assert.match(o.failureMessage ?? '', /not found|failed to start/)
})

// ── 5: a successful outcome's 0 reaches the durable AgentTaskResult ──────────
test('AgentTaskResult: a completed outcome with exitCode 0 → process_exit_code === 0', () => {
  const r = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0 })
  assert.equal(r.process_exit_code, 0) // 0 preserved (not coerced to null)
})

// ── 6: completion policy requiring exit_code accepts the durable 0 ──────────
const gitRev = (hash: string, changed: string[] = []): WorkspaceRevision => ({ revision_kind: 'git', head_commit: null, dirty: changed.length > 0, state_hash: hash.padEnd(64, '0'), changed_files: changed, observed_at: new Date().toISOString() })
type CompletionPolicy = Parameters<typeof evaluateCompletion>[0]
const policy: CompletionPolicy = { required_evidence: ['task_status', 'exit_code', 'workspace_revision', 'changed_files', 'tests_passed'], require_repository_change: true, require_tests_passed: true, require_no_remaining_work: true }
const verification0 = buildTaskVerification({ profile: 'node-test', argv: ['node', '--test'], exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output: 'ok' })

test('completion policy: durable process_exit_code 0 SATISFIES the required exit_code evidence → complete', () => {
  const result = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0, verification: verification0 })
  const e = assembleEvidence({ taskStatus: 'completed', result, revisionBefore: gitRev('aaaa'), revisionAfter: gitRev('bbbb', ['slugify.js']) })
  assert.equal(e.exit_code, 0)
  assert.deepEqual(evaluateCompletion(policy, e, null), { decision: 'complete' })
})
test('completion policy: a NULL process_exit_code still blocks on exit_code (the pre-fix dogfood symptom)', () => {
  const result = buildTaskResult({ text: '{"status":"done"}', verification: verification0 }) // no processExitCode → null
  const e = assembleEvidence({ taskStatus: 'completed', result, revisionBefore: gitRev('aaaa'), revisionAfter: gitRev('bbbb', ['slugify.js']) })
  assert.equal(e.exit_code, null)
  const d = evaluateCompletion(policy, e, null)
  assert.equal(d.decision, 'blocked')
  assert.ok(d.decision === 'blocked' && d.missing.includes('exit_code'))
})

// ── 7: serialization/storage preserves numeric 0 (not dropped as falsy) ──────
test('serialization: JSON round-trip + validation keep process_exit_code === 0', () => {
  const r = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0 })
  const round = JSON.parse(JSON.stringify(r))
  assert.equal(round.process_exit_code, 0)
  const v = validateTaskResult(round)
  assert.equal(v.ok, true)
  assert.equal(v.ok && v.value.process_exit_code, 0)
})
test('storage: node journal persists + reads back process_exit_code === 0', () => {
  const j = openNodeJournal({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-jrnl-')), 'j.sqlite') })
  const rid = 'run_store_0'
  j.ensureRun(rid, 'running')
  const r = buildTaskResult({ text: '{"status":"done"}', processExitCode: 0 })
  j.persistRunResult(rid, 'available', r)
  const back = j.getRunResult(rid)
  assert.equal(back?.result?.process_exit_code, 0) // survives durable round-trip
})
