/**
 * Codex workspace-write permission: map the task's permission mode + write
 * policy + the Node-validated workspace lease to the narrowest Codex sandbox.
 *
 * Two layers:
 *   1. resolveCodexSandbox — the PURE decision (read-only / workspace-write /
 *      fail-closed), covering the lease states.
 *   2. runSupervisor codex gate — end to end with a FAKE codex that records its
 *      exact argv and writes a file into its cwd, proving the invocation and the
 *      fail-closed behaviour (Codex never launches on a bad lease).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Isolate the store BEFORE importing modules that resolve VIBE_DIR.
const VIBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cxww-'))
process.env.VIBE_DIR = VIBE_DIR

const { writeRun, readRun } = await import('../src/store.js')
const { readEvents } = await import('../src/events.js')
const { runSupervisor } = await import('../src/runtime/supervisor.js')
const { resolveCodexSandbox } = await import('../src/runtime/codex-sandbox.js')
const { validateWorkflowSpec } = await import('../src/workflow/validator.js')
const { validateCreateTaskRequest } = await import('../src/lib/agent-task-contract.js')
const { computeRequestFingerprint } = await import('../src/lib/request-fingerprint.js')
const { GatewayAgentTaskClient } = await import('../src/workflow/task-client.js')
type WorkspaceLeaseV1 = import('../src/lib/workspace-lease.js').WorkspaceLeaseV1
type GatewayClient = import('../src/mcp/gateway-client.js').GatewayClient
import type { RunRecord } from '../src/types.js'

// ── a fake `codex` on PATH that records argv + its cwd-writes + prompt/env ─────
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-fakecodex-'))
const ARGV_OUT = path.join(fakeDir, 'argv.json')
const STDIN_OUT = path.join(fakeDir, 'stdin.txt')
const ENV_OUT = path.join(fakeDir, 'env.json')
fs.writeFileSync(path.join(fakeDir, 'codex'), `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
fs.writeFileSync(${JSON.stringify(ARGV_OUT)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(ENV_OUT)}, JSON.stringify(process.env));
try { fs.writeFileSync(path.join(process.cwd(),'codex-wrote.txt'),'hi'); } catch(e){}
const i=process.argv.indexOf('--output-last-message');
if(i>=0&&process.argv[i+1]) { try{ fs.writeFileSync(process.argv[i+1],'done'); }catch(e){} }
let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ fs.writeFileSync(${JSON.stringify(STDIN_OUT)}, s); process.stdout.write('Completed\\n'); process.exit(0); });
`)
fs.chmodSync(path.join(fakeDir, 'codex'), 0o755)
process.env.PATH = fakeDir + path.delimiter + process.env.PATH

let n = 0
function mkRun(fields: Partial<RunRecord>): { run_id: string; ws: string } {
  const run_id = `run_cxww_${++n}_${Math.random().toString(36).slice(2, 6)}`
  const ws = path.join(VIBE_DIR, 'ws', run_id)
  fs.mkdirSync(ws, { recursive: true })
  const now = new Date().toISOString()
  writeRun({ run_id, session_id: '', node_id: 'n1', agent: 'codex', status: 'queued', workspace_path: ws, workspace_key: 'ws1', created_at: now, updated_at: now, ...fields } as RunRecord)
  return { run_id, ws }
}
const activeLease = (over: Partial<WorkspaceLeaseV1> = {}): WorkspaceLeaseV1 => ({ workspace_lease_id: 'wl_x', workflow_id: 'wf1', node_id: 'n1', workspace_key: 'ws1', mode: 'exclusive', status: 'active', ...over })
const argv = (): string[] | null => { try { return JSON.parse(fs.readFileSync(ARGV_OUT, 'utf8')) } catch { return null } }
const capturedEnv = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(ENV_OUT, 'utf8')) } catch { return {} } }
const capturedStdin = (): string => { try { return fs.readFileSync(STDIN_OUT, 'utf8') } catch { return '' } }
const clearArgv = () => { for (const f of [ARGV_OUT, ENV_OUT, STDIN_OUT]) { try { fs.unlinkSync(f) } catch { /* */ } } }
const errCode = (run_id: string): string | undefined => (readEvents(run_id).find((e) => e.type === 'error') as { code?: string } | undefined)?.code
const cdOf = (a: string[]): string => a[a.indexOf('--cd') + 1]
// Any token that would widen capability beyond a workspace filesystem write.
const CAP_TOKENS = ['danger-full-access', '--dangerously-bypass-approvals-and-sandbox', '-c', '--config', 'sandbox_permissions', 'disk-full-read-access', 'disk-full-write-access', 'network', 'net', '--full-auto', '-a', '--ask-for-approval', '--writable-root']
const hasCapToken = (a: string[]): string | undefined => a.find((x) => CAP_TOKENS.includes(x) || /network|writable-root|full-access|sandbox_permissions/i.test(x))

