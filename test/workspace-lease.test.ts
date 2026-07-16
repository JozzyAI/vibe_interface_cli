/**
 * Node-authoritative workspace leases + revision evidence — the durable authority
 * that prevents concurrent workflows/tasks from mutating the same Node workspace.
 * Temporary journal DBs + temporary git workspaces only; never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { openNodeJournal } from '../src/node-journal/sqlite-journal.js'
import { observeWorkspaceRevision, workspaceLeaseId, isValidLease, isValidRevision, revisionsMatch, WorkspaceLeaseError } from '../src/lib/workspace-lease.js'

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-db-')), 'j.sqlite')
function gitWs(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-ws-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit --allow-empty -qm init', { cwd: ws })
  return ws
}

// ── contract / revision ─────────────────────────────────────────────────────

test('observeWorkspaceRevision: git state is bounded + deterministic; non-git → unavailable', () => {
  const ws = gitWs()
  const r1 = observeWorkspaceRevision(ws)
  assert.equal(r1.revision_kind, 'git'); assert.equal(r1.dirty, false)
  assert.ok(isValidRevision(r1))
  assert.equal(observeWorkspaceRevision(ws).state_hash, r1.state_hash) // deterministic for same state
  // a change flips the state_hash (out-of-band edit detection)
  fs.writeFileSync(path.join(ws, 'new.txt'), 'x')
  const r2 = observeWorkspaceRevision(ws)
  assert.notEqual(r2.state_hash, r1.state_hash)
  assert.ok(r2.revision_kind === 'git' && r2.dirty === true && r2.changed_files.includes('new.txt'))
  // a non-git dir → unavailable (never a false git claim)
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-plain-'))
  assert.equal(observeWorkspaceRevision(plain).revision_kind, 'unavailable')
})

test('workspaceLeaseId is deterministic + opaque + distinct per (workflow,node,workspace)', () => {
  const a = workspaceLeaseId('wf_1', 'node1', 'ws')
  assert.equal(a, workspaceLeaseId('wf_1', 'node1', 'ws')) // stable
  assert.match(a, /^wl_[0-9a-f]{32}$/)
  assert.notEqual(a, workspaceLeaseId('wf_2', 'node1', 'ws')) // per-workflow
  assert.notEqual(a, workspaceLeaseId('wf_1', 'node2', 'ws')) // per-node
  assert.notEqual(a, workspaceLeaseId('wf_1', 'node1', 'ws2')) // per-workspace
})

// ── node lease authority ────────────────────────────────────────────────────

test('node lease: acquire, idempotent same-workflow retry, cross-workflow conflict, survives reopen, idempotent release', () => {
  const dbp = tmpDb(); const rev = observeWorkspaceRevision(gitWs())
  let j = openNodeJournal({ path: dbp })
  const a = j.acquireWorkspaceLease('wf_A', 'node1', 'ws', rev)
  assert.equal(a.created, true); assert.equal(a.lease.status, 'active'); assert.ok(isValidLease(a.lease))
  assert.ok(revisionsMatch(a.lease.base_revision, rev))
  // same workflow retry → same lease, not created again
  const a2 = j.acquireWorkspaceLease('wf_A', 'node1', 'ws', rev)
  assert.equal(a2.created, false); assert.equal(a2.lease.workspace_lease_id, a.lease.workspace_lease_id)
  // different workflow → conflict, no lease
  assert.throws(() => j.acquireWorkspaceLease('wf_B', 'node1', 'ws', rev), (e: unknown) => e instanceof WorkspaceLeaseError && e.code === 'workspace_lease_conflict')
  // survives reopen (a Node restart never silently releases)
  j.close(); j = openNodeJournal({ path: dbp })
  assert.equal(j.getActiveWorkspaceLease('node1', 'ws')?.workspace_lease_id, a.lease.workspace_lease_id)
  // release idempotent → then another workflow can acquire
  assert.equal(j.releaseWorkspaceLease(a.lease.workspace_lease_id).lease.status, 'released')
  assert.equal(j.releaseWorkspaceLease(a.lease.workspace_lease_id).lease.status, 'released')
  assert.equal(j.getActiveWorkspaceLease('node1', 'ws'), null)
  assert.equal(j.acquireWorkspaceLease('wf_B', 'node1', 'ws', rev).created, true)
  j.close()
})

test('node lease: run-start gate rejects unleased/wrong runs, allows the matching lease + unleased workspaces', () => {
  const j = openNodeJournal({ path: tmpDb() }); const rev = observeWorkspaceRevision(gitWs())
  const a = j.acquireWorkspaceLease('wf_A', 'node1', 'ws', rev)
  // a run on a leased workspace WITHOUT the lease is rejected — backend must not start
  assert.throws(() => j.validateWorkspaceLeaseForRun('node1', 'ws', null), (e: unknown) => e instanceof WorkspaceLeaseError && e.code === 'workspace_lease_required')
  // a wrong/other lease id is rejected
  assert.throws(() => j.validateWorkspaceLeaseForRun('node1', 'ws', 'wl_deadbeef'), (e: unknown) => e instanceof WorkspaceLeaseError && e.code === 'workspace_lease_invalid')
  // the matching lease is allowed; an unleased workspace is always allowed
  assert.doesNotThrow(() => j.validateWorkspaceLeaseForRun('node1', 'ws', a.lease.workspace_lease_id))
  assert.doesNotThrow(() => j.validateWorkspaceLeaseForRun('node1', 'other-ws', null))
  // an unknown/stale lease presented on an UNLEASED workspace fails closed (not allowed)
  assert.throws(() => j.validateWorkspaceLeaseForRun('node1', 'other-ws', 'wl_unknown'), (e: unknown) => e instanceof WorkspaceLeaseError && e.code === 'workspace_lease_invalid')
  j.close()
})

test('node lease: SQLite partial uniqueness is the cross-connection authority (two journal connections)', () => {
  const dbp = tmpDb(); const rev = observeWorkspaceRevision(gitWs())
  const jA = openNodeJournal({ path: dbp })
  const jB = openNodeJournal({ path: dbp }) // a SECOND connection to the same DB
  assert.equal(jA.acquireWorkspaceLease('wf_A', 'node1', 'ws', rev).created, true)
  // B, on a separate connection, cannot acquire the same workspace for a different workflow
  assert.throws(() => jB.acquireWorkspaceLease('wf_B', 'node1', 'ws', rev), (e: unknown) => e instanceof WorkspaceLeaseError && e.code === 'workspace_lease_conflict')
  // B sees the same authoritative active lease
  assert.ok(jB.getActiveWorkspaceLease('node1', 'ws'))
  jA.close(); jB.close()
})

test('node lease: a released lease cannot authorize a run through the internal validation method', () => {
  const j = openNodeJournal({ path: tmpDb() }); const rev = observeWorkspaceRevision(gitWs())
  const a = j.acquireWorkspaceLease('wf_A', 'node1', 'ws', rev)
  j.releaseWorkspaceLease(a.lease.workspace_lease_id)
  // workflow B now holds the active lease
  const b = j.acquireWorkspaceLease('wf_B', 'node1', 'ws', rev)
  // A's now-released lease id must NOT authorize a run against B's active lease
  assert.throws(() => j.validateWorkspaceLeaseForRun('node1', 'ws', a.lease.workspace_lease_id), (e: unknown) => e instanceof WorkspaceLeaseError && e.code === 'workspace_lease_invalid')
  assert.doesNotThrow(() => j.validateWorkspaceLeaseForRun('node1', 'ws', b.lease.workspace_lease_id))
  j.close()
})

test('node lease: active leases are NOT removed by ordinary run retention', () => {
  const j = openNodeJournal({ path: tmpDb() }); const rev = observeWorkspaceRevision(gitWs())
  // A terminal run older than the cutoff (a terminal event sets terminal_event_recorded).
  j.ensureRun('rr_old'); j.append('rr_old', { type: 'status', timestamp: '2000-01-01T00:00:00.000Z', payload: {}, terminal: true, status: 'completed' })
  const a = j.acquireWorkspaceLease('wf_A', 'node1', 'ws', rev)
  const pruned = j.pruneTerminalRuns('2099-01-01T00:00:00.000Z')
  assert.equal(pruned.removed, 1); assert.equal(j.getRun('rr_old'), null) // the terminal run was pruned
  assert.equal(j.getActiveWorkspaceLease('node1', 'ws')?.workspace_lease_id, a.lease.workspace_lease_id) // the active lease survives retention
  j.close()
})

test('node lease: a corrupted persisted revision fails closed on read (nested JSON revalidated)', async () => {
  const dbp = tmpDb()
  const j = openNodeJournal({ path: dbp })
  const a = j.acquireWorkspaceLease('wf_A', 'node1', 'ws', observeWorkspaceRevision(gitWs()))
  j.close()
  const Database = (await import('better-sqlite3')).default
  const raw = new Database(dbp)
  raw.prepare('UPDATE workspace_leases SET current_revision_json = ? WHERE workspace_lease_id = ?').run('{"revision_kind":"git","state_hash":"nothex"}', a.lease.workspace_lease_id)
  raw.close()
  const j2 = openNodeJournal({ path: dbp })
  assert.throws(() => j2.getWorkspaceLease(a.lease.workspace_lease_id), (e: unknown) => (e as { code?: string }).code === 'corruption')
  j2.close()
})

test('node lease: revision observations are recorded and update the lease current_revision', () => {
  const j = openNodeJournal({ path: tmpDb() }); const ws = gitWs()
  const base = observeWorkspaceRevision(ws)
  const a = j.acquireWorkspaceLease('wf_A', 'node1', 'ws', base)
  // out-of-band change → new observation differs → detectable
  fs.writeFileSync(path.join(ws, 'f.txt'), 'y')
  const after = observeWorkspaceRevision(ws)
  const obs = j.recordWorkspaceRevision(a.lease.workspace_lease_id, 'sec1', 'after', after)
  assert.match(obs.observation_id, /^wro_/)
  const lease = j.getWorkspaceLease(a.lease.workspace_lease_id)!
  assert.ok(revisionsMatch(lease.current_revision, after))
  assert.ok(!revisionsMatch(lease.current_revision, base)) // moved past base
  j.close()
})

test('node lease: schema v3 migration is additive (v1/v2 run + result data preserved); leases carry no secrets', async () => {
  const dbp = tmpDb()
  const { buildTaskResult } = await import('../src/lib/agent-task-result.js')
  let j = openNodeJournal({ path: dbp })
  j.ensureRun('rr_1'); j.append('rr_1', { type: 'status', timestamp: new Date().toISOString(), payload: { s: 1 }, status: 'running' })
  j.persistRunResult('rr_1', 'available', buildTaskResult({ text: '{"a":1}' }))
  j.acquireWorkspaceLease('wf_A', 'node1', 'ws', observeWorkspaceRevision(gitWs()))
  j.close(); j = openNodeJournal({ path: dbp }) // reopen: additive migration preserved everything
  assert.equal(j.getRun('rr_1')?.last_sequence, 0)
  assert.equal(j.getRunResult('rr_1')?.result_status, 'available')
  assert.ok(j.getActiveWorkspaceLease('node1', 'ws'))
  j.close()
  const Database = (await import('better-sqlite3')).default
  const raw = new Database(dbp, { readonly: true })
  const row = JSON.stringify(raw.prepare('SELECT * FROM workspace_leases').all())
  raw.close()
  assert.ok(!/token|bearer|secret|aes_key|private_key|password/i.test(row))
})
