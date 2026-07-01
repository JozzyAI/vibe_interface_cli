/**
 * Relay wire protocol.
 *
 * MVP 4A: optional Ed25519 signature on plaintext envelopes.
 * MVP 4B: kind='encrypted' for run_start payload encryption (X25519 + AES-256-GCM).
 * MVP 4C: kind='encrypted' for run_event stream ('vibe-run-event-v1' HKDF context).
 * MVP 4D: kind='encrypted' for run_stop request/ack ('vibe-run-stop-v1' HKDF context).
 *
 * Relay can see routing metadata on encrypted envelopes (from/to/run_id/key_id/ts)
 * but cannot read any ciphertext payload.
 */
import type { AgentBackend, PermissionMode, RunEvent, RunRecord, VibeNode } from '../types.js'
import type { PublicIdentity } from '../identity.js'

export type { PublicIdentity }

export interface EnvelopeSignature {
  alg: 'Ed25519'
  key_id: string   // identity id (signer's node_id)
  value: string    // base64 Ed25519 signature over canonical(envelope-without-signature)
}

export interface RelayMsgBase {
  version: 1
  kind: 'plaintext'
  from: string      // node_id | 'cli' | 'relay'
  to: string        // node_id | 'cli' | 'relay' | '*'
  ts: string
  signature?: EnvelopeSignature  // optional; required in --require-pairing mode
}

// ── MVP 4B: encrypted run_start ─────────────────────────────────────────────
//
// Relay sees: version/kind/from/to/ts/req_id/type/key_id/ephemeral_public_key/nonce/ciphertext
// Relay cannot see: prompt_content/workspace_key/agent/metadata/permission_mode/repo_url/branch

export interface EncryptedRunStartMsg {
  version: 1
  kind: 'encrypted'
  from: string           // cli node_id or 'cli'
  to: string             // target node_id
  ts: string
  req_id: string         // correlation id — relay routes run_start_ack back to requester
  type: 'run_start'
  key_id: string         // target node_id (identifies which key to decrypt with)
  ephemeral_public_key: string  // base64 ephemeral X25519 SPKI DER
  nonce: string          // base64 12-byte AES-GCM nonce
  ciphertext: string     // base64 AES-256-GCM(plaintext_payload ‖ auth_tag)
  signature?: EnvelopeSignature  // optional Ed25519 sig over canonical outer envelope
}

// Decrypted inner payload (not sent over wire; reconstructed from ciphertext on node)
export interface RunStartPayload {
  workspace_key?: string
  agent: AgentBackend
  permission_mode?: PermissionMode
  prompt_content?: string
  metadata?: Record<string, unknown>
  repo_url?: string
  branch?: string
}

// ── MVP 4C: encrypted run_event stream ─────────────────────────────────────
//
// Node encrypts each VibeEvent; relay fans out opaque ciphertext to subscribers.
// CLI stream decrypts and prints the same VibeEvent JSONL schema as plaintext runs.
//
// Relay sees: version/kind/from/to/run_id/key_id/nonce/ciphertext/ts
// Relay cannot see: event type/message/status/tool_call/etc.

export interface EncryptedRunEventMsg {
  version: 1
  kind: 'encrypted'
  from: string     // node_id that originated the event
  to: 'relay'
  ts: string
  type: 'encrypted_run_event'
  run_id: string
  key_id: string   // node_id (identifies which run-level key was used)
  nonce: string    // base64 12-byte AES-GCM nonce
  ciphertext: string // base64 AES-256-GCM(VibeEvent JSON ‖ auth_tag(16))
}

// ── MVP 4D: encrypted run_stop request/ack ─────────────────────────────────
//
// CLI encrypts stop request; relay routes by run_id ownership; node decrypts,
// stops the run, and returns an encrypted ack. Relay never reads stop reason or result.
//
// Relay sees: version/kind/from/to/run_id/req_id/key_id/nonce/ciphertext/ts
// Relay cannot see: reason, ok, error, RunRecord details

export interface EncryptedRunStopRequestMsg {
  version: 1
  kind: 'encrypted'
  from: string      // 'cli'
  to: 'relay'
  ts: string
  type: 'encrypted_run_stop_request'
  req_id: string    // correlation id for routing ack back to requester
  run_id: string    // visible for relay routing via runOwnership map
  key_id: string    // run_id (identifies which stop key to use)
  nonce: string     // base64 12-byte AES-GCM nonce
  ciphertext: string // base64 AES-256-GCM(RunStopPayload JSON ‖ auth_tag(16))
}