// ── 1. PURE decision function ────────────────────────────────────────────────
test('resolveCodexSandbox: default + active matching writable lease → workspace-write scoped to workspace', () => {
  const d = resolveCodexSandbox({ permissionMode: 'default', writeRequested: true, lease: 'active_match', workspacePath: '/leased/ws' })
  assert.equal(d.ok, true)
  assert.equal(d.ok && d.mode, 'workspace-write')
  assert.equal(d.ok && d.writableRoot, '/leased/ws') // writable area = the leased workspace only
  assert.equal(d.diagnostics.network, 'restricted') // network stays disabled
  assert.equal(d.diagnostics.approvals, 'never')     // unattended
})
test('resolveCodexSandbox: default + no/inactive/mismatched/invalid lease → fail closed with a distinct code', () => {
  for (const [lease, code] of [['none', 'workspace_lease_required'], ['inactive', 'workspace_lease_inactive'], ['mismatch', 'workspace_lease_mismatch'], ['invalid', 'workspace_lease_invalid']] as const) {
    const d = resolveCodexSandbox({ permissionMode: 'default', writeRequested: true, lease, workspacePath: '/ws' })
    assert.equal(d.ok, false, `${lease} must fail closed`)
    assert.equal(!d.ok && d.code, code)
  }
})
test('resolveCodexSandbox: read-only task stays read-only even with an active lease (never escalates)', () => {
  const d = resolveCodexSandbox({ permissionMode: 'default', writeRequested: false, lease: 'active_match', workspacePath: '/ws' })
  assert.equal(d.ok && d.mode, 'read-only')
  assert.equal(d.diagnostics.lease_state, 'not_consulted')
})

// ── 2. supervisor codex gate (end to end, fake codex) ────────────────────────
test('gate: default + active matching writable lease → codex runs --sandbox workspace-write and writes inside the leased workspace', async () => {
  clearArgv()
  const { run_id, ws } = mkRun({ workspace_write: true, workspace_lease_id: 'wl_x' })
  await runSupervisor(run_id, { resolveWorkspaceLease: () => activeLease() })
  assert.equal(readRun(run_id).status, 'completed')
  const a = argv()!
  assert.ok(a.includes('--sandbox') && a[a.indexOf('--sandbox') + 1] === 'workspace-write', `argv: ${JSON.stringify(a)}`)
  // writable root scoped to the leased workspace (via --cd), nothing wider.
  assert.equal(a[a.indexOf('--cd') + 1], ws)
  assert.ok(fs.existsSync(path.join(ws, 'codex-wrote.txt'))) // wrote INSIDE the leased workspace (#5)
})

test('gate: the workspace-write invocation never grants danger-full-access or a writable root outside the lease (#6/#7)', async () => {
  clearArgv()
  const { run_id, ws } = mkRun({ workspace_write: true, workspace_lease_id: 'wl_x' })
  await runSupervisor(run_id, { resolveWorkspaceLease: () => activeLease() })
  const a = argv()!
  assert.ok(!a.includes('danger-full-access'), 'must never use danger-full-access')
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'), 'default must never bypass the sandbox')
  // The only writable-root signal is --cd = the leased workspace; no second root.
  assert.equal(a.filter((x) => x === '--cd').length, 1)
  assert.equal(a[a.indexOf('--cd') + 1], ws)
})

test('gate: default + no lease bound → fail closed, codex NEVER launches (#2)', async () => {
  clearArgv()
  const { run_id } = mkRun({ workspace_write: true }) // no workspace_lease_id
  await runSupervisor(run_id, { resolveWorkspaceLease: () => { throw new Error('must not be consulted') } })
  assert.equal(readRun(run_id).status, 'failed')
  assert.equal(errCode(run_id), 'workspace_lease_required')
  assert.equal(argv(), null, 'codex must not have been spawned')
})

test('gate: default + inactive / mismatched / missing lease record → fail closed (#3)', async () => {
  for (const [over, code] of [
    [activeLease({ status: 'released' }), 'workspace_lease_inactive'],
    [activeLease({ workspace_key: 'other-ws' }), 'workspace_lease_mismatch'],
    [null, 'workspace_lease_invalid'],
  ] as const) {
    clearArgv()
    const { run_id } = mkRun({ workspace_write: true, workspace_lease_id: 'wl_x' })
    await runSupervisor(run_id, { resolveWorkspaceLease: () => over })
    assert.equal(readRun(run_id).status, 'failed', `${code} should fail`)
    assert.equal(errCode(run_id), code)
    assert.equal(argv(), null, 'codex must not have been spawned')
  }
})

