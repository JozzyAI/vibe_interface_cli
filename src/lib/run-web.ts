/**
 * Personal, local, read-only web viewer for a Vibe run session.
 *
 * Design constraints (PR #19):
 *   - Private by default: binds 127.0.0.1, no relay, no share links.
 *   - Read-only: only GET routes; never sends keystrokes/input to the session,
 *     never exposes a raw shell. The single tmux interaction is the read-only
 *     `tmux capture-pane -p`.
 *   - tmux-backed runs only for now. Detached-PID runs are reported as
 *     `session_not_web_attachable` (use `vibe run stream`).
 *   - Defence in depth: captured pane text is run through redact() before it
 *     ever reaches the browser, so a secret echoed into the pane is scrubbed.
 */
import http from 'http'
import { spawnSync } from 'child_process'
import { tryReadRun } from '../store.js'
import { readEvents } from '../events.js'
import { redact } from '../redact.js'
import { resolveAttach } from './run-actions.js'
import type { RunEvent, RunStatus } from '../types.js'

export type WebTarget =
  | { ok: true; run_id: string; tmux_session: string }
  | { ok: false; run_id: string; status: RunStatus; code: 'session_not_web_attachable'; message: string }

/**
 * Decide whether a run can be shown in the web viewer. Reuses resolveAttach
 * (which calls readRun → exits 3 if the run is unknown). Only a live tmux
 * session is web-attachable today; everything else (detached PID session, or a
 * finished run) is reported as not web-attachable.
 */
export function resolveWebTarget(run_id: string): WebTarget {
  const attach = resolveAttach(run_id)
  if (attach.ok) {
    return { ok: true, run_id, tmux_session: attach.tmux_session }
  }
  return {
    ok: false,
    run_id,
    status: attach.status,
    code: 'session_not_web_attachable',
    message:
      attach.code === 'session_not_found'
        ? `run ${run_id} has no live session to view (status: ${attach.status}); use \`vibe run status ${run_id}\` or \`vibe run stream ${run_id}\``
        : `run ${run_id} is a detached process with no tmux session to view; restart it with VIBE_USE_TMUX=1, or follow output with \`vibe run stream ${run_id}\``,
  }
}

/** True if the tmux binary is available (the viewer's only hard dependency). */
export function tmuxAvailable(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
}

/** Render a single run event into one readable line. Shared by the local and
 *  remote viewers so both present the same output. */
export function renderEventLine(e: RunEvent): string {
  switch (e.type) {
    case 'log': return e.message
    case 'error': return `ERROR: ${e.message}`
    case 'status': return `── status: ${e.status} ──`
    case 'approval_required': return `APPROVAL: ${e.message}`
    default: return e.type
  }
}

/** Render a run's persisted (already-redacted) events into readable lines. */
function renderEventLog(run_id: string, limit = 400): string {
  return readEvents(run_id).map(renderEventLine).slice(-limit).join('\n')
}

export interface PaneSnapshot {
  run_id: string
  status: RunStatus | 'unknown'
  /** Redacted content: the live tmux pane when non-empty, else the event log. */
  content: string
  /** Where `content` came from, for transparency in the UI. */
  source: 'tmux' | 'events'
  /** True once the tmux session no longer exists. */
  ended: boolean
  ts: string
}

/**
 * Read-only snapshot of a run: its status plus visible output. We capture the
 * live tmux pane (`tmux capture-pane -p`), but agents like the mock runner emit
 * structured events rather than printing to the pane, so when the pane is blank
 * we fall back to the redacted event log. Pane text is redacted again here as
 * defence in depth. On tmux failure (session gone) returns `ended: true` with
 * the final event log rather than throwing, so the viewer degrades cleanly.
 */
export function capturePane(run_id: string, tmux_session: string): PaneSnapshot {
  const record = tryReadRun(run_id)
  const status: RunStatus | 'unknown' = record?.status ?? 'unknown'
  const ts = new Date().toISOString()
  const r = spawnSync('tmux', ['capture-pane', '-p', '-t', tmux_session], { encoding: 'utf8' })

  if (r.status !== 0) {
    return { run_id, status, content: renderEventLog(run_id), source: 'events', ended: true, ts }
  }
  const pane = redact(r.stdout)
  if (pane.trim().length > 0) {
    return { run_id, status, content: pane, source: 'tmux', ended: false, ts }
  }
  return { run_id, status, content: renderEventLog(run_id), source: 'events', ended: false, ts }
}

export type BindDecision =
  | { ok: true; host: string }
  | { ok: false; code: 'public_bind_refused'; message: string }

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * A non-loopback bind exposes the session on the network, so it is refused
 * unless the caller explicitly opts in with --allow-public-bind.
 */
