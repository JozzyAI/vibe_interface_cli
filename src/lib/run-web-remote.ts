/**
 * Personal, local, read-only web viewer for a REMOTE Vibe run (one owned by
 * another node, reached over the relay).
 *
 * Design constraints (mirrors the local viewer in run-web.ts):
 *   - Private by default: binds 127.0.0.1; no public bind without --allow-public-bind.
 *   - Read-only: only GET routes; never sends input to the run; no raw shell; no
 *     share links. Stop stays a CLI operation, not a browser control.
 *   - Reuses the existing relay APIs: one background `remoteStream` subscription
 *     fills an in-memory buffer that the browser polls via /api/pane. No new
 *     transport, decrypt, or reconnect logic.
 *   - Defence in depth: every event line is run through redact() before it can
 *     reach the browser, even though node-side events are already redacted.
 */
import http from 'http'
import { redact } from '../redact.js'
import { isTerminal, TERMINAL_STATUSES, type RunEvent, type RunStatus } from '../types.js'
import { renderEventLine, viewerHtml } from './run-web.js'

export interface RemotePaneSnapshot {
  run_id: string
  node_id: string
  status: RunStatus | 'unknown'
  /** Redacted, newline-joined event log forwarded from the owning node. */
  content: string
  /** Always 'events' for the remote viewer (it has no local tmux pane). */
  source: 'events'
  /** True once a terminal event has been observed. */
  ended: boolean
  ts: string
}

/**
 * Accumulates the events streamed from the owning node into a bounded, redacted
 * log plus the latest status / ended flag. `push` is fed by remoteStream's
 * onRunEvent hook; `snapshot` is what the HTTP viewer serves.
 */
export class RemoteRunBuffer {
  private lines: string[] = []
  private status: RunStatus | 'unknown'
  private terminated = false
  private readonly limit: number

  constructor(
    readonly run_id: string,
    readonly node_id: string,
    initialStatus: RunStatus | 'unknown' = 'unknown',
    limit = 400,
  ) {
    this.status = initialStatus
    this.limit = limit
    // A run that was already finished when the viewer attached gets no further
    // terminal event over the live stream, so seed `ended` from its status.
    this.terminated = initialStatus !== 'unknown' && TERMINAL_STATUSES.includes(initialStatus)
  }

  /** Ingest one decoded run event. Updates status, content, and ended-state. */
  push(event: RunEvent): void {
    if (event.type === 'status') this.status = event.status
    // redact() again as defence in depth, then bound the retained history.
    this.lines.push(redact(renderEventLine(event)))
    if (this.lines.length > this.limit) this.lines = this.lines.slice(-this.limit)
    if (isTerminal(event)) this.terminated = true
  }

  /** Mark the stream ended without a terminal event (e.g. node went away). */
  markEnded(): void { this.terminated = true }

  snapshot(): RemotePaneSnapshot {
    return {
      run_id: this.run_id,
      node_id: this.node_id,
      status: this.status,
      content: this.lines.join('\n'),
      source: 'events',
      ended: this.terminated,
      ts: new Date().toISOString(),
    }
  }
}

export interface RemoteStatusErrorMapping {
  code: 'run_not_found' | 'node_offline' | 'auth_token_error' | 'viewer_remote_error'
  message: string
}

/**
 * Map a `remoteRunStatus` rejection into a structured viewer error. That helper
 * rejects with an Error whose message is prefixed by the relay's code
 * (`"run_not_found: ..."`, `"node_offline: ..."`), so we key off that prefix and
 * fall back to a token/connection bucket for everything else.
 */
export function mapRemoteStatusError(err: unknown): RemoteStatusErrorMapping {
  const message = err instanceof Error ? err.message : String(err)
  const code = message.split(':', 1)[0]?.trim()
  if (code === 'run_not_found') return { code: 'run_not_found', message }
  if (code === 'node_offline' || code === 'node_not_found') return { code: 'node_offline', message }
  if (/token|auth|unauthor/i.test(message)) return { code: 'auth_token_error', message }
  return { code: 'viewer_remote_error', message }
}

export interface RemoteViewerServer {
  host: string
  port: number
  url: string
  close(): Promise<void>
}

export interface RemoteViewerOptions {
  run_id: string
  node_id: string
  host: string
  port: number
  buffer: RemoteRunBuffer
}

/**
 * Start the read-only HTTP viewer over a RemoteRunBuffer. Only GET / and
 * GET /api/pane are served; any other method is 405 and any other path 404 —
 * there is no input channel and no shell exposure.
 */
export function startRemoteViewerServer(opts: RemoteViewerOptions): Promise<RemoteViewerServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' })
      res.end('method not allowed (viewer is read-only)\n')
      return
    }
    const url = (req.url ?? '/').split('?')[0]
    if (url === '/api/pane') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(opts.buffer.snapshot()))
      return
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(viewerHtml(opts.run_id, { subtitle: `read-only · remote · ${opts.node_id}` }))
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
      resolve({
        host: opts.host,
        port,
        url: `http://${opts.host}:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}