// Decrypted inner payload of EncryptedRunStopRequestMsg
export interface RunStopPayload {
  reason?: string
}

export interface EncryptedRunStopAckMsg {
  version: 1
  kind: 'encrypted'
  from: string      // node_id
  to: 'relay'
  ts: string
  type: 'encrypted_run_stop_ack'
  req_id: string    // matches the request req_id
  run_id: string
  nonce: string
  ciphertext: string // base64 AES-256-GCM(RunStopAckPayload JSON ‖ auth_tag(16))
}

// Decrypted inner payload of EncryptedRunStopAckMsg
export interface RunStopAckPayload {
  ok: boolean
  record?: RunRecord
  error?: string
  code?: string
}

// ── MVP 4F: encrypted approval_response ────────────────────────────────────
//
// CLI sends encrypted approval decision; relay routes to owning node by run_id.
// Node decrypts, appends approval_response event to run log, returns encrypted ack.
// approval_required events are already encrypted by MVP 4C (they are run_events).
//
// Relay sees: version/kind/from/to/run_id/req_id/key_id/nonce/ciphertext/ts
// Relay cannot see: approval_id, decision (approve/deny), message/comment

export interface EncryptedApprovalResponseMsg {
  version: 1
  kind: 'encrypted'
  from: string       // 'cli'
  to: 'relay'
  ts: string
  type: 'encrypted_approval_response'
  req_id: string     // correlation id for routing ack back to requester
  run_id: string     // visible for relay routing via runOwnership map
  key_id: string     // run_id (identifies which approval key to use)
  nonce: string
  ciphertext: string // base64 AES-256-GCM(ApprovalResponsePayload JSON ‖ auth_tag)
}

// Decrypted inner payload
export interface ApprovalResponsePayload {
  approval_id: string
  decision: 'approve' | 'deny'
  message?: string
}

export interface EncryptedApprovalResponseAckMsg {
  version: 1
  kind: 'encrypted'
  from: string       // node_id
  to: 'relay'
  ts: string
  type: 'encrypted_approval_response_ack'
  req_id: string
  run_id: string
  nonce: string
  ciphertext: string // base64 AES-256-GCM(ApprovalResponseAckPayload JSON ‖ auth_tag)
}

// Decrypted inner ack payload
export interface ApprovalResponseAckPayload {
  ok: boolean
  error?: string
  code?: string
}

// ── node → relay: pairing (MVP 4A) ────────────────────────────────────────

export interface NodePairRequestMsg extends RelayMsgBase {
  type: 'node_pair_request'
  identity: PublicIdentity
}

export interface NodePairAckMsg extends RelayMsgBase {
  type: 'node_pair_ack'
  node_id: string
  ok: boolean
  error?: string
  code?: string
}

// ── node daemon → relay ────────────────────────────────────────────────────

export interface NodeRegisterMsg extends RelayMsgBase {
  type: 'node_register'
  node: VibeNode
}

export interface NodeHeartbeatMsg extends RelayMsgBase {
  type: 'node_heartbeat'
  node_id: string
  active_runs: number
  last_heartbeat_at: string
}

// ── cli → relay ────────────────────────────────────────────────────────────

export interface NodeListRequestMsg extends RelayMsgBase {
  type: 'node_list_request'
}

export interface RunStreamSubscribeMsg extends RelayMsgBase {
  type: 'run_stream_subscribe'
  run_id: string
}

// ── cli → relay → node daemon ──────────────────────────────────────────────

export interface RunStartMsg extends RelayMsgBase {
  type: 'run_start'
  req_id: string           // correlation id — relay routes ack back to this requester
  agent: AgentBackend
  workspace_key?: string
  repo_url?: string
  branch?: string
  prompt_content?: string  // prompt text (controller reads file, sends content — node writes local temp file)
  permission_mode?: PermissionMode
  metadata?: Record<string, unknown>
}

// ── cli → relay → node daemon (bidirectional stop) ────────────────────────

export interface RunStopRequestMsg extends RelayMsgBase {
  type: 'run_stop_request'
  req_id: string
  run_id: string
  reason?: string
}

// Non-destructive, read-only status query. cli → relay → owning node daemon,
// which answers from its authoritative local run record. Used by Symphony's
// stall watchdog to confirm a run's real outcome before declaring it stalled.
export interface RunStatusRequestMsg extends RelayMsgBase {
  type: 'run_status_request'
  req_id: string
  run_id: string
}

