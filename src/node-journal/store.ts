/**
 * NodeJournal interface — the only contract callers depend on. SYNCHRONOUS: the
 * backend-capture loop appends BEFORE publishing, so ordering must be immediate
 * (the SQLite backend is synchronous). The driver is hidden behind this interface.
 */
import type { NodeRunEvent, NodeRunEventInput, NodeRunMeta, ReplayMetadata } from './contract.js'

export interface JournalHealth { ok: boolean; schema_version: number; foreign_keys: boolean; journal_mode: string; busy_timeout: number }

/** A durable Node run result (authoritative control result, keyed by remote_run_id). */
export interface NodeRunResult { remote_run_id: string; result_status: string; result: import('../lib/agent-task-result.js').AgentTaskResultV1 | null }

/** A race-free replay→live subscription. Replay events are delivered first (in
 *  order), then live appends; a slow subscriber's queue is bounded. */
export interface JournalSubscription {
  readonly remote_run_id: string
  readonly overflowed: boolean
  readonly closed: boolean
  close(): void
}

export interface SubscribeOptions {
  /** NODE source cursor (domain 1); -1 replays from sequence 0. */
  afterSequence: number
  /** Called for each event (replay then live), strictly in sequence order. */
  onEvent: (event: NodeRunEvent) => void
  /** Called once with replay metadata at establishment (before any event). */
  onEstablished?: (meta: ReplayMetadata) => void
  /** Called if this subscriber's bounded queue overflows (it is then dropped). */
  onOverflow?: () => void
  /** Max buffered LIVE events before overflow (replay is delivered directly). */
  maxQueue?: number
}

export interface NodeJournal {
  // lifecycle
  migrate(): number
  healthCheck(): JournalHealth
  close(): void

  // capture — journal BEFORE publish. `append` assigns the next sequence.
  ensureRun(remoteRunId: string, status?: string): NodeRunMeta
  append(remoteRunId: string, event: NodeRunEventInput): NodeRunEvent
  /** Explicit-sequence append (idempotent duplicate / gap-checked) for resilience. */
  appendAt(remoteRunId: string, sequence: number, event: NodeRunEventInput): { event: NodeRunEvent; duplicate: boolean }
  markStatus(remoteRunId: string, status: string, terminalAt?: string | null): NodeRunMeta

  // durable Node-authoritative workspace leases (exclusive per node_id+workspace_key)
  acquireWorkspaceLease(workflowId: string, nodeId: string, workspaceKey: string, baseRevision: import('../lib/workspace-lease.js').WorkspaceRevision): { lease: import('../lib/workspace-lease.js').WorkspaceLeaseV1; created: boolean }
  getWorkspaceLease(leaseId: string): import('../lib/workspace-lease.js').WorkspaceLeaseV1 | null
  getActiveWorkspaceLease(nodeId: string, workspaceKey: string): import('../lib/workspace-lease.js').WorkspaceLeaseV1 | null
  releaseWorkspaceLease(leaseId: string): { lease: import('../lib/workspace-lease.js').WorkspaceLeaseV1 }
  /** Authoritative run-start gate: if the workspace is leased, a run MUST present the
   *  matching active lease id (same workflow). Throws WorkspaceLeaseError otherwise. */
  validateWorkspaceLeaseForRun(nodeId: string, workspaceKey: string, presentedLeaseId: string | null): void
  recordWorkspaceRevision(leaseId: string, stepExecutionId: string | null, phase: string, revision: import('../lib/workspace-lease.js').WorkspaceRevision): { observation_id: string }
  /** Bind a run to a lease at run start (immutable); enables release protection. */
  bindRunToLease(remoteRunId: string, leaseId: string): void
  /** True iff any run bound to the lease is still non-terminal. */
  isLeaseInUse(leaseId: string): boolean

  // durable AgentTaskResult (immutable; never derived from run events)
  /** Persist the authoritative result idempotently. Exact duplicate → applied:false;
   *  conflicting content → result_conflict. `result` is null for missing/invalid. */
  persistRunResult(remoteRunId: string, resultStatus: string, result: import('../lib/agent-task-result.js').AgentTaskResultV1 | null): { applied: boolean }
  /** Read the durable result (revalidated on read; malformed → corruption). */
  getRunResult(remoteRunId: string): NodeRunResult | null

  // reads
  getRun(remoteRunId: string): NodeRunMeta | null
  readEvents(remoteRunId: string, afterSequence: number, limit?: number): NodeRunEvent[]
  replayMetadata(remoteRunId: string, afterSequence: number): ReplayMetadata | null

  // race-free replay → live
  subscribe(remoteRunId: string, opts: SubscribeOptions): JournalSubscription

  // retention (bounded; never touches active runs; no scheduler)
  pruneTerminalRuns(olderThanIso: string): { removed: number }
  pruneRunEvents(remoteRunId: string, keepLast: number): { removed: number }
}
