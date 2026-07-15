/**
 * RELAY-PROTOCOL end-to-end reconnect acceptance for run_event_replay_v1. A raw
 * WebSocket protocol client (the allowed temporary harness) exercises the REAL
 * run_stream_subscribe request/response serialization: it consumes NODE source
 * events through N, disconnects, lets the run advance while detached, reconnects
 * with `after_sequence: N`, and verifies journaled replay metadata + replay→live
 * over the wire (no gap/dup, terminal once, final cursor == journal last_sequence).
 * In-process relay + spawned mock daemon + temp journal + PLAINTEXT mock run.
 * Never touches production. Skips if the daemon can't register.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import { startRelayServer } from '../src/relay/server.js'
import { remoteRunStart } from '../src/relay/client.js'
import { openNodeJournal } from '../src/node-journal/sqlite-journal.js'
import { RUN_EVENT_REPLAY_CAPABILITY } from '../src/node-journal/contract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const RTOKEN = `pr-relay-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'pr-journal-node'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const iso = () => new Date().toISOString()

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => { const p = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; p.stdout!.on('data', (d: Buffer) => { out += d.toString() }); p.on('close', () => resolve(out)); setTimeout(() => { p.kill('SIGKILL'); resolve(out) }, timeoutMs) })
}

/** A raw protocol client: connects, subscribes (optionally with after_sequence),
 *  and collects run_event / run_replay_meta / run_replay_event messages. */
interface Collected { events: Array<{ seq: number; type: string }>; meta?: any }
/** Subscribe over the raw protocol; resolve when `until(collected)` is true or at
 *  `maxMs` (whichever first), then close. Robust to load (condition-based). */
