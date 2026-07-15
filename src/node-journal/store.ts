/**
 * NodeJournal interface — the only contract callers depend on. SYNCHRONOUS: the
 * backend-capture loop appends BEFORE publishing, so ordering must be immediate
 * (the SQLite backend is synchronous). The driver is hidden behind this interface.
 */
import type { NodeRunEvent, NodeRunEventInput, NodeRunMeta, ReplayMetadata } from './contract.js'

export interface JournalHealth { ok: boolean; schema_version: number; foreign_keys: boolean; journal_mode: string; busy_timeout: number }

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
