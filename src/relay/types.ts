/**
 * Relay wire protocol.
 *
 * MVP 4A: optional Ed25519 signature on plaintext envelopes.
 * MVP 4B: kind='encrypted' for run_start payload encryption (X25519 + AES-256-GCM).
 *
 * Relay can see routing metadata on encrypted envelopes (from/to/req_id/type)
 * but cannot read the ciphertext payload.
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

export type RelayMessage =
  | EncryptedRunStartMsg
  | NodePairRequestMsg
  | NodePairAckMsg
  | NodeRegisterMsg
  | NodeHeartbeatMsg
  | NodeListRequestMsg
  | RunStreamSubscribeMsg
  | RunStartMsg
  | RunStopRequestMsg
  | RunEventMsg
  | NodeRegisterAckMsg
  | NodeHeartbeatAckMsg
  | NodeListResponseMsg
  | RunStartAckMsg
  | RunStreamSubscribeAckMsg
  | RunStopAckMsg
  | RelayErrorMsg
