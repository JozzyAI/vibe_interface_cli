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
  :root{
    --bg:#0b0f14; --bar:#11161d; --border:#21262d; --text:#c9d1d9; --muted:#8b949e;
    --teal:#7fdbca; --ok:#3fb950; --warn:#d29922; --err:#f85149;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100dvh;background:var(--bg);overflow:hidden}
  body{display:flex;flex-direction:column;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)}
  #bar{
    flex:0 0 auto;display:flex;align-items:center;gap:10px;
    padding:8px 10px;padding-top:calc(8px + env(safe-area-inset-top));
    background:var(--bar);border-bottom:1px solid var(--border);
  }
  #back{
    display:none;align-items:center;justify-content:center;flex:0 0 auto;
    min-width:40px;height:34px;padding:0 10px;border:1px solid #2b3440;border-radius:8px;
    background:#1b2230;color:var(--text);text-decoration:none;font-size:16px;line-height:1;
  }
  #back:active{background:#243044}
  .titles{flex:1 1 auto;min-width:0;line-height:1.25}
  .brand{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .sess{color:var(--teal);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #conn{
    flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;
    padding:5px 9px;border-radius:999px;font-size:11px;white-space:nowrap;
    border:1px solid var(--border);background:#0d1117;color:var(--muted);
  }
  #conn .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
  #conn.connecting{color:var(--warn)} #conn.connecting .dot{background:var(--warn)}
  #conn.connected{color:var(--ok)} #conn.connected .dot{background:var(--ok)}
  #conn.down{color:var(--err)} #conn.down .dot{background:var(--err)}
  #wrap{flex:1 1 auto;position:relative;min-height:0}
  #term{position:absolute;inset:0;padding:4px 4px env(safe-area-inset-bottom) 4px}
  #load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--teal);font:13px ui-monospace,Menlo,monospace;background:var(--bg);z-index:2}
  .xterm-viewport{overflow-y:auto !important}
</style>
</head>
<body>
<div id="bar">
  <a id="back" href="/" title="Back to dashboard" aria-label="Back to dashboard">‹</a>
  <div class="titles">
    <div class="brand">Vibe Terminal · write-capable</div>
    <div class="sess" title="${safeSession}">${safeSession}</div>
  </div>
  <span id="conn" class="connecting"><span class="dot"></span><span id="connlabel">connecting</span></span>
</div>
<div id="wrap"><div id="term"></div><div id="load">connecting…</div></div>
<script src="/xterm.js"></script>
<script src="/addon-fit.js"></script>
<script>
  // "Back to dashboard" only makes sense in dashboard mode (page served at
  // /terminal). A standalone serve loads the terminal at "/", where Back would
  // just reload the same page — so hide it there.
  if (location.pathname === '/terminal') document.getElementById('back').style.display='inline-flex';

  var conn = document.getElementById('conn'), connLabel = document.getElementById('connlabel');
  function setConn(cls, label){ conn.className = cls; connLabel.textContent = label; }

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
  ws.onopen = function(){ setConn('connected','connected'); doFit(); sendResize(); };
  ws.onclose = function(){ setConn('down','disconnected'); if (loadEl){ loadEl.textContent='disconnected'; } };
  ws.onerror = function(){ setConn('down','disconnected'); };
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Vibe Terminal · ${safeNode}</title>
<style>
  :root{
    color-scheme:dark;
    --bg:#0b0f14; --surface:#11161d; --surface2:#161b22; --border:#21262d; --border2:#30363d;
    --text:#c9d1d9; --muted:#8b949e; --faint:#6e7681;
    --teal:#7fdbca; --blue:#388bfd; --ok:#3fb950; --warn:#d29922; --err:#f85149;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-text-size-adjust:100%}
  /* ── header ── */
  header{
    position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--border);
    padding:12px 14px;padding-top:calc(12px + env(safe-area-inset-top));
    display:flex;align-items:center;gap:12px;
  }
  .hgrow{flex:1 1 auto;min-width:0}
  h1{font-size:15px;margin:0;letter-spacing:.02em}
  .node{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .node b{color:var(--teal);font-weight:600}
  .chip{
    display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;
    padding:5px 10px;border-radius:999px;font-size:11px;white-space:nowrap;
    border:1px solid var(--border2);background:#0d1117;color:var(--muted);
  }
  .chip .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
  .chip.online{color:var(--ok);border-color:#1f6f34} .chip.online .dot{background:var(--ok)}
  .chip.offline{color:var(--warn);border-color:#6b4c17} .chip.offline .dot{background:var(--warn)}
  .chip.error{color:var(--err);border-color:#79231f} .chip.error .dot{background:var(--err)}
  .chip.checking{color:var(--muted)} .chip.checking .dot{background:var(--muted);animation:pulse 1s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
  /* ── layout ── */
  main{padding:14px;max-width:680px;margin:0 auto}
  .sechead{display:flex;align-items:center;gap:10px;margin:22px 0 10px}
  .sechead:first-child{margin-top:6px}
  h2{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0;flex:1 1 auto}
  /* ── buttons (44px touch targets on mobile) ── */
  .btn{
    appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;
    min-height:40px;padding:0 14px;border:1px solid var(--border2);border-radius:10px;
    background:var(--surface2);color:var(--text);font:inherit;font-size:13px;text-decoration:none;
    cursor:pointer;transition:background .12s,border-color .12s,opacity .12s;white-space:nowrap;
  }
  .btn:hover{border-color:#3f4956}
  .btn:active{transform:translatey(1px)}
  .btn:disabled{opacity:.55;cursor:default}
  .btn.small{min-height:32px;padding:0 10px;font-size:12px}
  .btn.open{border-color:#1f4b7a;background:#12233a;color:#9cc7ff}
  .btn.open:hover{background:#173049}
  .btn.stop{border-color:#5a2a2a;background:#2a1717;color:#ffb4ab}
  .btn.stop:hover{background:#3a1d1d}
  .btn.stop.confirm{background:var(--err);border-color:var(--err);color:#0b0f14;font-weight:600}
  .btn.primary{border-color:#1f4b7a;background:#12233a;color:#9cc7ff}
  .btn.primary:hover{background:#173049}
  /* ── session cards ── */
  .card{
    display:flex;align-items:center;gap:10px;padding:12px;margin-bottom:10px;
    border:1px solid var(--border);border-radius:12px;background:var(--surface);
  }
  .card .nm{flex:1 1 auto;min-width:0;font-size:14px;word-break:break-all}
  .card .nm .sub{display:block;color:var(--faint);font-size:11px;word-break:normal}
  .card .actions{display:flex;gap:8px;flex:0 0 auto}
  /* ── new-session form ── */
  form{margin:0}
  .field{display:flex;gap:8px;align-items:stretch}
  input{
    flex:1 1 auto;min-width:0;min-height:40px;padding:0 12px;border:1px solid var(--border2);
    background:#0d1117;color:var(--text);border-radius:10px;font:inherit;font-size:14px;
  }
  input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 2px rgba(56,139,253,.25)}
  input.invalid{border-color:var(--err)}
  input.invalid:focus{box-shadow:0 0 0 2px rgba(248,81,73,.25)}
  .hint{min-height:16px;margin:6px 2px 0;font-size:12px;color:var(--faint)}
  .hint.err{color:var(--err)}
  /* ── states ── */
  .state{padding:22px 14px;text-align:center;border:1px dashed var(--border2);border-radius:12px;color:var(--muted)}
  .state .big{font-size:13px;color:var(--text)}
  .state .small{font-size:12px;color:var(--faint);margin-top:4px}
  .state.error{border-color:#79231f;color:var(--err)}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--border2);border-top-color:var(--teal);border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<header>
  <div class="hgrow">
    <h1>Vibe Terminal</h1>
    <div class="node">node <b>${safeNode}</b></div>
  </div>
  <span id="status" class="chip checking"><span class="dot"></span><span id="statuslabel">checking…</span></span>
  <button id="refresh" class="btn small" title="Refresh">Refresh</button>
</header>
<main>
  <div class="sechead"><h2>Owned sessions</h2></div>
  <div id="list"></div>
  <div class="sechead"><h2>New session</h2></div>
  <form id="newform" autocomplete="off" novalidate>
    <div class="field">
      <input id="newname" placeholder="session name" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="go" aria-label="new session name">
      <button id="newbtn" type="submit" class="btn primary">Create / Open</button>
    </div>
    <div id="newhint" class="hint">Letters, digits, <code>_</code> and <code>-</code> · 1–64 chars.</div>
  </form>
</main>
<script>
  var NAME_RE=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  function api(path, opts){ opts=opts||{}; opts.headers=Object.assign({'X-Vibe-Control':'1'}, opts.headers||{}); return fetch(path, opts); }
  function el(tag, cls, text){ var e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }

  var listEl=document.getElementById('list');
  var statusEl=document.getElementById('status'), statusLabel=document.getElementById('statuslabel');
  function setStatus(cls,label){ statusEl.className='chip '+cls; statusLabel.textContent=label; }

  // Rebuilding the list detaches any armed Stop button; clear its pending 3s
  // reset timer so it can't fire disarm() on a removed node.
  var armTimers=[];
  function clearArmTimers(){ for(var i=0;i<armTimers.length;i++) clearTimeout(armTimers[i]); armTimers=[]; }

  function stateBox(kind, big, small){
    clearArmTimers(); listEl.innerHTML='';
    var box=el('div','state'+(kind==='error'?' error':''));
    var b=el('div','big'); if(kind==='loading'){ b.appendChild(el('span','spin')); b.appendChild(document.createTextNode(' '+big)); } else { b.textContent=big; }
    box.appendChild(b);
    if(small){ box.appendChild(el('div','small',small)); }
    listEl.appendChild(box);
  }

  function render(sessions){
    clearArmTimers(); listEl.innerHTML='';
    if(!sessions.length){ stateBox('empty','No owned sessions yet','Create one below to get started.'); return; }
    sessions.forEach(function(name){
      var card=el('div','card');
      var nm=el('div','nm'); nm.appendChild(el('span',null,name)); nm.appendChild(el('span','sub','tmux · Vibe-owned')); card.appendChild(nm);
      var actions=el('div','actions');
      var open=el('a','btn open small','Open'); open.href='/terminal?session='+encodeURIComponent(name); actions.appendChild(open);
      var stop=el('button','btn stop small','Stop'); stop.type='button';
      var armed=false, armTimer=null;
      function disarm(){ armed=false; stop.classList.remove('confirm'); stop.textContent='Stop'; if(armTimer){clearTimeout(armTimer);armTimer=null;} }
      stop.onclick=function(){
        if(!armed){ armed=true; stop.classList.add('confirm'); stop.textContent='Confirm stop'; armTimer=setTimeout(disarm,3000); armTimers.push(armTimer); return; }
        if(armTimer){clearTimeout(armTimer);armTimer=null;}
        stop.disabled=true; stop.classList.remove('confirm'); stop.textContent='Stopping…';
        api('/api/sessions/'+encodeURIComponent(name),{method:'DELETE'})
          .then(function(r){return r.json().catch(function(){return {};});})
          .then(function(j){ if(j.ok){ load(); } else { stop.disabled=false; disarm(); showRowError(card,'stop failed: '+(j.message||j.code||'unknown')); } })
          .catch(function(e){ stop.disabled=false; disarm(); showRowError(card,'stop failed: '+e.message); });
      };
      actions.appendChild(stop); card.appendChild(actions); listEl.appendChild(card);
    });
  }
  function showRowError(card, msg){
    var old=card.parentNode.querySelector('.rowerr'); if(old)old.remove();
    var e=el('div','hint err rowerr',msg); e.style.marginBottom='10px'; card.parentNode.insertBefore(e, card.nextSibling);
  }

  var refreshBtn=document.getElementById('refresh');
  // Monotonic request token: loads can overlap (Refresh + a Stop success both
  // call load()), so a stale response must never overwrite newer UI state.
  var loadSeq=0;
  function load(){
    var seq=++loadSeq;
    setStatus('checking','checking…'); refreshBtn.disabled=true; stateBox('loading','Loading sessions…');
    api('/api/sessions').then(function(r){ if(!r.ok){ throw new Error('HTTP '+r.status); } return r.json(); })
      .then(function(d){
        if(seq!==loadSeq) return; // a newer load started; drop this stale response
        refreshBtn.disabled=false;
        if(d.online===false){ setStatus('offline','offline'); stateBox('empty','Node is offline','The node daemon isn\\u2019t reachable via the relay right now. Tap Refresh once it\\u2019s back.'); return; }
        setStatus('online','online'); render(d.sessions||[]);
      })
      .catch(function(e){ if(seq!==loadSeq) return; refreshBtn.disabled=false; setStatus('error','error'); stateBox('error','Couldn\\u2019t reach the gateway',e.message); });
  }
  refreshBtn.onclick=load;

  var nameEl=document.getElementById('newname'), hintEl=document.getElementById('newhint'), newBtn=document.getElementById('newbtn');
  var DEFAULT_HINT='Letters, digits, _ and - \\u00b7 1\\u201364 chars.';
  function clearInvalid(){ nameEl.classList.remove('invalid'); hintEl.className='hint'; hintEl.textContent=DEFAULT_HINT; }
  nameEl.addEventListener('input', clearInvalid);
  document.getElementById('newform').addEventListener('submit', function(ev){
    ev.preventDefault();
    var name=(nameEl.value||'').trim();
    if(!NAME_RE.test(name)){
      nameEl.classList.add('invalid'); hintEl.className='hint err';
      hintEl.textContent=name?'Invalid name \\u2014 use letters, digits, _ or -, 1\\u201364 chars.':'Enter a session name.';
      nameEl.focus(); return;
    }
    newBtn.disabled=true; nameEl.disabled=true; newBtn.textContent='Opening…';
    location.href='/terminal?session='+encodeURIComponent(name)+'&create=1';
  });
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