// ── node daemon → relay → cli subscribers ─────────────────────────────────

export interface RunEventMsg extends RelayMsgBase {
  type: 'run_event'
  run_id: string
  event: RunEvent
}

export interface RunStopAckMsg extends RelayMsgBase {
  type: 'run_stop_ack'
  req_id: string
  run_id: string
  ok: boolean
  record?: RunRecord   // updated RunRecord (status: stopped) if ok=true
  error?: string
  code?: string
}

export interface RunStatusAckMsg extends RelayMsgBase {
  type: 'run_status_ack'
  req_id: string
  run_id: string
  ok: boolean
  record?: RunRecord   // authoritative RunRecord from the owning node if ok=true
  error?: string
  code?: string
}

// ── relay → client ─────────────────────────────────────────────────────────

export interface NodeRegisterAckMsg extends RelayMsgBase {
  type: 'node_register_ack'
  node_id: string
  ok: boolean
}

export interface NodeHeartbeatAckMsg extends RelayMsgBase {
  type: 'node_heartbeat_ack'
  node_id: string
}

export interface NodeListResponseMsg extends RelayMsgBase {
  type: 'node_list_response'
  nodes: VibeNode[]
}

export interface RunStartAckMsg extends RelayMsgBase {
  type: 'run_start_ack'
  req_id: string
  ok: boolean
  record?: RunRecord   // present when ok=true
  error?: string       // present when ok=false
  code?: string        // error code when ok=false
}

export interface RunStreamSubscribeAckMsg extends RelayMsgBase {
  type: 'run_stream_subscribe_ack'
  run_id: string
  ok: boolean
}

export interface RelayErrorMsg extends RelayMsgBase {
  type: 'relay_error'
  code: string
  message: string
}

// ── remote terminal (echo skeleton) — gateway ↔ relay ↔ node daemon ─────────
// Additive protocol. gateway→node messages route by `to` (like run_start);
// node→gateway messages (open_ack/output/error) fan out by `session_id`. The
// relay stays payload-dumb: it never inspects or logs `data`.

export interface TerminalOpenMsg extends RelayMsgBase {
  type: 'terminal_open'
  req_id: string
  session_id: string   // gateway-generated id; relay fans node→gateway msgs on it
  session: string      // node-side session name to attach to (ignored by the echo node)
  cols?: number
  rows?: number
}
export interface TerminalOpenAckMsg extends RelayMsgBase {
  type: 'terminal_open_ack'
  req_id: string
  session_id: string
  ok: boolean
  message?: string
}
export interface TerminalInputMsg extends RelayMsgBase {
  type: 'terminal_input'
  session_id: string
  data: string         // raw keystrokes — NEVER logged by relay or node
}
export interface TerminalOutputMsg extends RelayMsgBase {
  type: 'terminal_output'
  session_id: string
  data: string
}
export interface TerminalResizeMsg extends RelayMsgBase {
  type: 'terminal_resize'
  session_id: string
  cols: number
  rows: number
}
export interface TerminalCloseMsg extends RelayMsgBase {
  type: 'terminal_close'
  session_id: string
}
export interface TerminalErrorMsg extends RelayMsgBase {
  type: 'terminal_error'
  session_id: string
  code: string
  message: string
}

export type RelayMessage =
  | EncryptedRunStartMsg
  | EncryptedRunEventMsg
  | EncryptedRunStopRequestMsg
  | EncryptedRunStopAckMsg
  | EncryptedApprovalResponseMsg
  | EncryptedApprovalResponseAckMsg
  | NodePairRequestMsg
  | NodePairAckMsg
  | NodeRegisterMsg
  | NodeHeartbeatMsg
  | NodeListRequestMsg
  | RunStreamSubscribeMsg
  | RunStartMsg
  | RunStopRequestMsg
  | RunStatusRequestMsg
  | RunEventMsg
  | NodeRegisterAckMsg
  | NodeHeartbeatAckMsg
  | NodeListResponseMsg
  | RunStartAckMsg
  | RunStreamSubscribeAckMsg
  | RunStopAckMsg
  | RunStatusAckMsg
  | TerminalOpenMsg
  | TerminalOpenAckMsg
  | TerminalInputMsg
  | TerminalOutputMsg
  | TerminalResizeMsg
  | TerminalCloseMsg
  | TerminalErrorMsg
  | RelayErrorMsg
