/**
 * Vibe relay server — dev (plaintext) mode.
 *
 * In-memory node registry backed by WebSocket connections.
 * Token auth via URL query string: ws://localhost:PORT?token=TOKEN
 * No persistence, no E2E encryption (planned for MVP 4).
 *
 * Event streaming: relay maintains a subscribers map (run_id → Set<ws>).
 * run_event messages from node daemons are fanned out to all subscribers.
 * No event buffering — late subscribers miss past events.
 *
 * Run ownership: relay records run_id → node_id when run_start_ack ok=true
 * arrives. This allows run_stop_request to be routed to the correct node.
 *
 * MVP 4A: --require-pairing mode enforces that nodes must pair before registering.
 * Without --require-pairing the old token-only dev mode continues to work.
 */
import { WebSocketServer, WebSocket } from 'ws'
import type { VibeNode } from '../types.js'
import type { RelayMessage, EncryptedRunStartMsg, EncryptedRunEventMsg, EncryptedRunStopRequestMsg, EncryptedRunStopAckMsg, EncryptedApprovalResponseMsg, EncryptedApprovalResponseAckMsg, PublicIdentity } from './types.js'
import { verifyEnvelope } from '../crypto.js'

interface NodeEntry {
  node: VibeNode
  ws: WebSocket
  registered_at: string
  last_heartbeat_at: string
}

export interface RelayServer {
  port: number
  nodeCount(): number
  pairedCount(): number
  close(): Promise<void>
}

export interface RelayServerOpts {
  port: number
  token: string
  /** Bind address. Defaults to '127.0.0.1'. Pass '0.0.0.0' to listen on all interfaces. */
  host?: string
  /** Override stale threshold (ms). Defaults to VIBE_NODE_STALE_MS env or 15000. */
  staleMs?: number
  /**
   * When true, node_register is rejected unless the node has paired first and
   * the message carries a valid Ed25519 signature.
   * Default false — old token-only dev mode continues to work.
   */
  requirePairing?: boolean
}

function getStaleMs(override?: number): number {
  if (override !== undefined) return override
  const v = parseInt(process.env.VIBE_NODE_STALE_MS ?? '', 10)
  return isNaN(v) || v <= 0 ? 15000 : v
}

function now(): string { return new Date().toISOString() }