function protocolStream(relayPort: number, runId: string, afterSequence: number | undefined, maxMs: number, until?: (c: Collected) => boolean): Promise<Collected> {
  return new Promise((resolve) => {
    const out: Collected = { events: [] }
    let done = false
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}?token=${RTOKEN}`)
    const finish = () => { if (done) return; done = true; try { ws.close() } catch { /* */ } resolve(out) }
    ws.on('open', () => {
      const sub: Record<string, unknown> = { version: 1, kind: 'plaintext', from: 'cli', to: 'relay', ts: iso(), type: 'run_stream_subscribe', run_id: runId }
      if (afterSequence !== undefined) sub.after_sequence = afterSequence
      ws.send(JSON.stringify(sub))
    })
    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'run_event' && m.run_id === runId) out.events.push({ seq: m.source_sequence, type: m.event?.type })
      else if (m.type === 'run_replay_meta' && m.run_id === runId) out.meta = m.metadata
      else if (m.type === 'run_replay_event' && m.run_id === runId) out.events.push({ seq: m.source_sequence, type: m.event?.type })
      if (until && until(out)) finish()
    })
    ws.on('error', () => { /* */ })
    setTimeout(finish, maxMs)
  })
}

test('protocol reconnect: after_sequence replay over the real relay stream (no gap/dup, terminal once)', async (t) => {
  const relay = await startRelayServer({ port: 0, token: RTOKEN })
  const relayUrl = `ws://127.0.0.1:${relay.port}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'))
  const nodeVibeDir = path.join(root, 'node')
  const tokenFile = path.join(root, 'tok'); fs.writeFileSync(tokenFile, RTOKEN + '\n', { mode: 0o600 })
  const promptFile = path.join(root, 'prompt.txt'); fs.writeFileSync(promptFile, 'protocol replay', { mode: 0o600 })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: nodeVibeDir, VIBE_RELAY_TOKEN: RTOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock', VIBE_MOCK_RUN_MS: '7000' }, stdio: 'ignore',
  })
  let up = false; const deadline = Date.now() + 9000
  while (Date.now() < deadline && !up) { await delay(300); try { if (JSON.parse((await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env })).trim()).some((n: { node_id: string }) => n.node_id === NODE_ID)) up = true } catch { /* */ } }
  const journalPath = path.join(nodeVibeDir, 'node-run-journal.sqlite')
  const cleanup = async (): Promise<void> => { if (!daemon.killed) daemon.kill('SIGKILL'); await delay(200); try { await relay.close() } catch { /* */ } }
  if (!up) { await cleanup(); t.skip('mock node daemon did not register'); return }

  try {
    // PLAINTEXT remote run (no encryption key) so the protocol replay path is exercised in the clear.
    const rec = await remoteRunStart(relayUrl, RTOKEN, NODE_ID, { agent: 'mock', promptFile })
    const runId = rec.run_id

    // (backward compat) an OLD-style subscribe with NO after_sequence receives the
    // live stream; take an early event as N (guaranteed to have successors) and
    // disconnect. Condition-based (robust under load).
    const first = await protocolStream(relay.port, runId, undefined, 6000, (c) => c.events.length >= 1)
    assert.ok(first.events.length >= 1, 'live stream delivered events with source_sequence')
    assert.ok(first.events.every((e) => Number.isInteger(e.seq)), 'each delivered event carried a NODE source_sequence')
    const N = first.events[0].seq

    // Detached: the run keeps producing events and the journal advances past N.
    let advanced = false
    for (let i = 0; i < 40 && !advanced; i++) { const jj = openNodeJournal({ path: journalPath }); advanced = (jj.getRun(runId)?.last_sequence ?? -1) > N; jj.close(); if (!advanced) await delay(150) }
    assert.ok(advanced, 'journal last_sequence advanced while no consumer was attached')

    // Reconnect through the relay protocol with after_sequence=N; collect until the
    // journal is terminal AND we have delivered its last_sequence (or a long cap).
    const terminalSeq = await (async () => { for (let i = 0; i < 80; i++) { const jj = openNodeJournal({ path: journalPath }); const m = jj.getRun(runId); jj.close(); if (m?.terminal_event_recorded) return m.last_sequence; await delay(150) } return -1 })()
    const resumed = await protocolStream(relay.port, runId, N, 9000, (c) => terminalSeq >= 0 && c.events.some((e) => e.seq === terminalSeq))
    assert.ok(resumed.meta, 'run_replay_meta was delivered over the protocol')
    assert.equal(resumed.meta.replay_capability, RUN_EVENT_REPLAY_CAPABILITY)
    assert.equal(typeof resumed.meta.earliest_retained_sequence, 'number')
    assert.equal(typeof resumed.meta.latest_sequence, 'number')
    assert.equal(typeof resumed.meta.history_complete_for_request, 'boolean')
    assert.equal(resumed.meta.history_complete_for_request, true)
    const seqs = resumed.events.map((e) => e.seq)
    assert.equal(seqs[0], N + 1, 'first replayed event is N+1')
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] === seqs[i - 1] + 1, `strictly increasing, contiguous at ${i}: ${seqs.join(',')}`)
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicate boundary event')
    // terminal exactly once + final cursor == journal last_sequence
    let j = openNodeJournal({ path: journalPath })
    const meta = j.getRun(runId)!
    assert.equal(meta.terminal_event_recorded, true, 'terminal recorded once')
    assert.equal(seqs[seqs.length - 1], meta.last_sequence, 'final delivered source cursor == journal last_sequence')
    // disconnect did not cancel/pause capture: the run reached terminal
    assert.ok(['completed', 'failed', 'stopped', 'cancelled'].includes(meta.status), 'backend capture continued to a terminal status')

    // ── truncation protocol: prune the prefix, reconnect older-than-retained ──
    j.pruneRunEvents(runId, 2) // keep newest 2; earliest_retained_sequence advances
    const earliest = j.getRun(runId)!.earliest_retained_sequence
    const retainedSeqs = j.readEvents(runId, -1).map((e) => e.sequence)
    j.close()
    const truncated = await protocolStream(relay.port, runId, -1, 1500) // request from 0, but prefix pruned
    assert.ok(truncated.meta, 'run_replay_meta delivered for the truncated request')
    assert.equal(truncated.meta.history_complete_for_request, false, 'protocol reports history incomplete')
    assert.equal(truncated.meta.earliest_retained_sequence, earliest, 'earliest_retained_sequence reported over protocol')
    assert.deepEqual(truncated.events.map((e) => e.seq), retainedSeqs, 'retained suffix replayed WITHOUT renumbering; no fabricated prefix')
  } finally {
    await cleanup()
  }
})
