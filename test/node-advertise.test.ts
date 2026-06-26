/**
 * Node advertise allowlist — mock-only advertise safety valve.
 *
 * A node daemon normally advertises every agent it can run (mock + claude-code,
 * etc.) to the relay, so a production orchestrator could dispatch a real paid
 * claude-code job to it. `resolveAdvertisedAgents()` lets an operator restrict
 * what the node PUBLISHES to the relay — e.g. `mock` only — before a live-relay
 * smoke, without changing what the node can actually run locally.
 *
 * Safety: these tests use the mock agent only, a fake in-process relay, and a
 * throwaway VIBE_DIR. No real claude/codex/opencode is invoked, no production
 * relay is contacted, and nothing is written to the real ~/.vibe.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  resolveAgents,
  resolveAdvertisedAgents,
  AdvertiseAllowlistError,
} from '../src/agent-registry.js'
import { startRelayServer } from '../src/relay/server.js'
import { fetchRemoteNodes } from '../src/relay/client.js'
import { freshVibeDir } from './helpers/agent-fixtures.js'
import type { VibeNode } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath

// Throwaway VIBE_DIR shared by every spawned process here; never the real ~/.vibe.
const VIBE_DIR = freshVibeDir('vibe-advertise-test-')
const TEST_TOKEN = `adv-tok-${Date.now()}-${Math.random().toString(36).slice(2)}`

/** Run a body with VIBE_NODE_ADVERTISE_AGENTS set to a precise value (or unset
 *  when `undefined`), restoring the prior value afterwards. */
function withAdvertiseEnv<T>(value: string | undefined, body: () => T): T {
  const prev = process.env.VIBE_NODE_ADVERTISE_AGENTS
  if (value === undefined) delete process.env.VIBE_NODE_ADVERTISE_AGENTS
  else process.env.VIBE_NODE_ADVERTISE_AGENTS = value
  try {
    return body()
  } finally {
    if (prev === undefined) delete process.env.VIBE_NODE_ADVERTISE_AGENTS
    else process.env.VIBE_NODE_ADVERTISE_AGENTS = prev
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Invoke `fn`, asserting it throws, and return the thrown error for inspection. */
function caught(fn: () => unknown): AdvertiseAllowlistError {
  try {
    fn()
  } catch (e) {
    return e as AdvertiseAllowlistError
  }
  throw new assert.AssertionError({ message: 'expected function to throw, but it did not' })
}

// ── unit: resolveAdvertisedAgents ───────────────────────────────────────────

test('advertise: default (unset) is identical to resolveAgents()', () => {
  withAdvertiseEnv(undefined, () => {
    assert.deepEqual(resolveAdvertisedAgents(), resolveAgents())
  })
})

test('advertise: VIBE_NODE_ADVERTISE_AGENTS=mock advertises only ["mock"]', () => {
  withAdvertiseEnv('mock', () => {
    assert.deepEqual(resolveAdvertisedAgents(), ['mock'])
  })
  // Explicit allowlist argument (CLI flag) takes the same effect.
  assert.deepEqual(resolveAdvertisedAgents(['mock']), ['mock'])
})

test('advertise: multiple allowed agents work (comma, repeated, deduped)', () => {
  assert.deepEqual(resolveAdvertisedAgents('mock,claude-code'), ['mock', 'claude-code'])
  assert.deepEqual(resolveAdvertisedAgents(['mock', 'claude-code']), ['mock', 'claude-code'])
  assert.deepEqual(resolveAdvertisedAgents(['mock', 'mock']), ['mock'])
  withAdvertiseEnv('mock, claude-code', () => {
    assert.deepEqual(resolveAdvertisedAgents(), ['mock', 'claude-code'])
  })
})

test('advertise: invalid agent name fails fast with a structured error', () => {
  const err = caught(() => resolveAdvertisedAgents(['bogus']))
  assert.ok(err instanceof AdvertiseAllowlistError)
  assert.equal(err.code, 'advertise_agent_invalid')
  assert.deepEqual(err.invalid, ['bogus'])
  // Mixed valid + invalid still rejects, naming only the invalid token.
  const err2 = caught(() => resolveAdvertisedAgents('mock,bogus'))
  assert.equal(err2.code, 'advertise_agent_invalid')
  assert.deepEqual(err2.invalid, ['bogus'])
})

test('advertise: empty allowlist fails fast with a structured error', () => {
  assert.equal(caught(() => resolveAdvertisedAgents([])).code, 'advertise_allowlist_empty')
  assert.equal(caught(() => resolveAdvertisedAgents('')).code, 'advertise_allowlist_empty')
  // An env set to empty / whitespace is "configured but empty" → also fails.
  withAdvertiseEnv('   ', () => {
    assert.equal(caught(() => resolveAdvertisedAgents()).code, 'advertise_allowlist_empty')
  })
})

test('advertise: allowlist does NOT change local runner resolution', () => {
  // resolveAgents() decides what the node can RUN; the advertise valve must not
  // touch it. Even with a mock-only advertise allowlist, claude-code stays
  // runnable locally.
  const baseline = withAdvertiseEnv(undefined, () => resolveAgents())
  withAdvertiseEnv('mock', () => {
    assert.deepEqual(resolveAgents(), baseline)
    assert.ok(resolveAgents().includes('claude-code'), 'claude-code still runnable locally')
  })
})

// ── integration: relay registration payload + local run support ─────────────

interface LiveNode { server: Awaited<ReturnType<typeof startRelayServer>>; relayUrl: string; daemon: ChildProcess }

/** Spin a fake relay + a real `vibe node daemon` (mock-capable), wait until it
 *  has registered, and return the live handles. `advertise` (when given) is
 *  passed as VIBE_NODE_ADVERTISE_AGENTS. Token via env, never argv. */
async function spinNode(nodeId: string, advertise?: string): Promise<LiveNode> {
  const server = await startRelayServer({ port: 0, token: TEST_TOKEN })
  const relayUrl = `ws://127.0.0.1:${server.port}`
  // Build env precisely: only set VIBE_NODE_ADVERTISE_AGENTS when an allowlist
  // was requested, so the `undefined` case exercises the true default path.
  const env: NodeJS.ProcessEnv = { ...process.env, VIBE_DIR, VIBE_RELAY_TOKEN: TEST_TOKEN, VIBE_NODE_HEARTBEAT_MS: '250' }
  delete env.VIBE_NODE_ADVERTISE_AGENTS
  if (advertise !== undefined) env.VIBE_NODE_ADVERTISE_AGENTS = advertise
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', nodeId], { env, stdio: 'pipe' })
  return waitRegistered(server, relayUrl, daemon, nodeId)
}

async function waitRegistered(server: LiveNode['server'], relayUrl: string, daemon: ChildProcess, nodeId: string): Promise<LiveNode> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await delay(300)
    try {
      const nodes = await fetchRemoteNodes(relayUrl, TEST_TOKEN)
      if (nodes.some((n) => n.node_id === nodeId)) return { server, relayUrl, daemon }
    } catch { /* relay not ready yet */ }
  }
  daemon.kill('SIGKILL')
  await server.close()
  throw new Error(`node ${nodeId} did not register within 8s`)
}

