/**
 * Relay wire protocol — plaintext dev mode.
 *
 * All messages share the same base envelope shape (version/kind/from/to/ts)
 * so they're structurally compatible with VibeEnvelope plaintext for future
 * unification. The `type` field is the discriminator.
 *
 * MVP 4A adds optional `signature` to the base envelope (Ed25519 signed plaintext).
 * MVP 4B will add kind: 'encrypted' for payload encryption (X25519).
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
  signature?: EnvelopeSignature  // MVP 4A: optional; required in --require-pairing mode
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
