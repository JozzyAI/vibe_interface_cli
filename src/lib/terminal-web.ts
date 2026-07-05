/**
 * Local interactive tmux web terminal (Terminal Mode MVP — local tmux only).
 *
 * WRITE-CAPABLE: a browser drives an EXISTING tmux session over a WebSocket.
 *   - input  : browser keystroke → `tmux send-keys -l` (spawned with an ARGS
 *              ARRAY, never a shell string, so pane input cannot inject a command)
 *   - output : poll `tmux capture-pane -p -e` → WS → xterm.js renders the pane
 *   - auth   : a one-time CONTROL token, DISTINCT from the read-only viewer access
 *              token, required on BOTH the page and the WS upgrade (via `?control=`
 *              query or the HttpOnly `vibe_control` cookie)
 *   - bind   : loopback-only by default; a non-loopback bind needs the caller's
 *              explicit `--allow-control-bind` opt-in (a stronger, separate flag —
 *              NOT the viewer's `--allow-public-bind`)
 *
 * Deliberately NOT here: node-pty (tmux only, no native deps), any relay
 * transport (local only), and any launching of shells/agents (attaches to a
 * session the operator already created).
 *
 * This module NEVER logs keystrokes/input or the control token.
 */
import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import { spawn, spawnSync } from 'child_process'
import { createRequire } from 'module'
import { WebSocketServer, type WebSocket } from 'ws'
import { generateAccessToken } from './run-web.js'
import { bridgeRemoteTerminal } from './terminal-remote.js'

const require = createRequire(import.meta.url)
const CONTROL_COOKIE = 'vibe_control'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

// ── tmux preconditions ───────────────────────────────────────────────────────

export function tmuxAvailable(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
}

/** True iff a tmux session with exactly this name exists. */
export function tmuxSessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0
}

// ── bind guard (write-capable → stricter than the read-only viewer) ──────────

export type ControlBindDecision =
  | { ok: true; host: string }
  | { ok: false; code: 'control_bind_refused'; message: string }

/**
 * A non-loopback bind exposes a WRITE-CAPABLE terminal on the network, so it is
 * refused unless the caller opts in with `--allow-control-bind`.
 */
export function validateControlBind(host: string, allowControlBind: boolean): ControlBindDecision {
  if (LOOPBACK_HOSTS.has(host) || allowControlBind) return { ok: true, host }
  return {
    ok: false,
    code: 'control_bind_refused',
    message:
      `refusing to bind ${host}: the web terminal is WRITE-CAPABLE and loopback-only by default. ` +
      `Re-run with --allow-control-bind to expose it on the network (strongly discouraged).`,
  }
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

// ── control-token auth (page + WS) ───────────────────────────────────────────

/** One-time control token. Reuses the generic random-token generator. */
export function generateControlToken(): string {
  return generateAccessToken()
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

export type ControlDecision = { ok: true; setCookie?: string } | { ok: false }

/**
 * Authorize a terminal request. Unlike the read-only viewer, the control token
 * is ALWAYS required (write access), on both the page and the WS upgrade. The
 * token arrives via the `?control=` query (first hit also sets an HttpOnly cookie
 * so later requests / the WS upgrade need no query) or the `vibe_control` cookie.
 * Constant-time compared.
 */
export function checkControlAccess(req: http.IncomingMessage, controlToken: string): ControlDecision {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('control')
  if (query && safeEqual(query, controlToken)) {
    return { ok: true, setCookie: `${CONTROL_COOKIE}=${controlToken}; HttpOnly; SameSite=Strict; Path=/` }
  }
  const cookie = cookieValue(req.headers.cookie, CONTROL_COOKIE)
  if (cookie && safeEqual(cookie, controlToken)) return { ok: true }
  return { ok: false }
}

// ── vendored xterm assets (from the local @xterm/xterm dependency) ────────────

let xtermJs: Buffer | undefined
let xtermCss: Buffer | undefined
function xtermAssets(): { js: Buffer; css: Buffer } {
  if (!xtermJs) xtermJs = fs.readFileSync(require.resolve('@xterm/xterm/lib/xterm.js'))
  if (!xtermCss) xtermCss = fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'))
  return { js: xtermJs, css: xtermCss }
}

/** The terminal page. The control token is NEVER embedded in the HTML — the WS
 *  authenticates via the HttpOnly cookie set on this page load, so JS never sees
 *  the token. */
export function terminalHtml(session: string): string {
  const safeSession = String(session).replace(/[<>&"]/g, '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibe terminal · ${safeSession}</title>
<link rel="stylesheet" href="/xterm.css">
<style>
  html,body{margin:0;height:100%;background:#000}
  #bar{font:12px ui-monospace,Menlo,monospace;color:#7fdbca;background:#11161d;padding:4px 10px}
  #term{position:absolute;top:24px;left:0;right:0;bottom:0;padding:4px}
</style>
</head>
<body>
<div id="bar">vibe terminal — session <b>${safeSession}</b> — write-capable</div>
<div id="term"></div>
<script src="/xterm.js"></script>
<script>
  var term = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13 });
  term.open(document.getElementById('term'));
  term.focus();
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  var ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onmessage = function (e) {
    try { var m = JSON.parse(e.data); if (m.type === 'output') term.write(m.data); } catch (_) {}
  };
  term.onData(function (d) { ws.send(JSON.stringify({ type: 'input', data: d })); });
  function sendResize() { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }
  ws.onopen = sendResize;
  term.onResize(sendResize);
</script>
</body>
</html>`
}

// ── server ───────────────────────────────────────────────────────────────────

export interface TerminalServer {
  host: string
  port: number
  url: string
  close(): Promise<void>
}

export interface TerminalOptions {
  session: string
  host: string
  port: number
  controlToken: string
  /** Pane poll interval (ms); default 150. */
  pollMs?: number
}

/**
 * Start the local terminal server. The HTTP layer serves the xterm page + assets
 * (control-token gated); the WS layer bridges browser <-> the tmux session.
 * Resolves once listening. This function performs NO stdout/stderr logging (the
 * command layer prints the URL); it never logs input or the token.
 */
/**
 * Shared HTTP+WS scaffold for both local and remote terminals: control-token
 * gate, xterm page/assets, `/ws` upgrade. `onConnection(ws)` is called for each
 * authenticated browser WebSocket and owns the actual bridge (local tmux or
 * relay). Performs NO logging; never logs input or the token.
 */
function serveTerminal(
  opts: { session: string; host: string; port: number; controlToken: string },
  onConnection: (ws: WebSocket) => void,
): Promise<TerminalServer> {
  const { session, host, port, controlToken } = opts

  const server = http.createServer((req, res) => {
    const decision = checkControlAccess(req, controlToken)
    if (!decision.ok) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized\n')
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' })
      res.end('method not allowed\n')
      return
    }
    const setCookie = decision.setCookie ? { 'set-cookie': decision.setCookie } : {}
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/xterm.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...setCookie })
      res.end(xtermAssets().js)
      return
    }
    if (path === '/xterm.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', ...setCookie })
      res.end(xtermAssets().css)
      return
    }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...setCookie })
      res.end(terminalHtml(session))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== '/ws') { socket.destroy(); return }
    // Authenticate the WS upgrade with the SAME control token (cookie or query).
    if (!checkControlAccess(req, controlToken).ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const boundPort = (server.address() as { port: number }).port
      resolve({
        host,
        port: boundPort,
        url: `http://${host}:${boundPort}/?control=${controlToken}`,
        close: () => new Promise<void>((r) => { wss.close(); server.close(() => r()) }),
      })
    })
  })
}