test('gate: explicitly read-only task stays read-only even WITH an active lease (#4)', async () => {
  clearArgv()
  const { run_id } = mkRun({ workspace_write: false, workspace_lease_id: 'wl_x' })
  await runSupervisor(run_id, { resolveWorkspaceLease: () => activeLease() })
  assert.equal(readRun(run_id).status, 'completed')
  const a = argv()!
  assert.ok(!a.includes('--sandbox'), `read-only must not request a write sandbox; argv: ${JSON.stringify(a)}`)
})

test('gate: unsafe-skip preserves its explicit bypass (unchanged public semantics)', async () => {
  clearArgv()
  const { run_id } = mkRun({ workspace_write: true, workspace_lease_id: 'wl_x', permission_mode: 'unsafe-skip' })
  await runSupervisor(run_id, { resolveWorkspaceLease: () => { throw new Error('gate must be skipped for unsafe-skip') } })
  assert.equal(readRun(run_id).status, 'completed')
  const a = argv()!
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(!a.includes('--sandbox'))
})

// ── Gate 1: invocation containment (canonical/realpath) ──────────────────────
test('containment: --cd realpath == the leased workspace exactly, never a broader parent/alias, even through a symlink', async () => {
  clearArgv()
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-realws-'))
  const alias = path.join(os.tmpdir(), `vibe-alias-${Math.random().toString(36).slice(2, 8)}`)
  fs.symlinkSync(real, alias) // an alias that must NOT widen the writable root
  const run_id = `run_cxww_sym_${Math.random().toString(36).slice(2, 6)}`
  const now = new Date().toISOString()
  writeRun({ run_id, session_id: '', node_id: 'n1', agent: 'codex', status: 'queued', workspace_path: alias, workspace_key: 'ws1', workspace_write: true, workspace_lease_id: 'wl_x', created_at: now, updated_at: now } as RunRecord)
  await runSupervisor(run_id, { resolveWorkspaceLease: () => activeLease() })
  assert.equal(readRun(run_id).status, 'completed')
  const a = argv()!
  assert.deepEqual([a[a.indexOf('--sandbox')], a[a.indexOf('--sandbox') + 1]], ['--sandbox', 'workspace-write'])
  const cdReal = fs.realpathSync(cdOf(a))
  assert.equal(cdReal, fs.realpathSync(real), 'writable root resolves to the leased workspace')
  assert.notEqual(cdReal, fs.realpathSync(path.dirname(real)), 'writable root is NOT the parent of the lease')
  assert.equal(a.filter((x) => x === '--cd').length, 1, 'exactly one writable root')
  assert.ok(!hasCapToken(a), `no capability-widening flag; argv: ${JSON.stringify(a)}`)
  assert.ok(fs.existsSync(path.join(real, 'codex-wrote.txt')), 'the write landed inside the REAL leased workspace')
  fs.rmSync(alias, { force: true }); fs.rmSync(real, { recursive: true, force: true })
})

// ── Gate 2: policy preservation — workspace_write flips ONLY the fs sandbox ───
const normArgv = (a: string[]): string[] => {
  const o: string[] = []
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--cd') { o.push('--cd', '<ws>'); i++; continue }
    if (a[i] === '--output-last-message') { o.push('--output-last-message', '<f>'); i++; continue }
    o.push(a[i])
  }
  return o
}
test('policy: workspace-write launch differs from read-only by EXACTLY `--sandbox workspace-write` (no network/secret/push/deploy/external flag)', async () => {
  clearArgv(); const ro = mkRun({ workspace_write: false, workspace_lease_id: 'wl_x' })
  await runSupervisor(ro.run_id, { resolveWorkspaceLease: () => activeLease() })
  const roArgv = normArgv(argv()!)
  clearArgv(); const rw = mkRun({ workspace_write: true, workspace_lease_id: 'wl_x' })
  await runSupervisor(rw.run_id, { resolveWorkspaceLease: () => activeLease() })
  const rwArgv = normArgv(argv()!)
  // Remove the single sandbox pair from the write argv → must equal the read-only argv.
  const si = rwArgv.indexOf('--sandbox')
  const rwMinusSandbox = [...rwArgv.slice(0, si), ...rwArgv.slice(si + 2)]
  assert.deepEqual(rwMinusSandbox, roArgv, 'workspace_write adds ONLY the sandbox mode; nothing else changes')
  assert.deepEqual([rwArgv[si], rwArgv[si + 1]], ['--sandbox', 'workspace-write'])
  assert.ok(!hasCapToken(rwArgv) && !hasCapToken(roArgv), 'no network/secrets/push/deploy/external capability flags')
})
test('policy: workspace_write + lease id are NOT forwarded to the provider (prompt/env)', async () => {
  clearArgv()
  const { run_id } = mkRun({ workspace_write: true, workspace_lease_id: 'wl_secret_lease' })
  await runSupervisor(run_id, { resolveWorkspaceLease: () => activeLease({ workspace_lease_id: 'wl_secret_lease' }) })
  const stdin = capturedStdin(); const env = capturedEnv()
  assert.ok(!/workspace_write|wl_secret_lease/.test(stdin), 'the prompt never carries the flag or lease id')
  for (const [k, v] of Object.entries(env)) {
    assert.ok(!/workspace_write/i.test(k), `env key ${k} must not carry the write flag`)
    assert.ok(!String(v).includes('wl_secret_lease'), `env value for ${k} must not carry the lease id`)
  }
})

