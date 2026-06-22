/**
 * remoteStream robustness — fixes the JOZ-37 false-stall class.
 *
 * Background: the Mac-side Vibe relay subscriber (`vibe symphony stream`) used to
 * end the stream on ANY WebSocket close/error WITHOUT emitting a terminal event
 * (`ws.on('close', resolve)` / `ws.on('error', reject)`), and an unhandled
 * `'error'` (EPIPE) on stdout crashed the process mid-stream. Symphony then saw
 * pure silence and its 300s inactivity watchdog fired a false "stalled for
 * 300578ms without activity" — while the node's agent was still working.
 *
 * These tests pin the new behaviour:
 *  - a clean terminal event still resolves the stream (back-compat),
 *  - an unexpected close before terminal reconnects + re-subscribes,
 *  - when the stream truly can't be re-established it emits an EXPLICIT terminal
 *    (error code=stream_disconnected + status:failed) instead of silence,
 *  - a relay_error / 401 is fatal (no reconnect) but still surfaces a terminal,
 *  - an abort stops the loop cleanly without a synthetic terminal,
 *  - a stdout error guard is attached while streaming (prevents the EPIPE crash),
 *  - the relay token is never written to stderr.
 *
 * The cases share process.stdout (remoteStream writes JSONL there), so they run
 * as SEQUENTIAL awaited subtests — never overlapping the stdout capture.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import { remoteStream, type StreamConnEvent } from '../src/relay/client.js'

const TEST_TOKEN = `tok-stream-${Date.now()}`

type SubHandler = (ws: WebSocket, runId: string, connIndex: number) => void

interface FakeRelay {
  port: number
  connections: number
  close: () => Promise<void>
}

/** Minimal relay that acks run_stream_subscribe and hands the socket to `handler`. */
async function startFakeRelay(handler: SubHandler): Promise<FakeRelay> {
  const wss = new WebSocketServer({ port: 0 })
  const state = { connections: 0 }
  wss.on('connection', (ws) => {
    const idx = state.connections++
    ws.on('error', () => { /* ignore — peer resets during reconnect tests */ })
    ws.on('message', (raw) => {
      let msg: { type?: string; run_id?: string }
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type === 'run_stream_subscribe') {
        ws.send(JSON.stringify({
          version: 1, kind: 'plaintext', from: 'relay', to: 'cli', ts: new Date().toISOString(),
          type: 'run_stream_subscribe_ack', run_id: msg.run_id, ok: true,
        }))
        handler(ws, msg.run_id as string, idx)
      }
    })
  })
  await once(wss, 'listening')
  const port = (wss.address() as { port: number }).port
  return {
    port,
    get connections() { return state.connections },
    close: () => new Promise<void>((r) => wss.close(() => r())),
  }
}

function sendEvent(ws: WebSocket, runId: string, event: Record<string, unknown>): void {
  ws.send(JSON.stringify({
    version: 1, kind: 'plaintext', from: 'relay', to: 'cli', ts: new Date().toISOString(),
    type: 'run_event', run_id: runId, event,
  }))
}

/**
 * Capture process.stdout/stderr writes for the duration of `fn` (one at a time).
 * stdout PASSES THROUGH to the real writer so the node:test TAP reporter (which
 * also writes to stdout) is not swallowed; stderr is recorded only (TAP does not
 * use it) to keep reconnect diagnostics out of the test output.
 */
async function captureIO(fn: () => Promise<void>): Promise<{ out: string[]; err: string }> {
  const out: string[] = []
  let err = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  ;(process.stdout as unknown as { write: unknown }).write = (chunk: string | Buffer, ...args: unknown[]) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString()
    out.push(...s.split('\n').filter(Boolean))
    return (origOut as (...a: unknown[]) => boolean)(chunk, ...args)
  }
  ;(process.stderr as unknown as { write: unknown }).write = (chunk: string | Buffer) => {
    err += typeof chunk === 'string' ? chunk : chunk.toString()
    return true
  }
  try { await fn() } finally {
    ;(process.stdout as unknown as { write: unknown }).write = origOut
    ;(process.stderr as unknown as { write: unknown }).write = origErr
  }
  return { out, err }
}

