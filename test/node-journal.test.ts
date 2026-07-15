/**
 * Node run event journal — storage, capture-independence, race-free replay→live,
 * backpressure, retention, and protocol/capability. Isolated TEMP databases only
 * (never the default node journal). The NODE source-sequence domain here is
 * distinct from the Gateway TaskEvent sequence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { openNodeJournal, runJournalMigrations, LATEST_JOURNAL_SCHEMA_VERSION } from '../src/node-journal/sqlite-journal.js'
import { JournalError, RUN_EVENT_REPLAY_CAPABILITY, JOURNAL_LIMITS } from '../src/node-journal/contract.js'
import type { NodeRunEvent } from '../src/node-journal/contract.js'

const tmpDb = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'njr-')), 'node-run-journal.sqlite')
const iso = (): string => new Date().toISOString()
const ev = (over: Record<string, unknown> = {}) => ({ type: 'log', timestamp: iso(), payload: { line: 'x' }, ...over })
const jcode = (fn: () => unknown): string => { try { fn(); return '(no error)' } catch (e) { return e instanceof JournalError ? e.code : `(${(e as Error).name})` } }
const tick = () => new Promise((r) => setImmediate(r))

// ── storage ──────────────────────────────────────────────────────────────────

test('create/reopen preserves run metadata + events; first seq 0, contiguous', async () => {
  const p = tmpDb()
  let j = openNodeJournal({ path: p })
  const e0 = j.append('run_1', ev()); const e1 = j.append('run_1', ev({ type: 'status', status: 'running' }))
  assert.equal(e0.sequence, 0); assert.equal(e1.sequence, 1)
  j.close()
  j = openNodeJournal({ path: p })
  assert.equal(j.getRun('run_1')?.last_sequence, 1)
  assert.deepEqual(j.readEvents('run_1', -1).map((e) => e.sequence), [0, 1])
  j.close()
})

test('WAL + foreign_keys + busy_timeout; schema version; clean repeated close', () => {
  const j = openNodeJournal({ path: tmpDb() })
  const h = j.healthCheck()
  assert.equal(h.journal_mode, 'wal'); assert.equal(h.foreign_keys, true); assert.ok(h.busy_timeout > 0); assert.equal(h.schema_version, LATEST_JOURNAL_SCHEMA_VERSION)
  j.close(); j.close() // repeatable
  assert.equal(jcode(() => j.getRun('run_1')), 'closed')
})

test('appendAt: idempotent duplicate, conflict, gap; terminal exactly once; no regress', () => {
  const j = openNodeJournal({ path: tmpDb() })
  const e0 = ev() // fixed object so an exact re-append is byte-identical
  const a = j.appendAt('r', 0, e0); assert.equal(a.duplicate, false)
  assert.equal(j.appendAt('r', 0, e0).duplicate, true) // exact duplicate → idempotent
  assert.equal(jcode(() => j.appendAt('r', 0, { ...e0, payload: { line: 'y' } })), 'event_conflict') // same slot, different payload
  assert.equal(jcode(() => j.appendAt('r', 5, ev())), 'event_gap')
  j.append('r', ev({ type: 'status', status: 'completed', terminal: true })) // seq 1, terminal
  assert.equal(j.getRun('r')?.terminal_event_recorded, true)
  assert.equal(jcode(() => j.append('r', ev())), 'invalid_transition') // no events after terminal
  assert.equal(jcode(() => j.markStatus('r', 'running')), 'invalid_transition') // terminal cannot regress
  j.close()
})

test('oversized payload + bad type + bad timestamp rejected', () => {
  const j = openNodeJournal({ path: tmpDb() })
  assert.equal(jcode(() => j.append('r', ev({ payload: { blob: 'x'.repeat(JOURNAL_LIMITS.event_payload_bytes + 10) } }))), 'too_large')
  assert.equal(jcode(() => j.append('r', ev({ type: 'not_a_real_type' }))), 'invalid_record')
  assert.equal(jcode(() => j.append('r', ev({ timestamp: 'nope' }))), 'invalid_record')
  j.close()
})

test('malformed persisted JSON is a corruption error on read', () => {
  const p = tmpDb(); const j = openNodeJournal({ path: p }); j.append('r', ev()); j.close()
  const raw = new Database(p); raw.prepare('UPDATE run_events SET payload_json = ? WHERE remote_run_id = ?').run('{bad', 'r'); raw.close()
  const j2 = openNodeJournal({ path: p })
  assert.equal(jcode(() => j2.readEvents('r', -1)), 'corruption'); j2.close()
})

test('symlinked journal path refused; 0600 where POSIX supported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'njr-sym-'))
  const real = path.join(dir, 'real.sqlite'); fs.writeFileSync(real, '')
  const link = path.join(dir, 'j.sqlite'); fs.symlinkSync(real, link)
  assert.throws(() => openNodeJournal({ path: link }), (e: unknown) => e instanceof JournalError && e.code === 'invalid_record')
  const p = tmpDb(); const j = openNodeJournal({ path: p }); j.append('r', ev())
  if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o077, 0)
  j.close()
})

test('migrations: idempotent, unknown-newer fails closed, failing migration rolls back', () => {
  const j = openNodeJournal({ path: tmpDb() }); assert.equal(j.migrate(), LATEST_JOURNAL_SCHEMA_VERSION); assert.equal(j.migrate(), LATEST_JOURNAL_SCHEMA_VERSION); j.close()
  const p = tmpDb(); const j2 = openNodeJournal({ path: p }); j2.close()
  const raw = new Database(p); raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(999, iso()); raw.close()
  assert.throws(() => openNodeJournal({ path: p }), (e: unknown) => e instanceof JournalError && e.code === 'unsupported_schema_version')
  // failing migration rolls back (no version recorded)
  const raw2 = new Database(tmpDb())
  raw2.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE runs (x INTEGER)')
  assert.throws(() => runJournalMigrations(raw2))
  assert.equal((raw2.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c, 0)
  raw2.close()
})

// ── capture independence + replay ────────────────────────────────────────────

test('events are journaled with NO subscriber; last_sequence advances', () => {
  const j = openNodeJournal({ path: tmpDb() })
  for (let i = 0; i < 5; i++) j.append('r', ev())
  assert.equal(j.getRun('r')?.last_sequence, 4) // capture independent of any subscriber
  j.close()
})

test('subscribe replays after_sequence then live-tails with no boundary gap/dup', async () => {
  const j = openNodeJournal({ path: tmpDb() })
  for (let i = 0; i < 3; i++) j.append('r', ev()) // seq 0,1,2 before any subscriber
  const seen: number[] = []
  const sub = j.subscribe('r', { afterSequence: -1, onEvent: (e) => seen.push(e.sequence) })
  assert.deepEqual(seen, [0, 1, 2], 'replay from 0')
  j.append('r', ev()); j.append('r', ev({ type: 'status', status: 'completed', terminal: true })) // live 3,4
  await tick()
  assert.deepEqual(seen, [0, 1, 2, 3, 4], 'replay then live, contiguous')
  assert.equal(new Set(seen).size, seen.length, 'no duplicate at boundary')
  sub.close(); j.close()
})

test('after_sequence=N returns strictly greater; no-event replay preserves cursor', async () => {
  const j = openNodeJournal({ path: tmpDb() })
  for (let i = 0; i < 3; i++) j.append('r', ev()) // 0,1,2
  const seen: number[] = []
  j.subscribe('r', { afterSequence: 2, onEvent: (e) => seen.push(e.sequence) }) // caught up
  assert.deepEqual(seen, []) // nothing to replay; cursor preserved
  const after1: number[] = []
  j.subscribe('r', { afterSequence: 1, onEvent: (e) => after1.push(e.sequence) })
  assert.deepEqual(after1, [2]) // strictly greater than 1
  j.close()
})

test('reconnect after a disconnect replays events emitted while detached; no gap/dup; terminal once', async () => {
  const j = openNodeJournal({ path: tmpDb() })
  const first: number[] = []
  const s1 = j.subscribe('r', { afterSequence: -1, onEvent: (e) => first.push(e.sequence) })
  j.append('r', ev()); j.append('r', ev()); await tick() // 0,1 delivered
  assert.deepEqual(first, [0, 1])
  s1.close() // disconnect; capture continues
  j.append('r', ev()); j.append('r', ev({ type: 'status', status: 'completed', terminal: true })) // 2,3 while detached
  assert.equal(j.getRun('r')?.last_sequence, 3)
  const resumed: number[] = []
  j.subscribe('r', { afterSequence: 1, onEvent: (e) => resumed.push(e.sequence) }) // resume after last consumed (1)
  await tick()
  assert.deepEqual(resumed, [2, 3], 'received N+1 onward, no gap/dup')
  assert.equal(j.getRun('r')?.terminal_event_recorded, true, 'terminal recorded exactly once')
  assert.equal(jcode(() => j.append('r', ev({ type: 'status', terminal: true }))), 'invalid_transition') // a second terminal is rejected
  j.close()
})

test('replay metadata reports capability, latest, and pruned-prefix truncation', () => {
  const j = openNodeJournal({ path: tmpDb() })
  for (let i = 0; i < 6; i++) j.append('r', ev({ type: 'status', status: i === 5 ? 'completed' : 'running', terminal: i === 5 })) // 0..5, terminal at 5
  j.pruneRunEvents('r', 2) // keep newest 2 (seq 4,5); earliest_retained_sequence → 4
  const meta = j.replayMetadata('r', -1)!
  assert.equal(meta.replay_capability, RUN_EVENT_REPLAY_CAPABILITY)
  assert.equal(meta.latest_sequence, 5); assert.equal(meta.terminal, true)
  assert.equal(meta.earliest_retained_sequence, 4)
  assert.equal(meta.history_complete_for_request, false) // requested from 0 but prefix pruned
  assert.equal(j.replayMetadata('r', 3)!.history_complete_for_request, true) // requesting from 4 is retained
  // retained sequences are NEVER renumbered
  assert.deepEqual(j.readEvents('r', -1).map((e) => e.sequence), [4, 5])
  j.close()
})

// ── backpressure + retention ─────────────────────────────────────────────────

test('slow subscriber overflows (bounded queue), is dropped, journal stays healthy', async () => {
  const j = openNodeJournal({ path: tmpDb() })
  let overflowed = false
  const sub = j.subscribe('r', { afterSequence: -1, maxQueue: 3, onEvent: () => { /* never drains synchronously */ }, onOverflow: () => { overflowed = true } })
  for (let i = 0; i < 20; i++) j.append('r', ev()) // synchronous burst exceeds the queue before the setImmediate drain
  assert.equal(overflowed, true); assert.equal(sub.overflowed, true)
  // journal is unaffected — every event is still durable, and a fresh subscriber replays them all
  assert.equal(j.getRun('r')?.last_sequence, 19)
  const seen: number[] = []
  j.subscribe('r', { afterSequence: -1, onEvent: (e) => seen.push(e.sequence) })
  assert.equal(seen.length, 20)
  j.close()
})

test('close aborts subscribers cleanly (no leaks)', async () => {
  const j = openNodeJournal({ path: tmpDb() })
  const sub = j.subscribe('r', { afterSequence: -1, onEvent: () => { /* */ } })
  j.append('r', ev())
  j.close()
  assert.equal(sub.closed, true)
})

test('retention prunes terminal runs by age; never active runs', () => {
  const j = openNodeJournal({ path: tmpDb() })
  j.append('active', ev())
  j.append('old', ev({ type: 'status', status: 'completed', terminal: true }))
  // backdate the terminal_at of the old run
  const raw = new Database(j.dbPath); raw.prepare("UPDATE runs SET terminal_at = '2000-01-01T00:00:00.000Z' WHERE remote_run_id = 'old'").run(); raw.close()
  const pruned = j.pruneTerminalRuns('2020-01-01T00:00:00.000Z')
  assert.equal(pruned.removed, 1)
  assert.equal(j.getRun('old'), null); assert.ok(j.getRun('active') !== null) // active never pruned
  j.close()
})
