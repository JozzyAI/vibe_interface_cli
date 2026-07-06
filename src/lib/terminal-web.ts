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
import { isSafeSessionName } from './tmux.js'

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
let xtermFitJs: Buffer | undefined
function xtermAssets(): { js: Buffer; css: Buffer; fitJs: Buffer } {
  if (!xtermJs) xtermJs = fs.readFileSync(require.resolve('@xterm/xterm/lib/xterm.js'))
  if (!xtermCss) xtermCss = fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'))
  // FitAddon: sizes the terminal to the (phone) viewport correctly — manual fit
  // needs xterm-internal render metrics/DPR math that's fragile on mobile.
  if (!xtermFitJs) xtermFitJs = fs.readFileSync(require.resolve('@xterm/addon-fit/lib/addon-fit.js'))
  return { js: xtermJs, css: xtermCss, fitJs: xtermFitJs }
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
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>vibe terminal · ${safeSession}</title>
<link rel="stylesheet" href="/xterm.css">
<style>
  html,body{margin:0;height:100dvh;background:#000;overflow:hidden}
  #bar{font:12px ui-monospace,Menlo,monospace;color:#7fdbca;background:#11161d;padding:6px 10px;height:16px}
  #wrap{position:absolute;top:28px;left:0;right:0;bottom:0}
  #term{position:absolute;inset:0;padding:4px 4px env(safe-area-inset-bottom) 4px}
  #load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#7fdbca;font:13px ui-monospace,Menlo,monospace;background:#000;z-index:2}
  .xterm-viewport{overflow-y:auto !important}
</style>
</head>
<body>
<div id="bar">vibe terminal — session <b>${safeSession}</b> — write-capable</div>
<div id="wrap"><div id="term"></div><div id="load">connecting…</div></div>
<script src="/xterm.js"></script>
<script src="/addon-fit.js"></script>
<script>
  var term = new Terminal({ cursorBlink: false, convertEol: true, scrollback: 400, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13 });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));
  var loadEl = document.getElementById('load');
  function doFit(){ try { fit.fit(); } catch (_) {} }
  doFit(); term.focus();

  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Forward the page query (e.g. ?session=X&create=1) to the bridge. Local/remote
  // serve loads at "/" with no query, so this stays "/ws".
  var ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);

  // Tab-visibility render-skip: while hidden, don't repaint every frame — buffer
  // only the latest frame and apply it once when we become visible again.
  var pending = null, hidden = document.hidden;
  function apply(data){ if (loadEl){ loadEl.style.display='none'; loadEl=null; } term.write(data); }
  ws.onmessage = function (e) {
    try { var m = JSON.parse(e.data); if (m.type !== 'output') return;
      if (hidden) { pending = m.data; } else { apply(m.data); }
    } catch (_) {}
  };
  document.addEventListener('visibilitychange', function(){
    hidden = document.hidden;
    if (!hidden) { doFit(); if (pending !== null) { apply(pending); pending = null; } sendResize(); }
  });

  term.onData(function (d) { ws.send(JSON.stringify({ type: 'input', data: d })); }); // input never logged
  function sendResize() { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }
  ws.onopen = function(){ doFit(); sendResize(); };
  term.onResize(sendResize);
  window.addEventListener('resize', function(){ doFit(); });
  window.addEventListener('orientationchange', function(){ setTimeout(function(){ doFit(); sendResize(); }, 200); });
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
  onConnection: (ws: WebSocket, req: http.IncomingMessage) => void,
  httpRoutes?: (req: http.IncomingMessage, res: http.ServerResponse, ctx: { controlToken: string; setCookie: Record<string, string>; url: URL }) => boolean,
): Promise<TerminalServer> {
  const { session, host, port, controlToken } = opts

  const server = http.createServer((req, res) => {
    const decision = checkControlAccess(req, controlToken)
    if (!decision.ok) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized\n')
      return
    }
    const setCookie: Record<string, string> = decision.setCookie ? { 'set-cookie': decision.setCookie } : {}
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Optional custom routes (dashboard) run first and own their own method
    // handling, so DELETE /api/* is reachable. Falls through to the GET-only
    // page + assets below when not handled.
    if (httpRoutes && httpRoutes(req, res, { controlToken, setCookie, url })) return
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' })
      res.end('method not allowed\n')
      return
    }
    const path = url.pathname
    if (path === '/xterm.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...setCookie })
      res.end(xtermAssets().js)
      return
    }
    if (path === '/addon-fit.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...setCookie })
      res.end(xtermAssets().fitJs)
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
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req))
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