/**
 * Start the LOCAL terminal server (PR #41 behaviour, unchanged): the HTTP layer
 * serves the xterm page + assets (control-token gated); the WS layer bridges the
 * browser to a LOCAL tmux session via send-keys/capture-pane.
 */
export function startTerminalServer(opts: TerminalOptions): Promise<TerminalServer> {
  const pollMs = opts.pollMs ?? 150
  return serveTerminal(opts, (ws) => bridgeSession(ws, opts.session, pollMs))
}

export interface RemoteTerminalOptions {
  session: string    // node-side session name (shown in the page; sent in terminal_open)
  host: string
  port: number
  controlToken: string
  relay: string      // relay ws url
  token: string      // relay auth token VALUE (resolved by the caller; never logged)
  nodeId: string     // target node
  create?: boolean   // create-if-missing (node gates on its opt-in)
}

/**
 * Start the REMOTE terminal server: same xterm page + control-token gate, but
 * each browser WS is bridged to a node's terminal OVER THE RELAY
 * (browser WS ↔ relay `terminal_*` ↔ node). No tmux here — the node owns it.
 */
export function startRemoteTerminalServer(opts: RemoteTerminalOptions): Promise<TerminalServer> {
  return serveTerminal(opts, (ws) =>
    bridgeRemoteTerminal(ws, { relay: opts.relay, token: opts.token, nodeId: opts.nodeId, session: opts.session, create: opts.create }),
  )
}

/**
 * Bridge one WebSocket client to the tmux session: poll the pane out to the
 * client, forward client input in. Input is sent with a spawned ARGS ARRAY
 * (no shell) and is NEVER logged.
 */
function bridgeSession(ws: WebSocket, session: string, pollMs: number): void {
  let lastPane: string | undefined
  const poll = (): void => {
    const r = spawnSync('tmux', ['capture-pane', '-p', '-e', '-t', session], { encoding: 'utf8' })
    if (r.status !== 0) {
      try { ws.send(JSON.stringify({ type: 'output', data: '\r\n[vibe] tmux session ended\r\n' })) } catch { /* closing */ }
      clearInterval(timer)
      try { ws.close() } catch { /* already closing */ }
      return
    }
    const pane = r.stdout
    if (pane !== lastPane) {
      lastPane = pane
      // Home + clear, then redraw the captured pane (CRLF for xterm line breaks).
      const data = '\x1b[H\x1b[2J' + pane.replace(/\n/g, '\r\n')
      try { ws.send(JSON.stringify({ type: 'output', data })) } catch { /* closing */ }
    }
  }
  const timer = setInterval(poll, pollMs)
  poll()

  ws.on('message', (raw) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number }
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      // Literal keys via an ARGS ARRAY (no shell) — input is never logged.
      spawnSync('tmux', ['send-keys', '-t', session, '-l', '--', msg.data], { stdio: 'ignore' })
    } else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      // Best-effort; a session attached elsewhere may refuse — ignore errors.
      spawnSync('tmux', ['resize-window', '-t', session, '-x', String(msg.cols), '-y', String(msg.rows)], { stdio: 'ignore' })
    }
  })

  ws.on('close', () => clearInterval(timer))
  ws.on('error', () => clearInterval(timer))
}
