/**
 * Vibe relay server — dev (plaintext) mode.
 *
 * In-memory node registry backed by WebSocket connections.
 * Token auth via URL query string: ws://localhost:PORT?token=TOKEN
 * No persistence, no E2E encryption (planned for MVP 4).
 */
import { WebSocketServer, WebSocket } from 'ws'
import type { VibeNode } from '../types.js'
import type { RelayMessage } from './types.js'

interface NodeEntry {
  node: VibeNode
  ws: WebSocket
  registered_at: string
  last_heartbeat_at: string
}

export interface RelayServer {
  port: number
  nodeCount(): number
  close(): Promise<void>
}

export interface RelayServerOpts {
  port: number
  token: string
  /** Override stale threshold (ms). Defaults to VIBE_NODE_STALE_MS env or 15000. */
  staleMs?: number
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

    const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port, verifyClient } as ConstructorParameters<typeof WebSocketServer>[0])

    wss.on('error', reject)

    wss.on('listening', () => {
      const addr = wss.address() as { port: number }
      const port = addr.port

      resolve({
        port,
        nodeCount: () => registry.size,
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

        switch (msg.type) {
          case 'node_register': {
            nodeId = msg.node.node_id
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

          case 'run_start': {
            // Store requester ws keyed by req_id so we can route the ack back.
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
            // Forward unchanged to the target node.
            sendMsg(target.ws, msg)
            break
          }

          case 'run_start_ack': {
            // Node sent ack back — route to the original requester.
            const requester = pendingReqs.get(msg.req_id)
            if (requester) {
              sendMsg(requester, msg)
              pendingReqs.delete(msg.req_id)
            }
            break
          }
        }
      })

      ws.on('close', () => {
        allConns.delete(ws)
        if (nodeId) registry.delete(nodeId)
        // Clean up any in-flight requests from this connection.
        for (const [reqId, reqWs] of pendingReqs) {
          if (reqWs === ws) pendingReqs.delete(reqId)
        }
      })
    })
  })
}
