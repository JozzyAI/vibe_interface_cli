/**
 * Meta-Agent Runtime tests.
 *
 * Unit: failure classifier, policy resolution/packing, handoff (incl. no-secrets).
 * Integration: spawn the real CLI (with fake claude on PATH) and exercise the
 * supervisor's fallback path under one run_id.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { RunRecord, RunEvent, StatusEvent } from '../src/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures')

// Isolated vibe home so handoff/event paths are deterministic and we don't touch ~/.vibe.
const VIBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-meta-'))
process.env.VIBE_DIR = VIBE_DIR

const baseEnv: NodeJS.ProcessEnv = { ...process.env, VIBE_DIR, PATH: FIXTURES + ':' + process.env.PATH }

function vibe(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env })
}
function vibeTimeout(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env, timeout: 20000 })
}
function uniqueKey() {
  return `ma-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}
function promptFile(content: string): string {
  const p = path.join(os.tmpdir(), `vibe-meta-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`)
  fs.writeFileSync(p, content)
  return p
}
function parseEvents(jsonl: string): RunEvent[] {
  return jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunEvent)
}

// ════════════════════════════════ Unit ════════════════════════════════════

test('classifyFailure: recoverable reasons', async () => {
  const { classifyFailure } = await import('../src/runtime/classify.js')
  const cases: Array<[string, string]> = [
    ["You've hit your session limit", 'session_limit'],
    ['You have reached your usage limit', 'usage_limit'],
    ['Error: quota exceeded', 'quota_exceeded'],
    ['rate limit exceeded, try later', 'rate_limited'],
    ['HTTP 429 Too Many Requests', 'rate_limited'],
    ['maximum context length exceeded', 'context_limit'],
    ['All credential paths are exhausted', 'auth_expired'],
  ]
  for (const [text, reason] of cases) {
    const c = classifyFailure(text)
    assert.equal(c.reason, reason, `"${text}" → ${reason}`)
    assert.equal(c.recoverable, true, `"${text}" recoverable`)
  }
})

test('classifyFailure: non-recoverable reasons', async () => {
  const { classifyFailure } = await import('../src/runtime/classify.js')
  const cases: Array<[string, string]> = [
    ['3 failing tests', 'tests_failed'],
    ['CONFLICT: merge conflict in app.ts', 'merge_conflict'],
    ['repository not found', 'repo_not_found'],
    ['Permission denied (publickey)', 'permission_denied'],
    ['workspace_repo_mismatch', 'unknown_repo'],
    ['prompt file not found: /tmp/x', 'invalid_task'],
  ]
  for (const [text, reason] of cases) {
    const c = classifyFailure(text)
    assert.equal(c.reason, reason, `"${text}" → ${reason}`)
    assert.equal(c.recoverable, false, `"${text}" non-recoverable`)
  }
})

test('classifyFailure: unknown text is non-recoverable', async () => {
  const { classifyFailure } = await import('../src/runtime/classify.js')
  const c = classifyFailure('something we have never seen')
  assert.equal(c.reason, 'unknown')
  assert.equal(c.recoverable, false)
})

test('buildAgentPolicyMetadata: undefined when no fallbacks (byte-compat)', async () => {
  const { buildAgentPolicyMetadata } = await import('../src/runtime/policy.js')
  assert.equal(buildAgentPolicyMetadata({}), undefined)
  // unknown agents filtered out → still undefined
  assert.equal(buildAgentPolicyMetadata({ fallbackAgents: ['nonsense'] }), undefined)
})

test('buildAgentPolicyMetadata: packs fallbacks, switch_on; filters unknowns', async () => {
  const { buildAgentPolicyMetadata } = await import('../src/runtime/policy.js')
  const meta = buildAgentPolicyMetadata({
    fallbackAgents: 'codex, mock, bogus',
    switchOn: 'session_limit, made_up',
    handoffOnFailure: true,
  })
  assert.ok(meta)
  assert.deepEqual(meta!.fallbacks, ['codex', 'mock'])
  assert.deepEqual(meta!.switch_on, ['session_limit'])
  assert.equal(meta!.handoff_on_switch, true)
})

test('resolveAgentPolicy: no metadata → no fallbacks, default switchOn', async () => {
  const { resolveAgentPolicy } = await import('../src/runtime/policy.js')
  const { DEFAULT_SWITCH_ON } = await import('../src/runtime/types.js')
  const rec = { agent: 'claude-code', metadata: undefined } as unknown as RunRecord
  const p = resolveAgentPolicy(rec)
  assert.equal(p.primary, 'claude-code')
  assert.deepEqual(p.fallbacks, [])
  assert.deepEqual(p.switchOn, DEFAULT_SWITCH_ON)
  assert.equal(p.preserveWorkspace, true)
  assert.equal(p.handoffOnSwitch, true)
})

test('resolveAgentPolicy: metadata fallbacks; default switchOn when switch_on absent', async () => {
  const { resolveAgentPolicy } = await import('../src/runtime/policy.js')
  const { DEFAULT_SWITCH_ON } = await import('../src/runtime/types.js')
  const rec = { agent: 'claude-code', metadata: { agent_policy: { fallbacks: ['mock'] } } } as unknown as RunRecord
  const p = resolveAgentPolicy(rec)
  assert.deepEqual(p.fallbacks, ['mock'])
  assert.deepEqual(p.switchOn, DEFAULT_SWITCH_ON)
})

test('writeHandoff: contains task context and never leaks secrets', async () => {
  const { writeHandoff } = await import('../src/runtime/handoff.js')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ho-ws-'))
  const rec = {
    run_id: 'run_ho_test',
    session_id: '1',
    workspace_path: ws,
    branch: 'feature/x',
    repo_url: 'https://github.com/JozzyAI/fin_bot',
    metadata: { issue_id: 'JOZ-99', issue_title: 'Do the thing' },
  } as unknown as RunRecord

  const secret = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const patSecret = 'github_pat_' + 'B'.repeat(40)
  const urlSecret = `https://${secret}@github.com/JozzyAI/fin_bot.git`
  const p = writeHandoff(rec, 'claude-code', 'codex', 'session_limit', `boom token=${secret} pat=${patSecret} remote=${urlSecret}`)
  const body = fs.readFileSync(p, 'utf8')

  assert.match(body, /# Handoff/)
  assert.match(body, /JOZ-99/)
  assert.match(body, /Do the thing/)
  assert.match(body, /feature\/x/)
  assert.match(body, /session_limit/)
  assert.match(body, /Next action/)
  assert.ok(!body.includes(secret), 'handoff must not contain the raw ghp_ token')
  assert.ok(!body.includes(patSecret), 'handoff must not contain the raw github_pat_ token')
  assert.doesNotMatch(body, /[A-Za-z0-9_]+@github\.com/, 'handoff must not contain a token in a remote URL')
  assert.match(body, /\[REDACTED\]/)
})

// ════════════════════════════ Integration ═════════════════════════════════

test('no fallback: claude completes — behaves like a single-agent run', () => {
  const pf = promptFile('hello')
  const start = vibe(baseEnv, 'run', 'start', '--agent', 'claude-code', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const rec = JSON.parse(start.stdout.trim()) as RunRecord
  assert.equal(rec.status, 'running')
  // no agent_policy metadata stored when no fallback requested
  assert.equal(rec.metadata?.agent_policy, undefined)

  const stream = vibeTimeout(baseEnv, 'run', 'stream', rec.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)
  assert.equal((events[events.length - 1] as StatusEvent).status, 'completed')

  const final = JSON.parse(vibe(baseEnv, 'run', 'status', rec.run_id).stdout.trim()) as RunRecord
  assert.equal(final.status, 'completed')
  assert.equal(final.started_agent, 'claude-code')
  assert.equal(final.final_agent, 'claude-code')
  assert.equal(final.switched, false)
})

test('--fallback-agent packs metadata.agent_policy on the record', () => {
  const pf = promptFile('hello')
  const start = vibe(baseEnv, 'run', 'start', '--agent', 'mock', '--fallback-agent', 'codex', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const rec = JSON.parse(start.stdout.trim()) as RunRecord
  const policy = (rec.metadata as Record<string, { fallbacks: string[] }>).agent_policy
  assert.ok(policy, 'agent_policy present')
  assert.deepEqual(policy.fallbacks, ['codex'])
})

test('primary completes with a fallback configured → no switch', () => {
  const pf = promptFile('hello')
  const start = vibe(baseEnv, 'run', 'start', '--agent', 'claude-code', '--fallback-agent', 'mock', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const rec = JSON.parse(start.stdout.trim()) as RunRecord
  vibeTimeout(baseEnv, 'run', 'stream', rec.run_id, '--jsonl')
  const final = JSON.parse(vibe(baseEnv, 'run', 'status', rec.run_id).stdout.trim()) as RunRecord
  assert.equal(final.status, 'completed')
  assert.equal(final.final_agent, 'claude-code')
  assert.equal(final.switched, false)
})

test('primary fails session_limit → falls back to mock, one run_id, one terminal status', () => {
  const pf = promptFile('build the feature')
  const env = { ...baseEnv, FAKE_CLAUDE_EXIT_CODE: '1', FAKE_CLAUDE_RAW_LINE: "You've hit your session limit" }
  const start = vibe(env, 'run', 'start', '--agent', 'claude-code', '--fallback-agent', 'mock', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const rec = JSON.parse(start.stdout.trim()) as RunRecord
  const startWs = rec.workspace_path

  const stream = vibeTimeout(env, 'run', 'stream', rec.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)

  // exactly one terminal status, and it is completed
  const terminal = events.filter((e) => e.type === 'status' && ['completed', 'failed', 'stopped', 'cancelled'].includes((e as StatusEvent).status))
  assert.equal(terminal.length, 1, 'exactly one terminal status')
  assert.equal((terminal[0] as StatusEvent).status, 'completed')
  // a switch log was emitted
  assert.ok(events.some((e) => e.type === 'log' && /switching agent/.test((e as { message: string }).message)), 'switch log present')

  const final = JSON.parse(vibe(env, 'run', 'status', rec.run_id).stdout.trim()) as RunRecord
  assert.equal(final.status, 'completed')
  assert.equal(final.started_agent, 'claude-code')
  assert.equal(final.final_agent, 'mock')
  assert.equal(final.switched, true)
  assert.equal(final.switch_reason, 'session_limit')
  assert.equal(final.workspace_path, startWs, 'workspace preserved across switch')

  // handoff written and contains the original task + handoff header
  assert.ok(final.handoff_path && fs.existsSync(final.handoff_path), 'handoff file exists')
  const handoff = fs.readFileSync(final.handoff_path!, 'utf8')
  assert.match(handoff, /# Handoff/)
  assert.match(handoff, /session_limit/)

  // fallback prompt = handoff + original task
  const fallbackPrompt = path.join(VIBE_DIR, 'handoff', `${rec.run_id}.fallback.prompt.md`)
  assert.ok(fs.existsSync(fallbackPrompt), 'fallback prompt file exists')
  const fp = fs.readFileSync(fallbackPrompt, 'utf8')
  assert.match(fp, /# Handoff/)
  assert.match(fp, /build the feature/)
})

test('primary fails non-recoverable (tests_failed) → stays failed, no switch', () => {
  const pf = promptFile('do work')
  const env = { ...baseEnv, FAKE_CLAUDE_EXIT_CODE: '1', FAKE_CLAUDE_RAW_LINE: '3 tests failed' }
  const start = vibe(env, 'run', 'start', '--agent', 'claude-code', '--fallback-agent', 'mock', '--workspace-key', uniqueKey(), '--prompt-file', pf)
  assert.equal(start.status, 0, `start failed: ${start.stderr}`)
  const rec = JSON.parse(start.stdout.trim()) as RunRecord

  const stream = vibeTimeout(env, 'run', 'stream', rec.run_id, '--jsonl')
  const events = parseEvents(stream.stdout)
  assert.ok(!events.some((e) => e.type === 'log' && /switching agent/.test((e as { message: string }).message)), 'no switch on non-recoverable')
  assert.equal((events[events.length - 1] as StatusEvent).status, 'failed')

  const final = JSON.parse(vibe(env, 'run', 'status', rec.run_id).stdout.trim()) as RunRecord
  assert.equal(final.status, 'failed')
  assert.equal(final.final_agent, 'claude-code')
  assert.equal(final.switched, false)
  assert.equal(final.failure_reason, 'tests_failed')
  assert.equal(final.recoverable, false)
})
