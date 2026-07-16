/**
 * Node run event journal — CONTRACT (types + constants only; no I/O).
 *
 * A durable, bounded, Node-LOCAL journal of remote-run events so the Node can
 * capture output independently of whether a Gateway is attached, and a
 * reconnecting consumer can resume strictly after the greatest NODE remote-event
 * sequence it has consumed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITICAL: TWO DISTINCT SEQUENCE DOMAINS — never interchangeable.
 *
 *   (1) NODE remote-run event sequence  ← THIS module.
 *       Scoped to `remote_run_id`, starts at 0, strictly monotonic + contiguous,
 *       identifies source events emitted by the Node/backend. Used ONLY for Node
 *       replay/resume (`after_sequence`).
 *
 *   (2) Gateway canonical TaskEvent sequence  ← agent-task-contract / the gateway.
 *       The existing public task-event cursor. It may include events that do NOT
 *       originate at the Node and MUST NOT be sent to the Node as an
 *       `after_sequence` cursor.
 *
 * A Gateway task cursor must never be interpreted as a Node cursor, or vice
 * versa. PR #64 will persist the Gateway↔Node mapping (last_remote_event_sequence);
 * this PR does NOT couple them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Advertised Node capability: a client that sees this may send `after_sequence`
 *  and expect journaled replay. Absence ⇒ replay unavailable (live stream only). */
export const RUN_EVENT_REPLAY_CAPABILITY = 'run_event_replay_v1'
/** Advertised when durable run-result storage is available: the node can serve the
 *  authoritative AgentTaskResult by exact remote_run_id (encrypted end-to-end). */
export const RUN_RESULT_CAPABILITY = 'run_result_v1'

/** Journal DB schema version (bumped for incompatible schema changes). */
export const JOURNAL_SCHEMA_VERSION = 1

/** The existing remote-run event vocabulary (RunEvent.type). Journal appends are
 *  restricted to these. */
export const NODE_RUN_EVENT_TYPES: readonly string[] = ['status', 'log', 'approval_required', 'approval_response', 'tool_call', 'pr_created', 'error']

/** Bounds (bytes / counts). Conservative so a runaway backend cannot bloat the DB. */
export const JOURNAL_LIMITS = {
  event_payload_bytes: 256 * 1024,
  events_per_run: 200_000,
  retained_terminal_runs: 2_000,
} as const

/** `after_sequence` sentinel: nothing consumed yet ⇒ replay from sequence 0. */
export const NO_EVENT_CONSUMED = -1

// ── error ─────────────────────────────────────────────────────────────────────

export type JournalErrorCode =
  | 'not_found'
  | 'duplicate'
  | 'event_conflict'
  | 'event_gap'
  | 'invalid_record'
  | 'corruption'
  | 'invalid_transition'
  | 'too_large'
  | 'events_per_run_exceeded'
  | 'unsupported_schema_version'
  | 'result_conflict'
  | 'closed'
  | 'subscriber_overflow'

/** Structured, sanitized journal error. `message` never echoes payloads/paths/SQL. */
export class JournalError extends Error {
  constructor(public readonly code: JournalErrorCode, message: string) { super(message); this.name = 'JournalError' }
}

// ── records ─────────────────────────────────────────────────────────────────

/** A single journaled remote-run event (JSON-serializable; no functions). */
export interface NodeRunEvent<P = unknown> {
  remote_run_id: string
  /** NODE source sequence (domain 1). Non-negative, contiguous from 0. */
  sequence: number
  /** One of {@link NODE_RUN_EVENT_TYPES}. */
  type: string
  /** ISO-8601 UTC. */
  timestamp: string
  payload: P
}

/** The event as offered for appending — the journal assigns `sequence`. The
 *  caller (which understands the RunEvent) declares terminality/status; the
 *  journal never interprets the opaque payload. */
export interface NodeRunEventInput<P = unknown> {
  type: string
  timestamp: string
  payload: P
  /** True iff this is the run's terminal event (recorded at most once). */
  terminal?: boolean
  /** New run status this event implies (e.g. running/completed/failed). */
  status?: string
}

/** Per-run journal metadata (identity immutable; terminal monotonic). */
export interface NodeRunMeta {
  remote_run_id: string
  created_at: string
  updated_at: string
  status: string
  terminal_at: string | null
  /** Greatest journaled sequence (−1 when empty). */
  last_sequence: number
  /** Oldest sequence still retained (advances only via retention pruning). */
  earliest_retained_sequence: number
  terminal_event_recorded: boolean
  schema_version: number
}

/** Replay metadata returned at stream/subscription establishment. */
export interface ReplayMetadata {
  earliest_retained_sequence: number
  latest_sequence: number
  /** False when the requested `after_sequence` prefix was pruned (a gap the client
   *  must be told about — the retained suffix still replays). */
  history_complete_for_request: boolean
  status: string
  terminal: boolean
  replay_capability: string
}