async function teardown(n: LiveNode): Promise<void> {
  n.daemon.kill('SIGTERM')
  await new Promise((r) => n.daemon.on('exit', r))
  await n.server.close()
}

test('advertise: relay registration payload contains only the advertised agents', async () => {
  const mockOnly = await spinNode('adv-mock-only-node', 'mock')
  try {
    const nodes = await fetchRemoteNodes(mockOnly.relayUrl, TEST_TOKEN)
    const me = nodes.find((n) => n.node_id === 'adv-mock-only-node') as VibeNode
    assert.ok(me, 'node registered')
    assert.deepEqual(me.agents, ['mock'], 'advertises exactly ["mock"]')
  } finally {
    await teardown(mockOnly)
  }
})

test('advertise: default daemon (no allowlist) still advertises full agent set', async () => {
  const dflt = await spinNode('adv-default-node')
  try {
    const nodes = await fetchRemoteNodes(dflt.relayUrl, TEST_TOKEN)
    const me = nodes.find((n) => n.node_id === 'adv-default-node') as VibeNode
    assert.ok(me, 'node registered')
    assert.ok(me.agents.includes('claude-code'), 'default advertise still includes claude-code')
  } finally {
    await teardown(dflt)
  }
})

test('advertise: local run support is unchanged even with a mock-only allowlist', () => {
  // A purely-local run (no relay) is never gated by the advertise allowlist.
  // With VIBE_NODE_ADVERTISE_AGENTS=mock set, a local mock run still starts.
  const r = spawnSync(NODE, [CLI, 'run', 'start', '--node', 'local', '--agent', 'mock', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, VIBE_DIR, VIBE_NODE_ADVERTISE_AGENTS: 'mock' },
  })
  assert.equal(r.status, 0, `run start should succeed; stderr: ${r.stderr}`)
  const rec = JSON.parse(r.stdout.trim())
  assert.ok(rec.run_id, 'local run produced a run_id')
  assert.equal(rec.agent, 'mock')
})

test('advertise: invalid CLI/env allowlist makes `node daemon` exit non-zero with structured error', () => {
  const r = spawnSync(NODE, [CLI, 'node', 'daemon', '--local', '--relay', 'ws://127.0.0.1:0', '--advertise-agent', 'bogus'], {
    encoding: 'utf8',
    env: { ...process.env, VIBE_DIR, VIBE_RELAY_TOKEN: TEST_TOKEN },
    timeout: 8000,
  })
  assert.notEqual(r.status, 0, 'daemon must refuse to start')
  const line = (r.stderr.trim().split('\n').find((l) => l.includes('advertise_agent_invalid')) ?? '').trim()
  assert.ok(line, `expected a structured error on stderr; got: ${r.stderr}`)
  const err = JSON.parse(line)
  assert.equal(err.error, true)
  assert.equal(err.code, 'advertise_agent_invalid')
})
