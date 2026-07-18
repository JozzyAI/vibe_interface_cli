export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'cancelled'
  | 'blocked'

export type AgentBackend = 'mock' | 'claude-code' | 'codex' | 'opencode'

// 'unsafe-skip' enables --dangerously-skip-permissions. Must be explicit; not the default.
export type PermissionMode = 'default' | 'unsafe-skip'

export interface RunRecord {
  run_id: string
  session_id: string
  node_id: string
  node_selector?: string   // 'auto' | 'local' | explicit node_id passed by caller
  agent: AgentBackend
  status: RunStatus
  workspace_path: string
  session_url?: string
  repo_url?: string
  branch?: string
  prompt_file?: string
  permission_mode?: PermissionMode
  metadata?: Record<string, unknown>
  child_pid?: number       // PID of spawned agent process (for kill-on-stop)
  // ── Meta-agent runtime projection (set by the supervisor; absent on plain single-agent runs) ──
  started_agent?: AgentBackend   // the primary agent the run began with
  final_agent?: AgentBackend     // the agent that produced the terminal status (differs from started_agent after a switch)
  switched?: boolean             // true if the supervisor fell back from the primary to another agent
  switch_reason?: string         // classified FailureReason that triggered the switch
  handoff_path?: string          // path to the handoff doc written on switch
  failure_reason?: string        // classified FailureReason on terminal failure
  recoverable?: boolean          // whether the terminal failure was classified recoverable
  exit_code?: number             // process/adapter exit status on a terminal outcome (0 = completed; absent when the agent never produced one, e.g. a pre-spawn gate failure)
  error?: string                 // human-readable terminal failure message (mirrors the adapter's diagnostic `error` event); absent on success
  // ── First-class AgentTaskResult (authoritative control result; NOT event-history inference) ──
  result_status?: import('./lib/agent-task-result.js').TaskResultStatus // 'available' when task_result is set; 'missing' when the backend produced no authoritative final result
  task_result?: import('./lib/agent-task-result.js').AgentTaskResultV1   // the durable final result envelope (present iff result_status === 'available')
  workspace_lease_id?: string  // workspace_lease_v1: the lease that authorized this run (Node-local; never forwarded to the provider)
  workspace_key?: string   // the contained workspace key this run resolved to (Node-local; used to match the authorizing lease). Never a path.
  workspace_write?: boolean // task/workflow policy: may this task MODIFY the workspace? Authorization ALSO requires a valid active lease (Node-enforced); never grants write on its own. Node-local; never forwarded to the provider.
  verify?: import('./lib/task-verification.js').TaskVerifyConfig  // Harness-owned post-task test verifier (argv only; never forwarded to the provider prompt/env)
  event_aes_key?: string   // base64 AES-256 key for run_event decryption (HKDF 'vibe-run-event-v1'); stored locally
  stop_aes_key?: string     // base64 AES-256 key for run_stop encryption (HKDF 'vibe-run-stop-v1'); stored locally
  approval_aes_key?: string // base64 AES-256 key for approval_response encryption (HKDF 'vibe-approval-response-v1')
  created_at: string
  updated_at: string
}

// ── Node abstraction ──────────────────────────────────────────────────────────

export interface VibeNode {
  node_id: string
  name: string
  status: 'online' | 'offline'
  transport: 'local' | 'relay'
  capabilities: string[]
  agents: string[]
  active_runs: number
  max_runs: number
  workspace_roots: string[]
  created_at: string
  updated_at: string
  encryption_public_key?: string  // X25519 SPKI DER base64; present when node has identity
}

// Written periodically by `vibe node daemon --local` to ~/.vibe/node-local.json
export interface NodeDaemonState {
  node_id: string
  name: string
  status: 'online' | 'offline'
  transport: 'local' | 'relay'
  capabilities: string[]
  agents: string[]
  active_runs: number
  max_runs: number
  workspace_roots: string[]
  pid: number
  started_at: string
  last_heartbeat_at: string
}

// ── Stable JSONL event schema ──────────────────────────────────────────────

interface BaseEvent {
  run_id: string
  session_id?: string
  ts: string
}

export interface StatusEvent extends BaseEvent {
  type: 'status'
  status: RunStatus
}

export interface LogEvent extends BaseEvent {
  type: 'log'
  stream: 'stdout' | 'stderr'
  message: string
}

export interface ApprovalRequiredEvent extends BaseEvent {
  type: 'approval_required'
  approval_id: string
  message: string
}

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call'
  tool: string
  input?: unknown
}

export interface PrCreatedEvent extends BaseEvent {
  type: 'pr_created'
  url: string
}

export interface ApprovalResponseEvent extends BaseEvent {
  type: 'approval_response'
  approval_id: string
  decision: 'approve' | 'deny'
  message?: string
}

export interface ErrorEvent extends BaseEvent {
  type: 'error'
  message: string
  code?: string
}

export type RunEvent =
  | StatusEvent
  | LogEvent
  | ApprovalRequiredEvent
  | ApprovalResponseEvent
  | ToolCallEvent
  | PrCreatedEvent
  | ErrorEvent

export const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'stopped', 'cancelled']

export function isTerminal(event: RunEvent): boolean {
  return event.type === 'status' && TERMINAL_STATUSES.includes((event as StatusEvent).status)
}

// ── Structured error (for future HTTP API / relay responses) ───────────────

export type VibeErrorCode =
  | 'user_error'
  | 'not_found'
  | 'backend_error'
  | 'read_only'
  | 'node_not_found'
  | 'agent_not_supported'
  | 'no_runner_available'

export interface VibeError {
  error: true
  code: VibeErrorCode
  message: string
  run_id?: string
  ts: string
}

// ── Envelope abstraction (MVP 4 will swap plaintext → encrypted) ───────────
//
// All inter-node messages use this envelope. MVP 0.5 only ever emits
// kind="plaintext". When remote transport (MVP 3) and E2E encryption
// (MVP 4) arrive, add kind="encrypted" senders without touching the
// event schema — only the envelope wrapping changes.

export type VibeEnvelope =
  | {
      version: 1
      kind: 'plaintext'
      from: string          // node_id or "local"
      to: string            // node_id, run_id, or "*"
      run_id?: string
      ts: string
      payload: RunEvent
    }
  | {
      version: 1
      kind: 'encrypted'
      from: string
      to: string
      run_id?: string
      ts: string
      key_id: string
      nonce: string
      ciphertext: string    // base64-encoded encrypted payload
    }

export function wrapPlaintext(
  event: RunEvent,
  from: string,
  to: string,
): VibeEnvelope {
  return {
    version: 1,
    kind: 'plaintext',
    from,
    to,
    run_id: event.run_id,
    ts: event.ts,
    payload: event,
  }
}