function sendMsg(ws: WebSocket, msg: RelayMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export function startRelayServer(opts: RelayServerOpts): Promise<RelayServer> {
  return new Promise((resolve, reject) => {
    const registry = new Map<string, NodeEntry>()
    const allConns = new Set<WebSocket>()
    // req_id → requester ws, for routing run_start_ack back to CLI
    const pendingReqs = new Map<string, WebSocket>()
    // req_id → requester ws, for routing run_stop_ack back to CLI
    const pendingStops = new Map<string, WebSocket>()
    // req_id → requester ws, for routing approval_response_ack back to CLI
    const pendingApprovals = new Map<string, WebSocket>()
    // run_id → node_id, populated on run_start_ack ok=true for routing stop requests
    const runOwnership = new Map<string, string>()
    // run_id → set of subscriber ws, for streaming run events to CLI clients
    const subscribers = new Map<string, Set<WebSocket>>()
    // node_id → PublicIdentity (populated on node_pair_request)
    const pairedIdentities = new Map<string, PublicIdentity>()
    const staleMs = getStaleMs(opts.staleMs)

    // Token auth at the HTTP upgrade level — rejected clients never reach the WS layer.
    const verifyClient = (
      info: { req: { url?: string } },
      cb: (result: boolean, code?: number, message?: string) => void,
    ) => {
      try {
        const url = new URL(info.req.url ?? '/', 'ws://localhost')
        if (url.searchParams.get('token') === opts.token) return cb(true)
      } catch {}
      cb(false, 401, 'Unauthorized')
    }

    const wss = new WebSocketServer({ host: opts.host ?? '127.0.0.1', port: opts.port, verifyClient } as ConstructorParameters<typeof WebSocketServer>[0])

    wss.on('error', reject)

    wss.on('listening', () => {
      const addr = wss.address() as { port: number }
      const port = addr.port

      resolve({
        port,
        nodeCount: () => registry.size,
        pairedCount: () => pairedIdentities.size,
        close: () =>
          new Promise<void>((res) => {
            for (const ws of allConns) ws.terminate()
            wss.close(() => res())
          }),
      })
    })

    wss.on('connection', (ws: WebSocket) => {
      allConns.add(ws)
      let nodeId: string | null = null

      ws.on('message', (raw) => {
        let msg: RelayMessage
        try { msg = JSON.parse(raw.toString()) as RelayMessage } catch { return }

        // MVP 4B/4C: route encrypted envelopes without reading the payload.
        if ((msg as { kind?: string }).kind === 'encrypted') {
          const encType = (msg as { type?: string }).type
          if (encType === 'run_start') {
            const enc = msg as EncryptedRunStartMsg
            pendingReqs.set(enc.req_id, ws)
            const target = registry.get(enc.to)
            if (!target) {
              sendMsg(ws, {
                version: 1, kind: 'plaintext', from: 'relay', to: enc.from, ts: now(),
                type: 'run_start_ack', req_id: enc.req_id, ok: false,
                error: `Node not found: ${enc.to}`, code: 'node_not_found',
              })
              pendingReqs.delete(enc.req_id)
            } else {
              sendMsg(target.ws, msg)
            }
          } else if (encType === 'encrypted_run_event') {
            // MVP 4C: fan out encrypted event to all run subscribers — relay never decrypts.
            const enc = msg as EncryptedRunEventMsg
            const subs = subscribers.get(enc.run_id)
            if (subs) {
              for (const sub of subs) sendMsg(sub, msg)
            }
          } else if (encType === 'encrypted_run_stop_request') {
            // MVP 4D: route encrypted stop request to owning node — relay never decrypts.
            const enc = msg as EncryptedRunStopRequestMsg
            pendingStops.set(enc.req_id, ws)
            const ownerId = runOwnership.get(enc.run_id)
            if (!ownerId) {
              sendMsg(ws, {
                version: 1, kind: 'plaintext', from: 'relay', to: enc.from, ts: now(),
                type: 'run_stop_ack', req_id: enc.req_id, run_id: enc.run_id, ok: false,
                error: `Run not found in relay: ${enc.run_id}`, code: 'run_not_found',
              })
              pendingStops.delete(enc.req_id)
            } else {
              const target = registry.get(ownerId)
              if (!target) {
                sendMsg(ws, {
                  version: 1, kind: 'plaintext', from: 'relay', to: enc.from, ts: now(),
                  type: 'run_stop_ack', req_id: enc.req_id, run_id: enc.run_id, ok: false,
                  error: `Owning node is offline: ${ownerId}`, code: 'node_offline',
                })
                pendingStops.delete(enc.req_id)
              } else {
                sendMsg(target.ws, msg)
              }
            }
          } else if (encType === 'encrypted_run_stop_ack') {
            // MVP 4D: route encrypted stop ack back to the waiting CLI — relay never decrypts.
            const enc = msg as EncryptedRunStopAckMsg
            const requester = pendingStops.get(enc.req_id)
            if (requester) {
              sendMsg(requester, msg)
              pendingStops.delete(enc.req_id)
            }
          } else if (encType === 'encrypted_approval_response') {
            // MVP 4F: route encrypted approval response to owning node — relay never decrypts.
            const enc = msg as EncryptedApprovalResponseMsg
            pendingApprovals.set(enc.req_id, ws)
            const ownerId = runOwnership.get(enc.run_id)
            if (!ownerId) {
              sendMsg(ws, {
                version: 1, kind: 'plaintext', from: 'relay', to: enc.from, ts: now(),
                type: 'relay_error', code: 'run_not_found',
                message: `Run not found in relay: ${enc.run_id}`,
              })
              pendingApprovals.delete(enc.req_id)
            } else {
              const target = registry.get(ownerId)
              if (!target) {
                sendMsg(ws, {
                  version: 1, kind: 'plaintext', from: 'relay', to: enc.from, ts: now(),
                  type: 'relay_error', code: 'node_offline',
                  message: `Owning node is offline: ${ownerId}`,
                })
                pendingApprovals.delete(enc.req_id)
              } else {
                sendMsg(target.ws, msg)
              }
            }
          } else if (encType === 'encrypted_approval_response_ack') {
            // MVP 4F: route encrypted approval ack back to the waiting CLI.
            const enc = msg as EncryptedApprovalResponseAckMsg
            const requester = pendingApprovals.get(enc.req_id)
            if (requester) {
              sendMsg(requester, msg)
              pendingApprovals.delete(enc.req_id)
            }
          }
          return
        }

        switch (msg.type) {
          case 'node_pair_request': {
            const pid = msg.identity.id
            pairedIdentities.set(pid, msg.identity)
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
              type: 'node_pair_ack', node_id: pid, ok: true,
            })
            break
          }

          case 'node_register': {
            nodeId = msg.node.node_id

            if (opts.requirePairing) {
              const identity = pairedIdentities.get(nodeId)
              if (!identity) {
                sendMsg(ws, {
                  version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
                  type: 'node_register_ack', node_id: nodeId, ok: false,
                })
                nodeId = null
                break
              }
              if (!msg.signature) {
                sendMsg(ws, {
                  version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
                  type: 'node_register_ack', node_id: nodeId, ok: false,
                })
                nodeId = null
                break
              }
              const rawEnvelope = JSON.parse(raw.toString()) as Record<string, unknown>
              if (!verifyEnvelope(identity.signing_public_key, rawEnvelope)) {
                sendMsg(ws, {
                  version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
                  type: 'node_register_ack', node_id: nodeId, ok: false,
                })
                nodeId = null
                break
              }
            }

            registry.set(nodeId, {
              node: { ...msg.node, transport: 'relay' },
              ws,
              registered_at: now(),
              last_heartbeat_at: now(),
            })
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: 'relay', to: nodeId, ts: now(),
              type: 'node_register_ack', node_id: nodeId, ok: true,
            })
            break
          }

          case 'node_heartbeat': {
            const entry = registry.get(msg.node_id)
            if (entry) {
              entry.last_heartbeat_at = now()
              entry.node.active_runs = msg.active_runs
            }
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: 'relay', to: msg.node_id, ts: now(),
              type: 'node_heartbeat_ack', node_id: msg.node_id,
            })
            break
          }

          case 'node_list_request': {
            const nodes: VibeNode[] = Array.from(registry.values()).map((e) => {
              const age = Date.now() - new Date(e.last_heartbeat_at).getTime()
              return { ...e.node, status: age < staleMs ? 'online' as const : 'offline' as const }
            })
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
              type: 'node_list_response', nodes,
            })
            break
          }

          case 'run_stream_subscribe': {
            const subs = subscribers.get(msg.run_id) ?? new Set<WebSocket>()
            subs.add(ws)
            subscribers.set(msg.run_id, subs)
            sendMsg(ws, {
              version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
              type: 'run_stream_subscribe_ack', run_id: msg.run_id, ok: true,
            })
            break
          }

          case 'run_event': {
            const subs = subscribers.get(msg.run_id)
            if (subs) {
              for (const sub of subs) sendMsg(sub, msg)
            }
            break
          }

          case 'run_start': {
            pendingReqs.set(msg.req_id, ws)
            const target = registry.get(msg.to)
            if (!target) {
              sendMsg(ws, {
                version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
                type: 'run_start_ack', req_id: msg.req_id, ok: false,
                error: `Node not found: ${msg.to}`, code: 'node_not_found',
              })
              pendingReqs.delete(msg.req_id)
              break
            }
            sendMsg(target.ws, msg)
            break
          }

          case 'run_start_ack': {
            const requester = pendingReqs.get(msg.req_id)
            if (requester) {
              sendMsg(requester, msg)
              pendingReqs.delete(msg.req_id)
            }
            // Record run ownership so stop can be routed to the correct node.
            if (msg.ok && msg.record) {
              runOwnership.set(msg.record.run_id, msg.from)
            }
            break
          }

          case 'run_stop_request': {
            pendingStops.set(msg.req_id, ws)
            const ownerId = runOwnership.get(msg.run_id)
            if (!ownerId) {
              sendMsg(ws, {
                version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
                type: 'run_stop_ack', req_id: msg.req_id, run_id: msg.run_id, ok: false,
                error: `Run not found in relay: ${msg.run_id}`, code: 'run_not_found',
              })
              pendingStops.delete(msg.req_id)
              break
            }
            const target = registry.get(ownerId)
            if (!target) {
              sendMsg(ws, {
                version: 1, kind: 'plaintext', from: 'relay', to: msg.from, ts: now(),
                type: 'run_stop_ack', req_id: msg.req_id, run_id: msg.run_id, ok: false,
                error: `Owning node is offline: ${ownerId}`, code: 'node_offline',
              })
              pendingStops.delete(msg.req_id)
              break
            }
            sendMsg(target.ws, msg)
            break
          }

          case 'run_stop_ack': {
            const requester = pendingStops.get(msg.req_id)
            if (requester) {
              sendMsg(requester, msg)
              pendingStops.delete(msg.req_id)
            }
            break
          }
        }
      })

      ws.on('close', () => {
        allConns.delete(ws)
        if (nodeId) registry.delete(nodeId)
        for (const [reqId, reqWs] of pendingReqs) {
          if (reqWs === ws) pendingReqs.delete(reqId)
        }
        for (const [reqId, reqWs] of pendingStops) {
          if (reqWs === ws) pendingStops.delete(reqId)
        }
        for (const [reqId, reqWs] of pendingApprovals) {
          if (reqWs === ws) pendingApprovals.delete(reqId)
        }
        for (const [runId, subs] of subscribers) {
          subs.delete(ws)
          if (subs.size === 0) subscribers.delete(runId)
        }
      })
    })
  })
}
