/**
 * Regression: the Node advertised `workspace_lease_v1` but a workspace-lease request
 * could be silently dropped (no ack) → Gateway timeout. These handlers are TOTAL:
 * every recognized acquire/get/release/observe request yields EXACTLY ONE structured
 * ack (success or sanitized error), and the capability is derived from the same
 * authority that backs the handlers so it can never be advertised without them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import {
  handleWorkspaceLeaseRequest, handleWorkspaceRevisionRequest, workspaceLeaseCapability,
  isWorkspaceLeaseRequestType, WORKSPACE_LEASE_REQUEST_TYPES, type NodeLeaseAuthority,
} from '../src/relay/node-lease-dispatch.js'
import { workspaceLeaseId, WorkspaceLeaseError, type WorkspaceLeaseV1, type WorkspaceRevision } from '../src/lib/workspace-lease.js'

const iso = () => new Date().toISOString()
const R0: WorkspaceRevision = { revision_kind: 'git', head_commit: '0'.repeat(40), dirty: false, state_hash: crypto.createHash('sha256').update('R0').digest('hex'), changed_files: [], observed_at: iso() }
const NODE = 'node_x'
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ndlease-'))
const deps = (authority: NodeLeaseAuthority | undefined, workspaceRoot = root()) => ({ nodeId: NODE, workspaceRoot, authority, observeRevision: () => R0 })

class FakeAuthority implements NodeLeaseAuthority {
  leases = new Map<string, WorkspaceLeaseV1>()
  throwOn?: 'acquire' | 'get' | 'release'; throwErr: Error = new Error('boom')
  acquireWorkspaceLease(wf: string, node: string, ws: string, base: WorkspaceRevision) {
    if (this.throwOn === 'acquire') throw this.throwErr
    const id = workspaceLeaseId(wf, node, ws)
    const existing = this.leases.get(id)
    if (existing) return { lease: existing, created: false } // deterministic idempotency
    const lease: WorkspaceLeaseV1 = { workspace_lease_id: id, workflow_id: wf, node_id: node, workspace_key: ws, mode: 'exclusive', status: 'active', base_revision: base, current_revision: base, acquired_at: iso() }
    this.leases.set(id, lease); return { lease, created: true }
  }
  getWorkspaceLease(id: string) { if (this.throwOn === 'get') throw this.throwErr; return this.leases.get(id) ?? null }
  releaseWorkspaceLease(id: string): { lease: WorkspaceLeaseV1 } { if (this.throwOn === 'release') throw this.throwErr; const l = this.leases.get(id); if (!l) throw new WorkspaceLeaseError('workspace_lease_invalid', 'no such lease'); this.leases.delete(id); return { lease: { ...l, status: 'released' as WorkspaceLeaseV1['status'] } } }
}

// ── capability is tied to handler authority ───────────────────────────────────
test('capability: workspace_lease_v1 is advertised IFF the lease authority (handlers) is present', () => {
  assert.equal(workspaceLeaseCapability(undefined), null)                // no authority → no capability
  assert.equal(workspaceLeaseCapability(new FakeAuthority()), 'workspace_lease_v1')
})

// ── acquire / get / release all yield a structured ack; idempotency preserved ─
test('acquire → structured ok ack; deterministic lease_id is idempotent (created:false on re-acquire)', () => {
  const a = new FakeAuthority(); const d = deps(a)
  const first = handleWorkspaceLeaseRequest({ type: 'workspace_lease_acquire', workflow_id: 'wf1', workspace_key: 'ws-key' }, d)
  assert.equal(first.ok, true); assert.equal(first.created, true)
  const id = first.lease!.workspace_lease_id
  const again = handleWorkspaceLeaseRequest({ type: 'workspace_lease_acquire', workflow_id: 'wf1', workspace_key: 'ws-key' }, d)
  assert.equal(again.ok, true); assert.equal(again.created, false)      // idempotent — no second lease
  assert.equal(again.lease!.workspace_lease_id, id)
  assert.equal(a.leases.size, 1)
})

test('get: present → ok+lease; absent → structured error ack (NOT silence)', () => {
  const a = new FakeAuthority(); const d = deps(a)
  handleWorkspaceLeaseRequest({ type: 'workspace_lease_acquire', workflow_id: 'wf1', workspace_key: 'ws-key' }, d)
  const id = workspaceLeaseId('wf1', NODE, 'ws-key')
  assert.equal(handleWorkspaceLeaseRequest({ type: 'workspace_lease_get', workspace_lease_id: id }, d).ok, true)
  const missing = handleWorkspaceLeaseRequest({ type: 'workspace_lease_get', workspace_lease_id: 'wl_nope' }, d)
  assert.equal(missing.ok, false); assert.equal(missing.code, 'workspace_lease_invalid')
})

test('release → structured ok ack', () => {
  const a = new FakeAuthority(); const d = deps(a)
  handleWorkspaceLeaseRequest({ type: 'workspace_lease_acquire', workflow_id: 'wf1', workspace_key: 'ws-key' }, d)
  const id = workspaceLeaseId('wf1', NODE, 'ws-key')
  const r = handleWorkspaceLeaseRequest({ type: 'workspace_lease_release', workspace_lease_id: id }, d)
  assert.equal(r.ok, true); assert.equal(r.lease!.status, 'released')
})

// ── THE FIX: no input path is silent or throws — always a structured ack ──────
test('regression: EVERY lease-request path produces a structured ack — no silent drop / no throw', () => {
  const missing = deps(undefined)                                        // authority absent
  for (const type of WORKSPACE_LEASE_REQUEST_TYPES) {
    const body = handleWorkspaceLeaseRequest({ type, workflow_id: 'wf1', workspace_key: 'ws-key', workspace_lease_id: 'wl_x' }, missing)
    assert.equal(typeof body.ok, 'boolean'); assert.equal(body.ok, false); assert.equal(body.code, 'workspace_lease_unavailable')
  }
  // authority that THROWS on every op → still a structured ack (never a thrown exception)
  for (const throwOn of ['acquire', 'get', 'release'] as const) {
    const a = new FakeAuthority(); a.throwOn = throwOn
    const type = `workspace_lease_${throwOn}`
    const generic = handleWorkspaceLeaseRequest({ type, workflow_id: 'wf1', workspace_key: 'ws-key', workspace_lease_id: 'wl_x' }, deps(a))
    assert.equal(generic.ok, false); assert.equal(generic.code, 'internal_error') // sanitized, not a leaked throw
  }
  // a structured WorkspaceLeaseError is preserved as its code
  const a2 = new FakeAuthority(); a2.throwOn = 'acquire'; a2.throwErr = new WorkspaceLeaseError('workspace_lease_conflict', 'held')
  const conflict = handleWorkspaceLeaseRequest({ type: 'workspace_lease_acquire', workflow_id: 'wf1', workspace_key: 'ws-key' }, deps(a2))
  assert.equal(conflict.ok, false); assert.equal(conflict.code, 'workspace_lease_conflict')
})

test('revision observe is total: ok+revision; bad key / throw → structured error (never silent)', () => {
  const d = deps(new FakeAuthority())
  assert.equal(handleWorkspaceRevisionRequest({ workspace_key: 'ws-key' }, d).ok, true)
  const bad = handleWorkspaceRevisionRequest({ workspace_key: '../escape' }, d)             // containment rejects
  assert.equal(bad.ok, false); assert.equal(bad.code, 'workspace_revision_unavailable')
  const boom = handleWorkspaceRevisionRequest({ workspace_key: 'ws-key' }, { nodeId: NODE, workspaceRoot: root(), authority: new FakeAuthority(), observeRevision: () => { throw new Error('git failed') } })
  assert.equal(boom.ok, false); assert.equal(boom.code, 'internal_error')
})

test('request-type guard recognizes the lease family', () => {
  assert.equal(isWorkspaceLeaseRequestType('workspace_lease_get'), true)
  assert.equal(isWorkspaceLeaseRequestType('run_start'), false)
})