/** Extract only the JSONL run events from captured stdout (ignores TAP reporter lines). */
function parseEvents(out: string[]): Array<Record<string, unknown>> {
  return out.flatMap((l) => {
    if (!l.startsWith('{')) return []
    try { const e = JSON.parse(l); return e && typeof e === 'object' ? [e as Record<string, unknown>] : [] }
    catch { return [] }
  })
}

const RID = 'run_stream_test'
const urlFor = (port: number): string => `ws://127.0.0.1:${port}`
const fastBackoff = { backoffBaseMs: 10, backoffCapMs: 40 }

test('remoteStream robustness', async (t) => {
  // ── 1. back-compat: a terminal event resolves the stream ───────────────────
  await t.test('terminal status event resolves and is printed (back-compat)', async () => {
    const relay = await startFakeRelay((ws, runId) => {
      sendEvent(ws, runId, { run_id: runId, ts: new Date().toISOString(), type: 'log', stream: 'stdout', message: 'working' })
      sendEvent(ws, runId, { run_id: runId, ts: new Date().toISOString(), type: 'status', status: 'completed' })
    })
    try {
      const { out } = await captureIO(() => remoteStream(urlFor(relay.port), TEST_TOKEN, RID, fastBackoff))
      const events = parseEvents(out)
      assert.ok(events.some((e) => e.type === 'log'), 'log event forwarded')
      assert.ok(events.some((e) => e.type === 'status' && e.status === 'completed'), 'completed event forwarded')
      assert.equal(relay.connections, 1, 'no reconnect on a clean terminal')
    } finally { await relay.close() }
  })

  // ── 2. unexpected close before terminal → reconnect + resubscribe ──────────
  await t.test('reconnects and re-subscribes after an unexpected close', async () => {
    const relay = await startFakeRelay((ws, runId, idx) => {
      if (idx === 0) {
        setTimeout(() => { try { ws.close() } catch { /* */ } }, 10) // die after subscribe, no terminal
      } else {
        sendEvent(ws, runId, { run_id: runId, ts: new Date().toISOString(), type: 'status', status: 'completed' })
      }
    })
    const evs: StreamConnEvent[] = []
    try {
      const { out } = await captureIO(() => remoteStream(urlFor(relay.port), TEST_TOKEN, RID, {
        ...fastBackoff, onEvent: (e) => evs.push(e),
      }))
      const events = parseEvents(out)
      assert.ok(events.some((e) => e.type === 'status' && e.status === 'completed'), 'terminal received after reconnect')
      assert.ok(relay.connections >= 2, 'subscriber reconnected')
      assert.ok(evs.includes('reconnect_scheduled'), 'reconnect was scheduled')
      assert.ok(evs.filter((e) => e === 'subscribed').length >= 2, 're-subscribed on reconnect')
      assert.ok(!out.some((l) => l.includes('stream_disconnected')), 'no give-up terminal on successful reconnect')
    } finally { await relay.close() }
  })

  // ── 3. give up after maxReconnects → explicit structured terminal ──────────
  await t.test('emits explicit terminal (error + status:failed) when it cannot reconnect', async () => {
    const relay = await startFakeRelay((ws) => {
      setTimeout(() => { try { ws.close() } catch { /* */ } }, 5) // always drop after subscribe
    })
    const evs: StreamConnEvent[] = []
    try {
      const { out } = await captureIO(() => remoteStream(urlFor(relay.port), TEST_TOKEN, RID, {
        ...fastBackoff, maxReconnects: 2, onEvent: (e) => evs.push(e),
      }))
      const events = parseEvents(out)
      const errEv = events.find((e) => e.type === 'error')
      assert.ok(errEv, 'an error event was emitted')
      assert.equal(errEv.code, 'stream_disconnected', 'error carries stream_disconnected code')
      assert.ok(events.find((e) => e.type === 'status' && e.status === 'failed'), 'explicit terminal status:failed emitted (not silent)')
      assert.ok(evs.includes('gave_up'), 'gave_up lifecycle emitted')
      assert.equal(relay.connections, 3, '1 initial + 2 reconnect attempts')
    } finally { await relay.close() }
  })

  // ── 4. relay_error is fatal (no reconnect) but still surfaces a terminal ────
  await t.test('relay_error is fatal — no reconnect, explicit terminal', async () => {
    const relay = await startFakeRelay((ws) => {
      ws.send(JSON.stringify({
        version: 1, kind: 'plaintext', from: 'relay', to: 'cli', ts: new Date().toISOString(),
        type: 'relay_error', code: 'forbidden', message: 'nope',
      }))
    })
    try {
      const { out } = await captureIO(() => remoteStream(urlFor(relay.port), TEST_TOKEN, RID, { ...fastBackoff, maxReconnects: 5 }))
      const events = parseEvents(out)
      assert.ok(events.some((e) => e.type === 'status' && e.status === 'failed'), 'explicit terminal on fatal')
      assert.equal(relay.connections, 1, 'fatal error does NOT trigger reconnect')
    } finally { await relay.close() }
  })

  // ── 5. abort stops the loop cleanly with no synthetic terminal ─────────────
  await t.test('aborting the control signal stops cleanly without a terminal', async () => {
    const relay = await startFakeRelay((ws) => {
      setTimeout(() => { try { ws.close() } catch { /* */ } }, 5)
    })
    const ac = new AbortController()
    try {
      const { out } = await captureIO(async () => {
        const p = remoteStream(urlFor(relay.port), TEST_TOKEN, RID, { ...fastBackoff, maxReconnects: 50, signal: ac.signal })
        setTimeout(() => ac.abort(), 60)
        await p
      })
      assert.ok(!out.some((l) => l.includes('stream_disconnected')), 'no give-up terminal when aborted')
      assert.ok(!out.some((l) => { try { return JSON.parse(l).type === 'status' } catch { return false } }),
        'no synthetic status emitted on abort')
    } finally { await relay.close() }
  })

  // ── 6. stdout EPIPE guard installed while streaming, removed after ──────────
  await t.test('installs a stdout error guard while streaming, removes it after (no leak)', async () => {
    const before = process.stdout.listenerCount('error')
    let during = -1
    const relay = await startFakeRelay((ws) => {
      setTimeout(() => { try { ws.close() } catch { /* */ } }, 5)
    })
    try {
      await remoteStream(urlFor(relay.port), TEST_TOKEN, RID, {
        ...fastBackoff, maxReconnects: 2,
        onEvent: (e) => { if (e === 'reconnect_scheduled' && during < 0) during = process.stdout.listenerCount('error') },
      })
      assert.ok(during > before, 'a stdout error guard is attached while streaming (prevents EPIPE crash)')
      assert.equal(process.stdout.listenerCount('error'), before, 'guard removed after stream ends (no listener leak)')
    } finally { await relay.close() }
  })

  // ── 7. the relay token never appears in stderr diagnostics ──────────────────
  await t.test('never logs the relay token to stderr', async () => {
    const relay = await startFakeRelay((ws) => {
      setTimeout(() => { try { ws.close() } catch { /* */ } }, 5)
    })
    try {
      const { err } = await captureIO(() => remoteStream(urlFor(relay.port), TEST_TOKEN, RID, { ...fastBackoff, maxReconnects: 1 }))
      assert.ok(err.length > 0, 'reconnect produced stderr diagnostics')
      assert.ok(!err.includes(TEST_TOKEN), 'token must not appear in stderr')
    } finally { await relay.close() }
  })
})