// ── Gate 3: write-intent compatibility (spec → task → run_start, once) ────────
const specWith = (stepExtra: Record<string, unknown> = {}) => ({
  version: '1', name: 'w', entry_step: 'go', inputs: {},
  agents: { solo: { agent: 'mock' } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 3, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 2 },
  steps: [{ id: 'go', type: 'agent_task', agent_role: 'solo', prompt_template: 'do', output_schema: 'o', ...stepExtra }],
  edges: [{ from: 'go', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: {},
})
const specErr = (spec: unknown, code: string) => validateWorkflowSpec(spec).issues.some((i) => i.severity === 'error' && i.code === code)

test('compat: an existing spec WITHOUT workspace_write is valid; the field is optional and defaults to read-only', () => {
  assert.equal(validateWorkflowSpec(specWith()).valid, true)
  // Default read-only: no write policy → the decision is read-only.
  assert.equal(resolveCodexSandbox({ permissionMode: 'default', writeRequested: false, lease: 'active_match', workspacePath: '/ws' }).ok, true)
})
test('compat: workspace_write is accepted ONLY on a step that binds a workspace; validation rejects it otherwise', () => {
  assert.equal(validateWorkflowSpec(specWith({ workspace_write: true, workspace_key_template: 'wsk' })).valid, true) // bound → ok
  assert.equal(validateWorkflowSpec(specWith({ workspace_write: false })).valid, true)                             // read-only, no ws needed
  assert.ok(specErr(specWith({ workspace_write: true }), 'workspace_write_requires_workspace'))                     // write, no ws → reject
  assert.ok(specErr(specWith({ workspace_write: 'yes' }), 'bad_workspace_write'))                                   // non-boolean → reject
})
test('compat: workspace_write survives task creation into execution.workspace_write EXACTLY ONCE, not as provider input', async () => {
  let body: Record<string, unknown> | undefined
  const fake = { startTask: async (b: Record<string, unknown>) => { body = b; return { task_id: 't1' } } } as unknown as GatewayClient
  await new GatewayAgentTaskClient(fake).createTask({ agent: 'codex', input: { text: 'hi' }, workspace_key: 'wsk', permission_mode: 'default', workspace_write: true, workspace_lease_id: 'wl_x', idempotency_key: 'se_1' })
  const exec = body!.execution as { workspace_write?: boolean; permission_mode?: string }
  assert.equal(exec.workspace_write, true)
  assert.equal(exec.permission_mode, 'default')
  assert.equal((body!.input as Record<string, unknown>).workspace_write, undefined) // never provider input
  assert.equal((body!.metadata as Record<string, unknown> | undefined)?.workspace_write, undefined) // never metadata
  assert.equal((JSON.stringify(body).match(/workspace_write/g) || []).length, 1, 'mapped exactly once')
})
test('compat: the task contract accepts a boolean workspace_write and rejects a non-boolean', () => {
  const ok = validateCreateTaskRequest({ agent: 'codex', input: { text: 'hi' }, execution: { permission_mode: 'default', workspace_write: true } })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.value.execution?.workspace_write, true)
  const bad = validateCreateTaskRequest({ agent: 'codex', input: { text: 'hi' }, execution: { workspace_write: 'yes' } })
  assert.equal(bad.ok, false)
})
test('compat: workspace_write participates in the request fingerprint (a write request is distinct from a read-only one)', () => {
  const base = { agent: 'codex', input: { text: 'hi' }, workspace: { workspace_key: 'wsk' }, idempotency_key: 'se_1' } as const
  const ro = computeRequestFingerprint({ ...base })
  const rw = computeRequestFingerprint({ ...base, execution: { workspace_write: true } })
  assert.notEqual(ro, rw)
})