export function validateBind(host: string, allowPublicBind: boolean): BindDecision {
  if (LOCAL_HOSTS.has(host) || allowPublicBind) return { ok: true, host }
  return {
    ok: false,
    code: 'public_bind_refused',
    message: `refusing to bind ${host}: the web viewer is private by default. Re-run with --allow-public-bind to expose it on the network (not recommended).`,
  }
}

export function viewerHtml(run_id: string, opts: { subtitle?: string } = {}): string {
  // Self-contained, no external assets. Pane text is injected via textContent
  // (never innerHTML), so captured content cannot inject markup/script.
  const subtitle = opts.subtitle ?? 'read-only · 127.0.0.1 · personal'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibe run ${run_id}</title>
<style>
  body { margin: 0; background: #0b0f14; color: #d6deeb; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 8px 12px; background: #11161d; border-bottom: 1px solid #1f2730; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header .id { color: #7fdbca; }
  header .status { padding: 1px 8px; border-radius: 10px; background: #1f2730; }
  header .meta { color: #8a99a8; font-size: 11px; }
  header .conn { padding: 1px 8px; border-radius: 10px; font-size: 11px; background: #1f2730; color: #8a99a8; }
  header .conn.live { color: #0b0f14; background: #7fdbca; }
  header .conn.reconnecting { color: #0b0f14; background: #ecc48d; }
  header .conn.disconnected { color: #0b0f14; background: #ef6f6f; }
  header .conn.ended { color: #d6deeb; background: #2d3a45; }
  header .ro { margin-left: auto; color: #637777; font-size: 11px; }
  pre#pane { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<header>
  <span class="id">${run_id}</span>
  <span class="status" id="status">…</span>
  <span class="meta" id="node"></span>
  <span class="meta" id="source"></span>
  <span class="conn" id="conn"></span>
  <span class="meta" id="updated"></span>
  <span class="ro">${subtitle}</span>
</header>
<pre id="pane">connecting…</pre>
<script>
  // Read-only poller. Pure fetch — no input channel, no live socket. Values are
  // written via textContent only, so streamed output can never inject markup.
  const pane = document.getElementById('pane');
  const el = (id) => document.getElementById(id);
  const statusEl = el('status'), nodeEl = el('node'), sourceEl = el('source'),
        connEl = el('conn'), updatedEl = el('updated');
  let lastTs = null, stopped = false, errDelay = 1000;
  const POLL_MS = 1000, MAX_ERR_MS = 8000;

  function setConn(state) { connEl.textContent = state; connEl.className = 'conn ' + state; }
  function rel(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
    return 'updated ' + s + 's ago';
  }
  // Tick the relative time every second even between polls.
  setInterval(() => { if (lastTs) updatedEl.textContent = rel(lastTs); }, 1000);

  async function loop() {
    if (stopped) return;
    let delay = POLL_MS;
    try {
      const res = await fetch('/api/pane', { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const d = await res.json();
      statusEl.textContent = d.status || '…';
      nodeEl.textContent = d.node_id ? ('node ' + d.node_id) : '';
      sourceEl.textContent = d.source ? ('source ' + d.source) : '';
      lastTs = d.ts; updatedEl.textContent = rel(lastTs);
      if (d.content) pane.textContent = d.content;
      // Connection chip: prefer the server's stream state; fall back to ended/live.
      if (d.ended) setConn(d.stream === 'disconnected' ? 'disconnected' : 'ended');
      else setConn(d.stream || 'live');
      errDelay = POLL_MS;            // recovered
      if (d.ended) { stopped = true; return; }   // run finished — stop polling
    } catch (e) {
      // Keep-alive: a transient fetch failure must not kill the viewer. Show
      // reconnecting and retry with capped backoff instead of giving up.
      setConn('reconnecting');
      errDelay = Math.min(errDelay * 2, MAX_ERR_MS);
      delay = errDelay;
    }
    if (!stopped) setTimeout(loop, delay);
  }
  loop();
</script>
</body>
</html>`
}

export interface ViewerServer {
  host: string
  port: number
  url: string
  close(): Promise<void>
}

export interface ViewerOptions {
  run_id: string
  tmux_session: string
  host: string
  port: number
}

/**
 * Start the read-only HTTP viewer. Resolves once the socket is listening.
 * Only GET / and GET /api/pane are served; any other method/path is rejected
 * (405 / 404) — there is no input channel and no shell exposure.
 */
export function startViewerServer(opts: ViewerOptions): Promise<ViewerServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' })
      res.end('method not allowed (viewer is read-only)\n')
      return
    }
    const url = (req.url ?? '/').split('?')[0]
    if (url === '/api/pane') {
      const snap = capturePane(opts.run_id, opts.tmux_session)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(snap))
      return
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(viewerHtml(opts.run_id))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : opts.port
      const host = opts.host
      resolve({
        host,
        port,
        url: `http://${host}:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}