/** Tiny phone-friendly dashboard page. The node id is embedded (non-secret); the
 *  control token is NEVER placed in the page — auth stays in the HttpOnly cookie
 *  and API calls carry the X-Vibe-Control CSRF header. Session names are rendered
 *  via textContent, never innerHTML. */
export function dashboardHtml(nodeId: string): string {
  const safeNode = String(nodeId).replace(/[<>&"]/g, '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibe terminal · ${safeNode}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0f14;color:#c9d1d9;font:14px ui-monospace,Menlo,monospace}
  header{padding:12px 14px;background:#11161d;border-bottom:1px solid #222}
  h1{font-size:14px;margin:0 0 2px}
  .sub{color:#7fdbca;font-size:12px}
  main{padding:14px;max-width:640px}
  h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px}
  .row{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #222;border-radius:8px;margin-bottom:8px}
  .nm{flex:1;word-break:break-all}
  .btn{appearance:none;border:1px solid #2b3440;background:#1b2230;color:#c9d1d9;padding:8px 12px;border-radius:8px;font:inherit;text-decoration:none;cursor:pointer}
  .btn:active{background:#243044}
  .stop{border-color:#5a2a2a;background:#2a1717}
  form{display:flex;gap:8px}
  input{flex:1;padding:9px;border:1px solid #2b3440;background:#0d1117;color:#c9d1d9;border-radius:8px;font:inherit}
  #list .empty{color:#6e7681}
</style>
</head>
<body>
<header>
  <h1>vibe terminal</h1>
  <div class="sub">node <b>${safeNode}</b> · <span id="status">…</span> · write-capable</div>
</header>
<main>
  <h2>Owned sessions <button id="refresh" class="btn" style="float:right;padding:4px 8px">Refresh</button></h2>
  <div id="list"><span class="empty">loading…</span></div>
  <h2>New session</h2>
  <form id="newform">
    <input id="newname" placeholder="session name" autocapitalize="off" autocomplete="off" spellcheck="false">
    <button type="submit" class="btn">Create / Open</button>
  </form>
</main>
<script>
  var NAME_RE=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  function api(path, opts){ opts=opts||{}; opts.headers=Object.assign({'X-Vibe-Control':'1'}, opts.headers||{}); return fetch(path, opts); }
  function render(sessions){
    var list=document.getElementById('list'); list.innerHTML='';
    if(!sessions.length){ var e=document.createElement('span'); e.className='empty'; e.textContent='(no owned sessions yet)'; list.appendChild(e); return; }
    sessions.forEach(function(name){
      var row=document.createElement('div'); row.className='row';
      var nm=document.createElement('span'); nm.className='nm'; nm.textContent=name; row.appendChild(nm);
      var open=document.createElement('a'); open.className='btn'; open.textContent='Open'; open.href='/terminal?session='+encodeURIComponent(name); row.appendChild(open);
      var stop=document.createElement('button'); stop.className='btn stop'; stop.textContent='Stop';
      stop.onclick=function(){ stop.disabled=true; api('/api/sessions/'+encodeURIComponent(name),{method:'DELETE'}).then(function(r){return r.json().catch(function(){return {};});}).then(function(j){ if(j.ok){ load(); } else { alert('stop: '+(j.message||j.code||'failed')); stop.disabled=false; } }); };
      row.appendChild(stop); list.appendChild(row);
    });
  }
  function load(){
    var list=document.getElementById('list'); list.innerHTML='<span class="empty">loading…</span>';
    api('/api/sessions').then(function(r){ if(!r.ok){ throw new Error('HTTP '+r.status); } return r.json(); })
      .then(function(d){ document.getElementById('status').textContent=d.online?'● online':'○ offline'; render(d.sessions||[]); })
      .catch(function(e){ document.getElementById('status').textContent='○ error'; document.getElementById('list').textContent='error: '+e.message; });
  }
  document.getElementById('refresh').onclick=load;
  document.getElementById('newform').addEventListener('submit', function(ev){ ev.preventDefault(); var name=(document.getElementById('newname').value||'').trim(); if(!NAME_RE.test(name)){ alert('invalid name — letters/digits/_/-, 1–64 chars'); return; } location.href='/terminal?session='+encodeURIComponent(name)+'&create=1'; });
  load();
</script>
</body>
</html>`
}

export interface TerminalDashboardOptions {
  nodeId: string
  host: string
  port: number
  controlToken: string
  relay: string
  token: string   // relay auth token VALUE (resolved by the caller; never logged)
}

/**
 * Start the terminal DASHBOARD server: a phone-friendly home page that lists
 * Vibe-owned sessions and opens/creates/stops them — all on the SAME gateway
 * port, reusing the control-token gate + xterm + remote bridge. Runs the relay
 * list/kill helpers server-side (one-shot relay WS each). No relay protocol
 * change. Never logs the token or typed input.
 */
export function startTerminalDashboardServer(opts: TerminalDashboardOptions): Promise<TerminalServer> {
  return serveTerminal(
    { session: '', host: opts.host, port: opts.port, controlToken: opts.controlToken },
    // WS: bridge to the session named in the query (create-if-missing per ?create=1).
    (ws, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const session = url.searchParams.get('session') ?? ''
      const create = url.searchParams.get('create') === '1'
      if (!isSafeSessionName(session)) {
        try { ws.send(JSON.stringify({ type: 'output', data: '\r\n[vibe] invalid or missing session\r\n' })); ws.close() } catch { /* ignore */ }
        return
      }
      bridgeRemoteTerminal(ws, { relay: opts.relay, token: opts.token, nodeId: opts.nodeId, session, create })
    },
    // HTTP: dashboard `/`, `/terminal`, and the `/api/sessions` list/stop.
    (req, res, ctx) => {
      const path = ctx.url.pathname
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...ctx.setCookie })
        res.end(dashboardHtml(opts.nodeId))
        return true
      }
      if (path === '/terminal' && req.method === 'GET') {
        const session = ctx.url.searchParams.get('session') ?? ''
        if (!isSafeSessionName(session)) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('invalid session name\n'); return true }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...ctx.setCookie })
        res.end(terminalHtml(session))
        return true
      }
      if (path === '/api/sessions' || path.startsWith('/api/sessions/')) {
        // CSRF guard: same-origin JS sets this header; cross-origin can't without
        // a CORS preflight we never approve. Applied to every /api route.
        if (req.headers['x-vibe-control'] !== '1') { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('missing X-Vibe-Control header\n'); return true }
        if (path === '/api/sessions' && req.method === 'GET') {
          void (async () => {
            try {
              const { remoteTerminalList } = await import('../relay/client.js')
              const sessions = await remoteTerminalList(opts.relay, opts.token, opts.nodeId)
              res.writeHead(200, { 'content-type': 'application/json', ...ctx.setCookie }); res.end(JSON.stringify({ node: opts.nodeId, online: true, sessions }))
            } catch (err) {
              res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ node: opts.nodeId, online: false, sessions: [], error: (err as Error).message }))
            }
          })()
          return true
        }
        if (path.startsWith('/api/sessions/') && req.method === 'DELETE') {
          const name = decodeURIComponent(path.slice('/api/sessions/'.length))
          if (!isSafeSessionName(name)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, code: 'invalid_session_name' })); return true }
          void (async () => {
            try {
              const { remoteTerminalKill } = await import('../relay/client.js')
              const r = await remoteTerminalKill(opts.relay, opts.token, opts.nodeId, name)
              res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r))
            } catch (err) {
              res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, code: 'terminal_stop_failed', message: (err as Error).message }))
            }
          })()
          return true
        }
        res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, DELETE' }); res.end('method not allowed\n')
        return true
      }
      return false // fall through to /xterm.js, /xterm.css, and the default 404
    },
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
