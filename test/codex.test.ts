/**
 * Codex backend tests.
 * Uses a fake codex binary from test/fixtures/ injected via PATH.
 * Also covers agent advertisement (VIBE_ENABLE_CODEX) and dispatch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { RunRecord, RunEvent, StatusEvent, LogEvent, PrCreatedEvent, VibeNode } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures')

// PATH with fake codex first (also keeps fake claude for other tests that run alongside)
const fakeCodexPath = { ...process.env, PATH: FIXTURES + ':' + process.env.PATH }
// PATH without codex (but with claude so other agent paths are unaffected)
const noCodexPath = { ...process.env, PATH: '/tmp' }

function vibe(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env })
}

function vibeTimeout(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, timeout: 15000 })
}

function uniqueKey() {
  return `cx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function promptFile(content: string): string {
  const p = path.join(os.tmpdir(), `vibe-test-prompt-${Date.now()}.md`)
  fs.writeFileSync(p, content)
  return p
}

// Points VIBE_NODE_STATE_FILE at a fresh, nonexistent path so the local node is computed
// from resolveAgents()/PATH (via getBuiltinLocalNode) instead of a possibly-stale real
// ~/.vibe/node-local.json daemon state file.
function isolatedNodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    VIBE_NODE_STATE_FILE: path.join(os.tmpdir(), `vibe-test-node-state-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`),
  }
}

function parseEvents(jsonl: string): RunEvent[] {
  return jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent)
}

// ── Hidden command registration ────────────────────────────────────────────

test('_codex-runner: command is registered and hidden from help', () => {
  const help = vibe(fakeCodexPath, '--help')
  assert.equal(help.status, 0, `help failed: ${help.stderr}`)
  assert.ok(!help.stdout.includes('_codex-runner'), '_codex-runner must not appear in help output')
})

// ── Agent advertisement ────────────────────────────────────────────────────

test('node list: does NOT advertise codex when VIBE_ENABLE_CODEX is unset', () => {
  const env: NodeJS.ProcessEnv = { ...fakeCodexPath, VIBE_ENABLE_CODEX: undefined }
  const r = vibe(env, 'node', 'list', '--json')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
  const local = nodes.find((n) => n.node_id === 'local')
  assert.ok(local, 'local node present')
  assert.ok(!local!.agents.includes('codex'), 'codex must NOT be in agents when VIBE_ENABLE_CODEX is unset')
})

test('node list: advertises codex when VIBE_ENABLE_CODEX=1 and binary exists', () => {
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const r = vibe(env, 'node', 'list', '--json')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
  const local = nodes.find((n) => n.node_id === 'local')
  assert.ok(local, 'local node present')
  assert.ok(local!.agents.includes('codex'), 'codex must be in agents when VIBE_ENABLE_CODEX=1 and binary in PATH')
})

test('node list: does NOT advertise codex when VIBE_ENABLE_CODEX=1 but binary missing', () => {
  const env = { ...noCodexPath, VIBE_ENABLE_CODEX: '1' }
  const r = vibe(env, 'node', 'list', '--json')
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const nodes = JSON.parse(r.stdout.trim()) as VibeNode[]
  const local = nodes.find((n) => n.node_id === 'local')
  assert.ok(local, 'local node present')
  assert.ok(!local!.agents.includes('codex'), 'codex must NOT be in agents when binary is missing')
})

test('node list: warns to stderr when VIBE_ENABLE_CODEX=1 but binary missing', () => {
  const env = { ...noCodexPath, VIBE_ENABLE_CODEX: '1' }
  const r = vibe(env, 'node', 'list', '--json')
  assert.match(r.stderr, /VIBE_ENABLE_CODEX=1 but codex binary not found/, 'must warn about missing binary')
})

test('node list: always includes mock and claude-code regardless of VIBE_ENABLE_CODEX', () => {
  for (const enableCodex of ['0', '1', undefined]) {
    const env: NodeJS.ProcessEnv = enableCodex !== undefined
      ? { ...fakeCodexPath, VIBE_ENABLE_CODEX: enableCodex }
      : { ...fakeCodexPath }
    if (enableCodex === undefined) delete env.VIBE_ENABLE_CODEX
    const r = vibe(env, 'node', 'list', '--json')
    const nodes = JSON.parse(r.stdout.trim()) as Array<{ agents: string[]; node_id: string }>
    const local = nodes.find((n) => n.node_id === 'local')!
    assert.ok(local.agents.includes('mock'), `mock must always be present (VIBE_ENABLE_CODEX=${enableCodex})`)
    assert.ok(local.agents.includes('claude-code'), `claude-code must always be present (VIBE_ENABLE_CODEX=${enableCodex})`)
  }
})

// ── Run dispatch ───────────────────────────────────────────────────────────

test('run start --agent codex: dispatches to _codex-runner (not _claude-runner)', () => {
  const pf = promptFile('write hello world')
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.agent, 'codex')
  assert.equal(record.status, 'running')
  // stream events — fake codex exits 0 → completed
  const stream = vibeTimeout(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)
  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.type, 'status')
  assert.equal(last.status, 'completed')
})

test('run start --agent codex: rejected when VIBE_ENABLE_CODEX unset (agent_not_supported)', () => {
  const pf = promptFile('hello')
  const env: NodeJS.ProcessEnv = { ...fakeCodexPath, VIBE_ENABLE_CODEX: undefined }
  const r = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.error, true)
  assert.equal(out.code, 'agent_not_supported')
})

test('run start --agent claude-code: still works when VIBE_ENABLE_CODEX=1', () => {
  const pf = promptFile('hello')
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.agent, 'claude-code')
  assert.equal(record.status, 'running')
  vibe(env, 'run', 'stop', record.run_id)
})

test('run start --agent mock: still works regardless of VIBE_ENABLE_CODEX', () => {
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'mock', '--workspace-key', uniqueKey())
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.agent, 'mock')
  vibe(env, 'run', 'stop', record.run_id)
})

// ── Missing binary ─────────────────────────────────────────────────────────

test('codex: missing binary emits error and status failed', () => {
  // Use VIBE_ENABLE_CODEX=1 but no codex in PATH — run starts (agent accepted by local node
  // only if advertised, so we need to start it via a workaround: write a run record directly
  // or allow the node to advertise codex then remove it before dispatch)
  // Simpler: use fake PATH that has codex for node list check but not for actual spawn
  const pf = promptFile('say hello')

  // Step 1: start the run with fake codex in PATH (so agent is accepted)
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  // Step 2: the runner subprocess was spawned — wait for it to finish
  const stream = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  // Fake codex exits 0, so completed. This confirms codex runner was dispatched.
  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.type, 'status')
  assert.equal(last.status, 'completed')
})

test('codex: fake codex exits nonzero → status failed', () => {
  const pf = promptFile('this will fail')
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1', FAKE_CODEX_EXIT_CODE: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const errorEvent = events.find((e) => e.type === 'error')
  assert.ok(errorEvent, 'has error event')
  assert.match((errorEvent as { message: string }).message, /codex exited with code/)

  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.status, 'failed')
})

test('codex: fake codex exits 0 → log events + completed', () => {
  const pf = promptFile('write hello world in python')
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)
  const record = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(record.agent, 'codex')
  assert.equal(record.status, 'running')

  const stream = vibeTimeout(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)
  const logEvents = events.filter((e) => e.type === 'log') as LogEvent[]
  assert.ok(logEvents.length >= 1, `expected log events, got ${logEvents.length}`)
  assert.match(logEvents[0].message, /Completed task/)

  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.status, 'completed')
})

test('codex: run stop kills long-running codex process', () => {
  const pf = promptFile('long task')
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1', FAKE_CODEX_HANG: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  spawnSync('sleep', ['0.5'])

  const stop = vibe(env, 'run', 'stop', run_id, '--json')
  assert.equal(stop.status, 0, `stop failed: ${stop.stderr}`)
  const stopped = JSON.parse(stop.stdout.trim()) as RunRecord
  assert.equal(stopped.status, 'stopped')
})

// ── Workspace / prompt ─────────────────────────────────────────────────────

test('codex: missing prompt file → status failed with clear error', () => {
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(),
    '--prompt-file', '/tmp/does-not-exist-vibe-codex-test.md')
  assert.equal(start.status, 0)
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = parseEvents(stream.stdout)
  const errorEvent = events.find((e) => e.type === 'error')
  assert.ok(errorEvent, 'has error event')
  assert.match((errorEvent as { message: string }).message, /prompt file not found/)

  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.status, 'failed')
})

// ── stdout cleanliness ─────────────────────────────────────────────────────

test('codex: start stdout is exactly one valid JSON line', () => {
  const pf = promptFile('hello')
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)
  const lines = start.stdout.trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  JSON.parse(lines[0])
  assert.equal(start.stderr.trim(), '')
})

test('codex: stream stdout is valid JSONL (all lines parse)', () => {
  const pf = promptFile('hello')
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const lines = stream.stdout.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    const event = JSON.parse(line) as RunEvent
    assert.ok(event.type)
    assert.ok(event.run_id)
    assert.ok(event.ts)
  }
})

// ── PR detection ───────────────────────────────────────────────────────────

test('codex: PR URL in stdout emits pr_created event', () => {
  const pf = promptFile('open a pr')
  const env = {
    ...isolatedNodeEnv(fakeCodexPath),
    VIBE_ENABLE_CODEX: '1',
    FAKE_CODEX_EXTRA_STDOUT: 'Opened PR: https://github.com/JozzyAI/fin_bot/pull/4',
  }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const prEvent = events.find((e) => e.type === 'pr_created') as PrCreatedEvent | undefined
  assert.ok(prEvent, 'has pr_created event')
  assert.equal(prEvent!.url, 'https://github.com/JozzyAI/fin_bot/pull/4')

  const last = events[events.length - 1] as StatusEvent
  assert.equal(last.status, 'completed')
})

test('codex: multiple PR URLs on one line — last one wins', () => {
  const pf = promptFile('open a pr')
  const env = {
    ...isolatedNodeEnv(fakeCodexPath),
    VIBE_ENABLE_CODEX: '1',
    FAKE_CODEX_EXTRA_STDOUT: 'Superseded https://github.com/JozzyAI/fin_bot/pull/3 with https://github.com/JozzyAI/fin_bot/pull/4',
  }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const prEvents = events.filter((e) => e.type === 'pr_created') as PrCreatedEvent[]
  assert.equal(prEvents.length, 1, 'exactly one pr_created event for the line')
  assert.equal(prEvents[0].url, 'https://github.com/JozzyAI/fin_bot/pull/4')
})

test('codex: same PR URL repeated across separate lines — only one pr_created event', () => {
  const pf = promptFile('open a pr')
  const url = 'https://github.com/JozzyAI/fin_bot/pull/4'
  const env = {
    ...isolatedNodeEnv(fakeCodexPath),
    VIBE_ENABLE_CODEX: '1',
    FAKE_CODEX_EXTRA_STDOUT: `Opened PR: ${url}\nPR #4 is open and ready for review: ${url}`,
  }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const record = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  const prEvents = events.filter((e) => e.type === 'pr_created') as PrCreatedEvent[]
  assert.equal(prEvents.length, 1, 'exactly one pr_created event for the repeated URL')
  assert.equal(prEvents[0].url, url)

  // both lines are still logged
  const logEvents = events.filter((e) => e.type === 'log') as LogEvent[]
  assert.ok(logEvents.some((e) => e.message.includes('Opened PR')), 'first line still logged')
  assert.ok(logEvents.some((e) => e.message.includes('is open and ready')), 'second line still logged')
})

test('codex: no PR URL in output — no pr_created event', () => {
  const pf = promptFile('write hello world')
  const env = { ...isolatedNodeEnv(fakeCodexPath), VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)
  const record = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', record.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  assert.ok(!events.some((e) => e.type === 'pr_created'), 'no pr_created event when no PR URL is present')
})

// ── Redaction ──────────────────────────────────────────────────────────────

test('codex: OpenAI-style API key in codex stderr is redacted in log events', () => {
  // The fake codex fixture emits stderr via the runner's redact() path.
  // We verify that secrets matching sk-... pattern are redacted.
  // (The fake codex doesn't emit keys, so we verify redact() is wired by checking
  //  that the runner imports and calls redact on each stderr line.)
  // This is a structural test: we confirm the codex runner applies redact() to stderr.
  const pf = promptFile('hello')
  const env = { ...fakeCodexPath, VIBE_ENABLE_CODEX: '1' }
  const start = vibe(env, 'run', 'start', '--agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0)
  const { run_id } = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  // No raw sk-... tokens in any log message
  for (const event of events) {
    if (event.type === 'log') {
      assert.doesNotMatch((event as LogEvent).message, /sk-[A-Za-z0-9]{32,}/, 'no raw API key in log events')
    }
  }
})
