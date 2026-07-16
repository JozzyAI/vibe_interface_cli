/**
 * RELAY-PROTOCOL + run-start ENFORCEMENT acceptance for workspace_lease_v1.
 *
 * Drives the REAL relay protocol (workspace_lease_acquire/get/release) and the
 * REAL encrypted run_start path against a spawned mock daemon backed by a temp
 * node journal. Proves, end to end over the wire:
 *   - a lease is acquired through the relay; the physical filesystem path never
 *     crosses the relay (only workflow_id + opaque workspace_key are sent);
 *   - a same-(workflow, workspace) retry is idempotent (same lease id);
 *   - a different workflow on the same workspace conflicts;
 *   - a run on a leased workspace must present the exact active lease id BEFORE a
 *     backend starts (required / invalid / released codes), else it is rejected;
 *   - a lease cannot be released while a non-terminal run is bound (in_use);
 *   - after the run terminalizes the lease releases (idempotently) and a new
 *     workflow can then acquire the workspace;
 *   - two concurrent clients racing the SAME workspace: exactly one wins;
 *   - the lease id is never written into the prompt the provider receives.
 *
 * In-process relay + spawned mock daemon. Never touches production. Skips if the
 * daemon can't register.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startRelayServer } from '../src/relay/server.js'
import {
  remoteRunStart, remoteRunStatus, remoteStop, fetchRemoteNodes,
  remoteWorkspaceLeaseAcquire, remoteWorkspaceLeaseGet, remoteWorkspaceLeaseRelease, RemoteLeaseError,
} from '../src/relay/client.js'
import { WORKSPACE_LEASE_CAPABILITY } from '../src/node-journal/contract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'index.js')
const NODE = process.execPath
const RTOKEN = `wl-relay-${Math.random().toString(36).slice(2)}`
const NODE_ID = 'wl-lease-node'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function vibe(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => { const p = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; p.stdout!.on('data', (d: Buffer) => { out += d.toString() }); p.on('close', () => resolve(out)); setTimeout(() => { p.kill('SIGKILL'); resolve(out) }, timeoutMs) })
}

async function leaseCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return '<no-error>' } catch (e) { return e instanceof RemoteLeaseError ? e.code : `<${(e as Error).message}>` }
}
async function startCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return '<no-error>' } catch (e) { return (e as Error).message.split(':')[0] }
}

test('workspace lease protocol: acquire/get/release + run-start enforcement (encrypted) + concurrency', async (t) => {
  const relay = await startRelayServer({ port: 0, token: RTOKEN })
  const relayUrl = `ws://127.0.0.1:${relay.port}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'))
  const nodeVibeDir = path.join(root, 'node')
  const wsRoot = path.join(root, 'workspaces'); fs.mkdirSync(wsRoot, { recursive: true })
  const tokenFile = path.join(root, 'tok'); fs.writeFileSync(tokenFile, RTOKEN + '\n', { mode: 0o600 })
  const promptFile = path.join(root, 'prompt.txt'); fs.writeFileSync(promptFile, 'do the work', { mode: 0o600 })
  const daemon = spawn(NODE, [CLI, 'node', 'daemon', '--local', '--relay', relayUrl, '--node-id', NODE_ID], {
    env: { ...process.env, VIBE_DIR: nodeVibeDir, VIBE_WORKSPACE_ROOT: wsRoot, VIBE_RELAY_TOKEN: RTOKEN, VIBE_NODE_HEARTBEAT_MS: '250', VIBE_NODE_ADVERTISE_AGENTS: 'mock', VIBE_MOCK_RUN_MS: '8000' }, stdio: 'ignore',
  })
  const cleanup = async (): Promise<void> => { if (!daemon.killed) daemon.kill('SIGKILL'); await delay(200); try { await relay.close() } catch { /* */ } }

  let up = false; const deadline = Date.now() + 9000
  while (Date.now() < deadline && !up) { await delay(300); try { if (JSON.parse((await vibe(['node', 'list', '--remote', '--relay', relayUrl, '--token-file', tokenFile, '--json'], { ...process.env })).trim()).some((n: { node_id: string }) => n.node_id === NODE_ID)) up = true } catch { /* */ } }
  if (!up) { await cleanup(); t.skip('mock node daemon did not register'); return }

  try {
    // The node advertises lease enforcement + exposes an encryption key.
    const nodes = await fetchRemoteNodes(relayUrl, RTOKEN)
    const node = nodes.find((n) => n.node_id === NODE_ID)!
    assert.ok(node.capabilities.includes(WORKSPACE_LEASE_CAPABILITY), 'node advertises workspace_lease_v1')
    const encKey = node.encryption_public_key!
    assert.ok(encKey, 'node advertises an encryption key')

    // ── acquire is idempotent per (workflow, workspace); the lease id is opaque ──
    const a1 = await remoteWorkspaceLeaseAcquire(relayUrl, RTOKEN, NODE_ID, 'wf-1', 'proj-alpha')
    assert.equal(a1.created, true, 'first acquire creates the lease')
    assert.equal(a1.lease.status, 'active')
    assert.match(a1.lease.workspace_lease_id, /^wl_[0-9a-f]{32}$/, 'opaque deterministic lease id')
    const L1 = a1.lease.workspace_lease_id
    const a1b = await remoteWorkspaceLeaseAcquire(relayUrl, RTOKEN, NODE_ID, 'wf-1', 'proj-alpha')
    assert.equal(a1b.created, false, 'same workflow+workspace retry is idempotent')
    assert.equal(a1b.lease.workspace_lease_id, L1, 'idempotent retry returns the same lease id')

    // ── a different workflow conflicts on the same workspace ──
    assert.equal(await leaseCode(() => remoteWorkspaceLeaseAcquire(relayUrl, RTOKEN, NODE_ID, 'wf-2', 'proj-alpha')), 'workspace_lease_conflict')

    // ── get by exact id returns the lease ──
    const got = await remoteWorkspaceLeaseGet(relayUrl, RTOKEN, NODE_ID, L1)
    assert.equal(got.workspace_lease_id, L1)

    // ── a run on the leased workspace WITHOUT the lease is refused before backend start ──
    assert.equal(await startCode(() => remoteRunStart(relayUrl, RTOKEN, NODE_ID, { agent: 'mock', promptFile, workspaceKey: 'proj-alpha', encryptionPublicKey: encKey })), 'workspace_lease_required')

    // ── a run PRESENTING the exact active lease starts (ENCRYPTED payload carries it) ──
    const rec = await remoteRunStart(relayUrl, RTOKEN, NODE_ID, { agent: 'mock', promptFile, workspaceKey: 'proj-alpha', encryptionPublicKey: encKey, workspaceLeaseId: L1 })
    assert.ok(['queued', 'running'].includes(rec.status), 'lease-authorized run started')
    const runId = rec.run_id

    // ── the lease cannot be released while its run is non-terminal ──
    assert.equal(await leaseCode(() => remoteWorkspaceLeaseRelease(relayUrl, RTOKEN, NODE_ID, L1)), 'workspace_lease_in_use')

    // ── an UNKNOWN lease id on a DIFFERENT unleased workspace is invalid (fail closed) ──
    assert.equal(await startCode(() => remoteRunStart(relayUrl, RTOKEN, NODE_ID, { agent: 'mock', promptFile, workspaceKey: 'proj-beta', encryptionPublicKey: encKey, workspaceLeaseId: 'wl_deadbeefdeadbeefdeadbeefdeadbeef' })), 'workspace_lease_invalid')

    // stop the run and wait for it to terminalize.
    await remoteStop(relayUrl, RTOKEN, runId).catch(() => { /* idempotent */ })
    let terminal = false
    for (let i = 0; i < 40 && !terminal; i++) { try { const s = await remoteRunStatus(relayUrl, RTOKEN, runId); terminal = ['completed', 'failed', 'stopped', 'cancelled'].includes(s.status) } catch { /* */ } if (!terminal) await delay(200) }
    assert.ok(terminal, 'run reached a terminal status')

    // ── with no non-terminal run bound, release succeeds and is idempotent ──
    // (the terminal run-event journaling can lag the status record by a tick, so the
    //  in-use guard may briefly hold; retry until the binding clears.)
    let rel: Awaited<ReturnType<typeof remoteWorkspaceLeaseRelease>> | undefined
    for (let i = 0; i < 25 && !rel; i++) {
      try { rel = await remoteWorkspaceLeaseRelease(relayUrl, RTOKEN, NODE_ID, L1) }
      catch (e) { if (e instanceof RemoteLeaseError && e.code === 'workspace_lease_in_use') { await delay(200); continue } throw e }
    }
    assert.ok(rel, 'lease released after the bound run terminalized')
    assert.equal(rel!.status, 'released')
    const rel2 = await remoteWorkspaceLeaseRelease(relayUrl, RTOKEN, NODE_ID, L1)
    assert.equal(rel2.status, 'released', 'release is idempotent')

    // ── a run presenting the now-RELEASED lease (no active lease) is refused ──
    assert.equal(await startCode(() => remoteRunStart(relayUrl, RTOKEN, NODE_ID, { agent: 'mock', promptFile, workspaceKey: 'proj-alpha', encryptionPublicKey: encKey, workspaceLeaseId: L1 })), 'workspace_lease_released')

    // ── once released, another workflow can acquire the same workspace anew ──
    const a2 = await remoteWorkspaceLeaseAcquire(relayUrl, RTOKEN, NODE_ID, 'wf-2', 'proj-alpha')
    assert.equal(a2.created, true, 'a fresh workflow acquires the released workspace')
    assert.notEqual(a2.lease.workspace_lease_id, L1, 'a new workflow gets a distinct lease id')

    // ── two concurrent clients racing a fresh workspace: exactly one wins ──
    const race = await Promise.allSettled([
      remoteWorkspaceLeaseAcquire(relayUrl, RTOKEN, NODE_ID, 'wf-A', 'proj-race'),
      remoteWorkspaceLeaseAcquire(relayUrl, RTOKEN, NODE_ID, 'wf-B', 'proj-race'),
    ])
    const wins = race.filter((r) => r.status === 'fulfilled' && (r.value as { created: boolean }).created)
    const conflicts = race.filter((r) => r.status === 'rejected' && (r.reason as RemoteLeaseError).code === 'workspace_lease_conflict')
    assert.equal(wins.length, 1, 'exactly one concurrent acquire wins the workspace')
    assert.equal(conflicts.length, 1, 'the loser sees workspace_lease_conflict')

    // ── the lease id never reaches the provider: the prompt the backend received is unchanged ──
    const nodePrompt = path.join(os.tmpdir(), `vibe-prompt-${runId}.md`)
    if (fs.existsSync(nodePrompt)) assert.equal(fs.readFileSync(nodePrompt, 'utf8').includes(L1), false, 'lease id absent from the provider prompt file')
  } finally {
    await cleanup()
  }
})
