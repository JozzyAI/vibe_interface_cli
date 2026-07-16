/**
 * Workflow event SSE — replay persisted workflow events past a cursor, then poll
 * the DURABLE event log for new committed events and publish them live. The
 * durable log is the single source of truth, so replay→live has no gap and no
 * boundary duplicate (each poll fetches `sequence > cursor`). A slow/dead socket
 * is detected on write and stops that stream only; Workflow Runtime correctness
 * NEVER depends on any subscriber. A client disconnect never cancels the workflow.
 *
 * Workflow event sequences start at 0 and are DISTINCT from task event ids and
 * Node source sequences — never interchange them.
 */
import type http from 'http'
import type { ControlStore } from '../control/store.js'
import type { WorkflowEventRecord } from '../control/records.js'

const POLL_MS = 200
const HEARTBEAT_MS = 15000
/** End-of-forward-progress workflow events (v1 does not auto-resume `blocked`). */
const STREAM_END_EVENTS = new Set(['workflow.completed', 'workflow.failed', 'workflow.cancelled', 'workflow.blocked'])
const WF_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked'])

/** Parse a Last-Event-ID cursor: a non-negative integer, else -1 (replay from 0). */
export function parseWorkflowCursor(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header
  return typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : -1
}

function frame(e: WorkflowEventRecord): string {
  const data = { workflow_id: e.workflow_id, seq: e.sequence, type: e.event_type, ts: e.ts, ...(e.step_execution_id ? { step_execution_id: e.step_execution_id } : {}), payload: e.payload }
  return `id: ${e.sequence}\nevent: ${e.event_type}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Stream a workflow's events as SSE. The caller MUST have already verified the
 * workflow exists (404 otherwise). Non-blocking: sets up bounded pollers and
 * returns; cleanup runs on disconnect or on the end-of-progress event.
 */
export function streamWorkflowEvents(req: http.IncomingMessage, res: http.ServerResponse, store: ControlStore, workflowId: string, registry?: Set<http.ServerResponse>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.write(': connected\n\n')
  registry?.add(res)

  let cursor = parseWorkflowCursor(req.headers['last-event-id'])
  let closed = false
  let warnedTruncation = false

  const cleanup = (): void => { if (closed) return; closed = true; clearInterval(poll); clearInterval(hb); registry?.delete(res); try { res.end() } catch { /* already closed */ } }

  const tick = async (): Promise<void> => {
    if (closed) return
    let events: WorkflowEventRecord[]
    let rec
    try { events = await store.listWorkflowEvents(workflowId, cursor); rec = await store.getWorkflow(workflowId) } catch { return }
    if (!warnedTruncation && rec && rec.earliest_retained_sequence > 0 && cursor + 1 < rec.earliest_retained_sequence) {
      warnedTruncation = true
      try { res.write(`: warning: workflow event history is truncated (earliest_retained_sequence=${rec.earliest_retained_sequence})\n\n`) } catch { cleanup(); return }
    }
    let endReached = false
    for (const e of events) {
      try { res.write(frame(e)) } catch { cleanup(); return }
      cursor = e.sequence
      if (STREAM_END_EVENTS.has(e.event_type)) endReached = true
    }
    // Close once the end-of-progress event has been delivered AND the cursor has
    // caught up to the persisted high-water mark (no event left un-replayed).
    if ((endReached || (rec && WF_TERMINAL.has(rec.status))) && rec && cursor >= rec.last_event_sequence) cleanup()
  }

  const poll = setInterval(() => { void tick() }, POLL_MS)
  const hb = setInterval(() => { if (!closed) { try { res.write(': keep-alive\n\n') } catch { cleanup() } } }, HEARTBEAT_MS)
  poll.unref?.(); hb.unref?.()
  req.on('close', cleanup) // disconnect prunes the subscriber; never cancels the workflow
  void tick() // immediate first replay
}
