/**
 * Node verifier-sandbox capability advertisement: `verify-sandbox` (and the
 * Node-policy-owned profile IDs it implies) are advertised ONLY when the Node's
 * enforcing sandbox probe passes, the compiler inventory exposes those profiles for
 * that Node, and compiler validation rejects an unadvertised profile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withVerifierSandboxCapability, VERIFY_SANDBOX_CAPABILITY, _resetSandboxDetectionCache } from '../src/runtime/sandbox.js'
import { VERIFIER_PROFILE_IDS } from '../src/runtime/verifier-profiles.js'
import { GatewayInventoryProvider } from '../src/workflow/compiler/inventory-gateway.js'
import { validateReady } from '../src/workflow/compiler/validate.js'
import type { Inventory } from '../src/workflow/compiler/inventory.js'

const BASE = ['run', 'stream', 'stop', 'workspace']

// ── capability composition (unit; probe injected — never weakened) ────────────
test('capability: verify-sandbox is appended ONLY when the sandbox is available; base preserved', () => {
  assert.deepEqual(withVerifierSandboxCapability(BASE, false), BASE) // probe fails → base only
  assert.deepEqual(withVerifierSandboxCapability(BASE, true), [...BASE, VERIFY_SANDBOX_CAPABILITY]) // probe passes → appended
  // preserves the full journaled set + order, no duplicate if already present
  const journaled = [...BASE, 'run_event_replay_v1', 'workspace_lease_v1']
  assert.deepEqual(withVerifierSandboxCapability(journaled, true), [...journaled, VERIFY_SANDBOX_CAPABILITY])
  assert.deepEqual(withVerifierSandboxCapability([...journaled, VERIFY_SANDBOX_CAPABILITY], true), [...journaled, VERIFY_SANDBOX_CAPABILITY])
})

test('capability: the DEFAULT (real probe) omits verify-sandbox when the sandbox is disabled/absent (fail-closed)', () => {
  const prev = process.env.VIBE_VERIFIER_SANDBOX
  process.env.VIBE_VERIFIER_SANDBOX = 'none'; _resetSandboxDetectionCache()
  try {
    assert.ok(!withVerifierSandboxCapability(BASE).includes(VERIFY_SANDBOX_CAPABILITY))
  } finally { if (prev === undefined) delete process.env.VIBE_VERIFIER_SANDBOX; else process.env.VIBE_VERIFIER_SANDBOX = prev; _resetSandboxDetectionCache() }
})

// ── compiler inventory exposes profiles for a verify-sandbox node ─────────────
test('inventory: a node advertising verify-sandbox exposes node-test profiles; a node without it exposes none', async () => {
  const mk = (caps: string[]) => new GatewayInventoryProvider({
    localAgents: ['mock'],
    fetchNodes: async () => [{ node_id: 'node_x', status: 'online', agents: ['claude-code', 'codex'], capabilities: caps }],
  })
  const withCap = await mk(['run', 'stream', 'stop', 'workspace', VERIFY_SANDBOX_CAPABILITY]).snapshot()
  for (const a of withCap.agents.filter((a) => a.node_id === 'node_x')) assert.deepEqual(a.verifier_profiles, [...VERIFIER_PROFILE_IDS])
  assert.ok((withCap.agents.find((a) => a.node_id === 'node_x')!.verifier_profiles ?? []).includes('node-test'))

  const withoutCap = await mk(['run', 'stream', 'stop', 'workspace']).snapshot()
  for (const a of withoutCap.agents.filter((a) => a.node_id === 'node_x')) assert.deepEqual(a.verifier_profiles, [])
  // local (in-process) agents never advertise verifier profiles
  assert.deepEqual(withoutCap.agents.find((a) => a.node_id === undefined)!.verifier_profiles ?? [], [])
})

// ── compiler validation gates a verify step on the advertised profile ─────────
const specWithVerify = (profile: string) => ({
  version: '1', name: 'v', entry_step: 'go', inputs: { ws: { type: 'string', required: true } },
  agents: { coder: { agent: 'codex', node_id: 'node_x' } },
  output_schemas: { o: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
  limits: { max_tasks: 1, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
  steps: [{ id: 'go', type: 'agent_task', agent_role: 'coder', permission_mode: 'default', workspace_key_template: '{{ inputs.ws }}', prompt_template: 'do', output_schema: 'o', verify: { profile } }],
  edges: [{ from: 'go', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
  completion_policy: { require_tests_passed: true },
})
const invFor = (verifierProfiles: string[]): Inventory => ({
  observed_at: '2026-01-01T00:00:00Z',
  agents: [{ agent: 'codex', node_id: 'node_x', permission_modes: ['default'], workspace_supported: true, capabilities: ['run', 'workspace'], verifier_profiles: verifierProfiles }],
})

test('validate: an ADVERTISED verifier profile passes; an UNADVERTISED / unknown profile is rejected before execution', () => {
  const ok = validateReady(specWithVerify('node-test'), { ws: 'my-ws' }, invFor(['node-test']))
  assert.equal(ok.ok, true)

  const unadvertised = validateReady(specWithVerify('node-test'), { ws: 'my-ws' }, invFor([]))
  assert.equal(unadvertised.ok, false)
  assert.ok((unadvertised as { issues: { code: string }[] }).issues.some((i) => i.code === 'verifier_profile_not_advertised'))

  // an unknown profile id is rejected by the spec validator (structural) — never reaches execution
  const unknown = validateReady(specWithVerify('totally-unknown'), { ws: 'my-ws' }, invFor(['node-test']))
  assert.equal(unknown.ok, false)
})
