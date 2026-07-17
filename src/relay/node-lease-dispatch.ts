/**
 * Node-side workspace-lease RPC handling — TOTAL and testable.
 *
 * The Node advertised `workspace_lease_v1` but a lease request could reach the Node
 * (or a dispatch chain) with no handler matched and no response emitted, producing a
 * SILENT timeout at the Gateway. These handlers guarantee the opposite invariant:
 * every recognized workspace-lease / workspace-revision request produces EXACTLY ONE
 * structured ack (success or a sanitized error) — they never throw and never return
 * void. The capability is derived from the same authority object that backs the
 * handlers, so advertisement can never drift from actual handling.
 *
 * Ownership + containment are unchanged (the Node journal is the authority; keys are
 * resolved through `resolveContainedWorkspace`), and deterministic `lease_id`
 * idempotency is preserved (the journal keys on workflow+node+workspace).
 */
import { WorkspaceLeaseError, observeWorkspaceRevision, type WorkspaceLeaseV1, type WorkspaceRevision } from '../lib/workspace-lease.js'
import { resolveContainedWorkspace } from '../workspace.js'
import { WORKSPACE_LEASE_CAPABILITY } from '../node-journal/contract.js'

/** The workspace-lease request types the Node handles. The Gateway waits for a
 *  `workspace_lease_ack`; every one of these MUST yield exactly one. */
export const WORKSPACE_LEASE_REQUEST_TYPES = ['workspace_lease_acquire', 'workspace_lease_get', 'workspace_lease_release'] as const
export const WORKSPACE_REVISION_REQUEST_TYPES = ['workspace_revision_observe'] as const
export type WorkspaceLeaseRequestType = (typeof WORKSPACE_LEASE_REQUEST_TYPES)[number]

export function isWorkspaceLeaseRequestType(t: unknown): t is WorkspaceLeaseRequestType {
  return typeof t === 'string' && (WORKSPACE_LEASE_REQUEST_TYPES as readonly string[]).includes(t)
}
export function isWorkspaceRevisionRequestType(t: unknown): boolean {
  return typeof t === 'string' && (WORKSPACE_REVISION_REQUEST_TYPES as readonly string[]).includes(t)
}

/** The minimal Node-authority surface the handlers need (SqliteNodeJournal satisfies
 *  it). Absent ⇒ the Node cannot enforce leases: the capability is NOT advertised and
 *  every request gets a structured `workspace_lease_unavailable` (never silence). */
export interface NodeLeaseAuthority {
  acquireWorkspaceLease(workflowId: string, nodeId: string, workspaceKey: string, baseRevision: WorkspaceRevision): { lease: WorkspaceLeaseV1; created: boolean }
  getWorkspaceLease(leaseId: string): WorkspaceLeaseV1 | null
  releaseWorkspaceLease(leaseId: string): { lease: WorkspaceLeaseV1 }
}

export interface LeaseHandlerDeps {
  nodeId: string
  workspaceRoot: string
  authority: NodeLeaseAuthority | undefined
  /** Injectable for tests; defaults to the real read-only git observer. */
  observeRevision?: (workspacePath: string) => WorkspaceRevision
}

/** The `workspace_lease_ack` body (minus routing envelope). ALWAYS produced. */
export interface LeaseAckBody { ok: boolean; created?: boolean; lease?: WorkspaceLeaseV1; error?: string; code?: string }
/** The `workspace_revision_ack` body (minus routing envelope). ALWAYS produced. */
export interface RevisionAckBody { ok: boolean; revision?: WorkspaceRevision; error?: string; code?: string }

interface LeaseReq { type: string; workflow_id?: string; workspace_key?: string; workspace_lease_id?: string }

/**
 * Handle a workspace_lease_{acquire,get,release} request. Returns EXACTLY ONE
 * structured ack body — never throws, never returns void. A missing authority, a bad
 * key, a missing lease, a structured lease error, or ANY unexpected exception all map
 * to a bounded, sanitized error body (no path/SQL/token/stack).
 */
export function handleWorkspaceLeaseRequest(msg: LeaseReq, deps: LeaseHandlerDeps): LeaseAckBody {
  const authority = deps.authority
  if (!authority) return { ok: false, error: 'node cannot enforce workspace leases', code: 'workspace_lease_unavailable' }
  const observe = deps.observeRevision ?? observeWorkspaceRevision
  try {
    if (msg.type === 'workspace_lease_acquire') {
      const wsr = resolveContainedWorkspace(String(msg.workspace_key), deps.workspaceRoot)
      if (!wsr.ok) return { ok: false, error: 'invalid workspace key', code: 'workspace_lease_invalid' }
      const base = observe(wsr.path)
      const r = authority.acquireWorkspaceLease(String(msg.workflow_id), deps.nodeId, String(msg.workspace_key), base)
      return { ok: true, created: r.created, lease: r.lease }
    }
    if (msg.type === 'workspace_lease_get') {
      const lease = authority.getWorkspaceLease(String(msg.workspace_lease_id))
      return lease ? { ok: true, lease } : { ok: false, error: 'no such lease', code: 'workspace_lease_invalid' }
    }
    if (msg.type === 'workspace_lease_release') {
      const r = authority.releaseWorkspaceLease(String(msg.workspace_lease_id))
      return { ok: true, lease: r.lease }
    }
    // Defensive: a request routed here that is NOT a lease op still gets a structured
    // error rather than a silent drop.
    return { ok: false, error: `unsupported workspace-lease request: ${msg.type}`, code: 'workspace_lease_unavailable' }
  } catch (err) {
    if (err instanceof WorkspaceLeaseError) return { ok: false, error: 'workspace lease operation failed', code: err.code }
    return { ok: false, error: 'internal error', code: 'internal_error' }
  }
}

/** Handle a workspace_revision_observe request. Returns EXACTLY ONE structured ack
 *  body — never throws, never returns void. */
export function handleWorkspaceRevisionRequest(msg: { workspace_key?: string }, deps: LeaseHandlerDeps): RevisionAckBody {
  const observe = deps.observeRevision ?? observeWorkspaceRevision
  try {
    const wsr = resolveContainedWorkspace(String(msg.workspace_key), deps.workspaceRoot)
    if (!wsr.ok) return { ok: false, error: 'invalid workspace key', code: 'workspace_revision_unavailable' }
    return { ok: true, revision: observe(wsr.path) }
  } catch { return { ok: false, error: 'internal error', code: 'internal_error' } }
}

/**
 * The workspace-lease capability to advertise — derived from the SAME authority that
 * backs the handlers, so `workspace_lease_v1` is advertised IFF the acquire/get/release
 * handlers can actually run. Returns the capability string, or null when unavailable.
 */
export function workspaceLeaseCapability(authority: NodeLeaseAuthority | undefined): string | null {
  return authority ? WORKSPACE_LEASE_CAPABILITY : null
}
