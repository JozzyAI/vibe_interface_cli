/**
 * Telegram monitor — read-only status reporter tests.
 *
 * Covers: node status diff detection (new/online/offline/active_runs changes),
 * relay failure + recovery alerts, message formatting, secret redaction,
 * /status formatting, state persistence, and — critically — that no
 * write/control command is ever exposed to Telegram input.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import fs from 'fs'

import { diffNodes, diffRelay, diffRuns } from '../src/monitor/telegram/diff.js'
import {
  formatHelp,
  formatLinearStatus,
  formatNodeChange,
  formatNodesList,
  formatRelayChange,
  formatRunChange,
  formatRunsList,
  formatStatusSummary,
  formatSymphonyStatus,
} from '../src/monitor/telegram/format.js'
import { redactSecrets, relayHostname } from '../src/monitor/telegram/secrets.js'
import { emptyState, loadState, saveState, statePath } from '../src/monitor/telegram/state.js'
import { dispatchCommand, type CommandContext } from '../src/monitor/telegram/monitor.js'
import type { MonitorState, NodeSnapshot, RelaySnapshot, RunSnapshot } from '../src/monitor/telegram/types.js'

// ── fixtures ─────────────────────────────────────────────────────────────────

function node(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    node_id: 'node_test_0001',
    name: 'Test Node',
    status: 'online',
    agents: ['claude-code', 'mock'],
    active_runs: 0,
    last_seen: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    run_id: 'run_abcdef123456',
    status: 'running',
    node_id: 'node_test_0001',
    agent: 'claude-code',
    repo_url: 'https://github.com/example/repo.git',
    issue_id: 'JOZ-12',
    workspace_key: 'joz-12',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:05:00.000Z',
    approval_required: false,
    ...overrides,
  }
}

function relay(overrides: Partial<RelaySnapshot> = {}): RelaySnapshot {
  return { reachable: true, authOk: true, hostname: 'relay.example.com', last_success_at: '2026-01-01T00:00:00.000Z', ...overrides }
}

function emptyContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: emptyState(),
    relay: relay(),
    nodes: [],
    runs: [],
    symphony: null,
    linear: null,
    ...overrides,
  }
}

// ── node status diff detection ───────────────────────────────────────────────

test('diffNodes: no change when snapshot is identical', () => {
  const prev = { [node().node_id]: node() }
  const changes = diffNodes(prev, [node()])
  assert.deepEqual(changes, [])
})

test('diffNodes: new node produces a new_node change', () => {
  const changes = diffNodes({}, [node()])
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, 'new_node')
  assert.equal((changes[0] as { node: NodeSnapshot }).node.node_id, 'node_test_0001')
})

test('diffNodes: online -> offline produces a status_change with last_seen carried over', () => {
  const prev = { [node().node_id]: node({ status: 'online', last_seen: '2026-01-01T00:00:00.000Z' }) }
  const next = node({ status: 'offline', last_seen: '2026-01-01T00:00:00.000Z' })
  const changes = diffNodes(prev, [next])
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0], {
    kind: 'status_change',
    node_id: 'node_test_0001',
    name: 'Test Node',
    from: 'online',
    to: 'offline',
    last_seen: '2026-01-01T00:00:00.000Z',
  })
})

test('diffNodes: offline -> online produces a status_change to online', () => {
  const prev = { [node().node_id]: node({ status: 'offline' }) }
  const next = node({ status: 'online', last_seen: '2026-02-01T00:00:00.000Z' })
  const changes = diffNodes(prev, [next])
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0], {
    kind: 'status_change',
    node_id: 'node_test_0001',
    name: 'Test Node',
    from: 'offline',
    to: 'online',
    last_seen: '2026-02-01T00:00:00.000Z',
  })
})

test('diffNodes: active_runs change is detected independently of status', () => {
  const prev = { [node().node_id]: node({ active_runs: 1 }) }
  const next = node({ active_runs: 3 })
  const changes = diffNodes(prev, [next])
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0], {
    kind: 'active_runs_change',
    node_id: 'node_test_0001',
    name: 'Test Node',
    from: 1,
    to: 3,
  })
})

test('diffNodes: agent list change is detected', () => {
  const prev = { [node().node_id]: node({ agents: ['mock'] }) }
  const next = node({ agents: ['claude-code', 'mock'] })
  const changes = diffNodes(prev, [next])
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, 'agents_change')
})

test('diffNodes: multiple simultaneous changes are all reported', () => {
  const prev = { [node().node_id]: node({ status: 'online', active_runs: 0 }) }
  const next = node({ status: 'offline', active_runs: 2 })
  const changes = diffNodes(prev, [next])
  assert.equal(changes.length, 2)
  assert.deepEqual(new Set(changes.map((c) => c.kind)), new Set(['status_change', 'active_runs_change']))
})

// ── new node alert ───────────────────────────────────────────────────────────

test('formatNodeChange: new_node alert names the node and shows agents', () => {
  const text = formatNodeChange({ kind: 'new_node', node: node() })
  assert.match(text, /New node registered/)
  assert.match(text, /Test Node/)
  assert.match(text, /node_test_00/)
  assert.match(text, /claude-code, mock/)
  assert.match(text, /^🟢/)
})

// ── online/offline alerts ────────────────────────────────────────────────────

test('formatNodeChange: offline alert includes last_seen and offline emoji', () => {
  const text = formatNodeChange({
    kind: 'status_change',
    node_id: 'node_test_0001',
    name: 'Test Node',
    from: 'online',
    to: 'offline',
    last_seen: '2026-01-01T00:00:00.000Z',
  })
  assert.match(text, /^🔴/)
  assert.match(text, /Node offline/)
  assert.match(text, /last seen: 2026-01-01T00:00:00\.000Z/)
})

test('formatNodeChange: online alert uses the online emoji and omits last_seen noise', () => {
  const text = formatNodeChange({
    kind: 'status_change',
    node_id: 'node_test_0001',
    name: 'Test Node',
    from: 'offline',
    to: 'online',
    last_seen: '2026-01-01T00:00:00.000Z',
  })
  assert.match(text, /^🟢/)
  assert.match(text, /Node online/)
  assert.doesNotMatch(text, /last seen/)
})

// ── active_runs change alert ─────────────────────────────────────────────────

test('formatNodeChange: active_runs change shows the before/after counts', () => {
  const text = formatNodeChange({ kind: 'active_runs_change', node_id: 'node_test_0001', name: 'Test Node', from: 1, to: 3 })
  assert.match(text, /Active runs changed/)
  assert.match(text, /1 → 3/)
})

// ── relay failure / recovery alerts ──────────────────────────────────────────

test('diffRelay: healthy -> unreachable fires relay_failure(unreachable) exactly once', () => {
  const healthy = relay({ reachable: true, authOk: true })
  const down = relay({ reachable: false, authOk: null })
  assert.deepEqual(diffRelay(healthy, down), { kind: 'relay_failure', hostname: 'relay.example.com', reason: 'unreachable' })
  // staying down on the next poll must not re-fire
  assert.equal(diffRelay(down, down), null)
})

test('diffRelay: healthy -> auth failure fires relay_failure(auth_failed)', () => {
  const healthy = relay({ reachable: true, authOk: true })
  const authFailed = relay({ reachable: true, authOk: false })
  assert.deepEqual(diffRelay(healthy, authFailed), { kind: 'relay_failure', hostname: 'relay.example.com', reason: 'auth_failed' })
})

test('diffRelay: unreachable -> healthy fires relay_recovery exactly once', () => {
  const down = relay({ reachable: false, authOk: null })
  const healthy = relay({ reachable: true, authOk: true })
  assert.deepEqual(diffRelay(down, healthy), { kind: 'relay_recovery', hostname: 'relay.example.com' })
  assert.equal(diffRelay(healthy, healthy), null)
})

test('diffRelay: first-ever poll counts as healthy baseline (no spurious recovery alert)', () => {
  assert.equal(diffRelay(null, relay({ reachable: true, authOk: true })), null)
})

test('formatRelayChange: auth failure tells the operator which env var to check, without leaking the token', () => {
  const text = formatRelayChange({ kind: 'relay_failure', hostname: 'relay.example.com', reason: 'auth_failed' })
  assert.match(text, /^❌/)
  assert.match(text, /Relay auth failed/)
  assert.match(text, /relay: relay\.example\.com/)
  assert.match(text, /action: check VIBE_RELAY_TOKEN env/)
})

test('formatRelayChange: recovery message is short and positive', () => {
  const text = formatRelayChange({ kind: 'relay_recovery', hostname: 'relay.example.com' })
  assert.match(text, /^✅/)
  assert.match(text, /Relay recovered/)
})

// ── run diffing (supporting the alert pipeline end to end) ──────────────────

test('diffRuns: queued -> running raises run_started; terminal states raise once', () => {
  const prevQueued = { [run().run_id]: run({ status: 'queued' }) }
  const started = diffRuns(prevQueued, [run({ status: 'running' })])
  assert.equal(started.length, 1)
  assert.equal(started[0].kind, 'run_started')

  const prevRunning = { [run().run_id]: run({ status: 'running' }) }
  const completed = diffRuns(prevRunning, [run({ status: 'completed' })])
  assert.equal(completed.length, 1)
  assert.equal(completed[0].kind, 'run_completed')
})

test('diffRuns: transition into blocked raises run_approval_required', () => {
  const prev = { [run().run_id]: run({ status: 'running' }) }
  const changes = diffRuns(prev, [run({ status: 'blocked', approval_required: true })])
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, 'run_approval_required')
})

test('diffRuns: unseen runs are not reported (only transitions are)', () => {
  assert.deepEqual(diffRuns({}, [run()]), [])
})

// ── Telegram message formatting ──────────────────────────────────────────────

test('formatNodesList: lists every node with status dot, agents, and last_seen', () => {
  const text = formatNodesList([node({ status: 'online' }), node({ node_id: 'node_test_0002', name: 'Other', status: 'offline', last_seen: null })])
  assert.match(text, /📡 Nodes/)
  assert.match(text, /🟢 Test Node \(node_test_00/)
  assert.match(text, /🔴 Other \(node_test_00/)
  assert.match(text, /last seen: unknown/)
})

test('formatNodesList: empty registry says so plainly', () => {
  assert.match(formatNodesList([]), /\(none registered\)/)
})

test('formatRunsList: shows status, node, agent, and issue id', () => {
  const text = formatRunsList([run()])
  assert.match(text, /🗂 Runs/)
  assert.match(text, /running/)
  assert.match(text, /node: node_test_00/)
  assert.match(text, /agent: claude-code/)
  assert.match(text, /issue: JOZ-12/)
})

test('formatRunChange: includes run/node/agent and the right header per kind', () => {
  assert.match(formatRunChange({ kind: 'run_started', run: run({ status: 'running' }) }), /🏃 Run started/)
  assert.match(formatRunChange({ kind: 'run_failed', run: run({ status: 'failed' }) }), /❌ Run failed/)
  assert.match(formatRunChange({ kind: 'run_approval_required', run: run({ status: 'blocked' }) }), /🟡 Run needs approval/)
})

test('formatHelp: documents the six read-only commands and disclaims control', () => {
  const text = formatHelp()
  for (const cmd of ['/status', '/nodes', '/runs', '/symphony', '/linear', '/help']) {
    assert.match(text, new RegExp(cmd.replace('/', '\\/')))
  }
  assert.match(text, /read-only/i)
  assert.match(text, /cannot approve, deny, merge/i)
})

test('formatSymphonyStatus / formatLinearStatus: degrade gracefully when not configured', () => {
  assert.match(formatSymphonyStatus(null), /SYMPHONY_WORKDIR not configured/)
  assert.match(formatLinearStatus(null), /LINEAR_API_KEY or network/)
})

// ── secret redaction ─────────────────────────────────────────────────────────

test('redactSecrets: blanks every known secret value by exact match', () => {
  const text = redactSecrets(
    'relay token=tok-super-secret-123, telegram=bot-987654321:ABCEXAMPLE, linear=lin_api_EXAMPLEKEY',
    ['tok-super-secret-123', 'bot-987654321:ABCEXAMPLE', 'lin_api_EXAMPLEKEY'],
  )
  assert.doesNotMatch(text, /tok-super-secret-123/)
  assert.doesNotMatch(text, /bot-987654321:ABCEXAMPLE/)
  assert.doesNotMatch(text, /lin_api_EXAMPLEKEY/)
  assert.match(text, /\[REDACTED\]/)
})

test('redactSecrets: also scrubs generic credential shapes via the pattern backstop', () => {
  const text = redactSecrets('token: ghp_' + 'A'.repeat(36), [])
  assert.doesNotMatch(text, /ghp_/)
  assert.match(text, /\[REDACTED\]/)
})

test('redactSecrets: ignores short/undefined values so it never blanks unrelated text', () => {
  const text = redactSecrets('the cat sat on the mat', [undefined, null, 'ab'])
  assert.equal(text, 'the cat sat on the mat')
})

test('relayHostname: extracts hostname only — never the token or path that may follow it', () => {
  assert.equal(relayHostname('wss://relay.example.com:7433/?token=super-secret'), 'relay.example.com')
  assert.equal(relayHostname('ws://127.0.0.1:7433'), '127.0.0.1')
  // even a malformed URL must not leak whatever followed the host
  assert.doesNotMatch(relayHostname('not-a-valid-url/token=super-secret'), /super-secret/)
})

// ── /status command formatting ───────────────────────────────────────────────

test('dispatchCommand /status: summarizes relay health, node counts, active runs, and pending approvals', () => {
  const state: MonitorState = {
    version: 1,
    relay: relay(),
    nodes: {
      a: node({ node_id: 'a', status: 'online', active_runs: 2 }),
      b: node({ node_id: 'b', status: 'offline', active_runs: 0 }),
    },
    runs: {
      r1: run({ run_id: 'r1', status: 'blocked', approval_required: true }),
      r2: run({ run_id: 'r2', status: 'running', approval_required: false }),
    },
    updated_at: '2026-01-01T00:10:00.000Z',
  }
  const text = dispatchCommand('/status', emptyContext({ state, relay: relay() }))
  assert.ok(text)
  assert.match(text!, /📊 Status/)
  assert.match(text!, /✅ relay: relay\.example\.com \(ok\)/)
  assert.match(text!, /nodes: 1\/2 online/)
  assert.match(text!, /active runs: 2/)
  assert.match(text!, /awaiting approval: 1/)
  assert.match(text!, /updated: 2026-01-01T00:10:00\.000Z/)
})

test('dispatchCommand /status: reflects an unhealthy relay without ever printing the token', () => {
  const text = dispatchCommand('/status', emptyContext({ relay: relay({ reachable: true, authOk: false }) }))
  assert.match(text!, /❌ relay: relay\.example\.com \(auth failed\)/)
})

// ── no write/control commands exposed ────────────────────────────────────────

test('dispatchCommand: only the six documented read-only commands produce a reply', () => {
  for (const cmd of ['/status', '/nodes', '/runs', '/symphony', '/linear', '/help']) {
    assert.notEqual(dispatchCommand(cmd, emptyContext()), null, `${cmd} should be recognized`)
  }
})

test('dispatchCommand: every control-shaped command is rejected — no approve/merge/start/stop/exec path exists', () => {
  const forbidden = [
    '/approve', '/deny', '/reject', '/merge', '/start', '/stop', '/restart',
    '/run', '/exec', '/shell', '/cancel', '/kill', '/move', '/label',
    '/approve r1', '/merge JOZ-12', '/start run_abc', '/stop node_test_0001',
    'approve', 'merge this', '$(rm -rf /)', '; cat /etc/passwd',
  ]
  for (const text of forbidden) {
    assert.equal(dispatchCommand(text, emptyContext()), null, `"${text}" must not produce a reply`)
  }
})

test('dispatchCommand: unknown commands and plain chatter are ignored, not echoed', () => {
  assert.equal(dispatchCommand('hello there', emptyContext()), null)
  assert.equal(dispatchCommand('', emptyContext()), null)
  assert.equal(dispatchCommand('   ', emptyContext()), null)
})

test('dispatchCommand: matching is case-insensitive and tolerates a /command@BotName suffix', () => {
  assert.notEqual(dispatchCommand('/STATUS', emptyContext()), null)
  assert.notEqual(dispatchCommand('/status@VibeMonitorBot', emptyContext()), null)
})

// ── state persistence (env-overridden path so tests never touch ~/.vibe) ────

test('state: round-trips through the VIBE_TELEGRAM_MONITOR_STATE_FILE override', () => {
  const tmpPath = path.join(os.tmpdir(), `vibe-telegram-monitor-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)
  const originalEnv = process.env.VIBE_TELEGRAM_MONITOR_STATE_FILE
  process.env.VIBE_TELEGRAM_MONITOR_STATE_FILE = tmpPath
  try {
    assert.equal(statePath(), tmpPath)
    assert.deepEqual(loadState(), emptyState())

    const state: MonitorState = {
      version: 1,
      relay: relay(),
      nodes: { [node().node_id]: node() },
      runs: { [run().run_id]: run() },
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    saveState(state)
    assert.deepEqual(loadState(), state)
    assert.ok(fs.existsSync(tmpPath))
  } finally {
    if (originalEnv === undefined) delete process.env.VIBE_TELEGRAM_MONITOR_STATE_FILE
    else process.env.VIBE_TELEGRAM_MONITOR_STATE_FILE = originalEnv
    fs.rmSync(tmpPath, { force: true })
    fs.rmSync(`${tmpPath}.tmp`, { force: true })
  }
})
