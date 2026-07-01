/**
 * Remote-terminal gateway bridge: connect ONE browser WebSocket to a node's
 * terminal OVER THE RELAY.
 *
 *   browser WS  <->  this bridge  <->  relay ws  <->  node daemon
 *
 * The browser speaks the same tiny JSON protocol as the local terminal
 * (`{type:'input'|'resize', ...}` up, `{type:'output', data}` down). This bridge
 * translates that to/from the relay `terminal_*` messages:
 *   input  -> terminal_input      (to: node)
 *   resize -> terminal_resize     (to: node)
 *   open   -> terminal_open       (to: node, on connect)
 *   close  -> terminal_close      (to: node, on browser close)
 *   terminal_output (from node)   -> {type:'output'} to the browser
 *
 * This PR wires the transport only; the node replies with an ECHO handler (no
 * tmux yet). Keystroke `data` is NEVER logged.
 */
import crypto from 'crypto'
import { WebSocket } from 'ws'

export interface RemoteTerminalBridgeOpts {
  relay: string    // relay ws url
  token: string    // relay auth token value (never logged)
  nodeId: string   // target node
  session: string  // node-side session name (echo node ignores it)
}

function relayUrl(relay: string, token: string): string {
  return relay + (relay.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}

function newSessionId(): string {
  return 'ts_' + crypto.randomBytes(9).toString('base64url')
}

/**
 * Bridge one browser WS to the node's terminal over the relay. Returns nothing;
 * lifecycle is driven by the two sockets. Silent — no logging of input/tokens.
 */
export function bridgeRemoteTerminal(browser: WebSocket, opts: RemoteTerminalBridgeOpts): void {
  const sessionId = newSessionId()
  const t = (): string => new Date().toISOString()
  const relay = new WebSocket(relayUrl(opts.relay, opts.token))

  const toBrowser = (data: string): void => {
    try { browser.send(JSON.stringify({ type: 'output', data })) } catch { /* browser gone */ }
  }
  const closeBoth = (): void => {
    try { relay.close() } catch { /* ignore */ }
    try { browser.close() } catch { /* ignore */ }
  }

  relay.on('open', () => {
    relay.send(JSON.stringify({
      version: 1, kind: 'plaintext', from: 'cli', to: opts.nodeId, ts: t(),
      type: 'terminal_open', req_id: sessionId, session_id: sessionId, session: opts.session,
    }))
  })

  relay.on('message', (raw) => {
    let msg: { type?: string; session_id?: string; data?: string; ok?: boolean; message?: string; code?: string }
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.session_id !== sessionId) return
    if (msg.type === 'terminal_output' && typeof msg.data === 'string') {
      toBrowser(msg.data)
    } else if (msg.type === 'terminal_open_ack' && msg.ok === false) {
      toBrowser(`\r\n[vibe] terminal open failed: ${msg.message ?? 'unknown'}\r\n`)
      closeBoth()
    } else if (msg.type === 'terminal_error') {
      toBrowser(`\r\n[vibe] terminal error (${msg.code}): ${msg.message}\r\n`)
      closeBoth()
    }
  })

  relay.on('close', () => { try { browser.close() } catch { /* ignore */ } })
  relay.on('error', () => { toBrowser('\r\n[vibe] relay connection error\r\n'); closeBoth() })

  browser.on('message', (raw) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number }
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (relay.readyState !== WebSocket.OPEN) return
    if (msg.type === 'input' && typeof msg.data === 'string') {
      // Forward keystrokes to the node — NEVER logged.
      relay.send(JSON.stringify({
        version: 1, kind: 'plaintext', from: 'cli', to: opts.nodeId, ts: t(),
        type: 'terminal_input', session_id: sessionId, data: msg.data,
      }))
    } else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      relay.send(JSON.stringify({
        version: 1, kind: 'plaintext', from: 'cli', to: opts.nodeId, ts: t(),
        type: 'terminal_resize', session_id: sessionId, cols: msg.cols, rows: msg.rows,
      }))
    }
  })

  browser.on('close', () => {
    if (relay.readyState === WebSocket.OPEN) {
      try {
        relay.send(JSON.stringify({
          version: 1, kind: 'plaintext', from: 'cli', to: opts.nodeId, ts: t(),
          type: 'terminal_close', session_id: sessionId,
        }))
      } catch { /* ignore */ }
    }
    try { relay.close() } catch { /* ignore */ }
  })
  browser.on('error', () => closeBoth())
}
