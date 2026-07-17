/**
 * OS-level sandbox for the Harness test verifier.
 *
 * `cwd`, `shell:false`, env scrubbing and a pinned HOME are NOT isolation — the
 * verifier runs the repository's own (agent-produced) test code, which could read
 * secrets, write outside the workspace, open sockets, or spawn helpers. This module
 * wraps the verifier command in a real OS sandbox so that:
 *   - writes are confined to the leased workspace (everything else read-only / absent)
 *   - workspace-external files/secrets are not bind-mounted → inaccessible
 *   - the network namespace is unshared → no connectivity at all
 *   - a new PID namespace + die-with-parent → child processes inherit the jail
 *   - a cleared env → no secret/credential leakage
 *
 * Enforcement is done by `bwrap` (bubblewrap), a standard unprivileged sandbox.
 * Availability is not assumed: `detectEnforcingSandbox()` PROBES a real jail and
 * verifies that an out-of-workspace write AND a network connect are BOTH blocked.
 * Only then is the sandbox trusted. If no enforcing sandbox is available the caller
 * MUST fail closed — we never "degrade" to env-scrubbing-only and we never claim
 * network-off without having observed it blocked.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export type SandboxBackend = 'bwrap' | 'none'

export interface SandboxDetection {
  backend: SandboxBackend
  /** True ONLY when a live probe observed BOTH an out-of-workspace write and a
   *  network connect being blocked inside the jail. */
  enforces: boolean
  reason?: string
}

/** Capability advertised to peers/inventory when — and only when — an enforcing
 *  verifier sandbox is present. */
export const VERIFY_SANDBOX_CAPABILITY = 'verify-sandbox'

function which(prog: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const c = path.join(dir, prog)
    try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c } catch { /* keep looking */ }
  }
  return null
}

/** Standard top-level dirs bound READ-ONLY (only if present). The workspace is the
 *  only writable path; nothing under /home, /root, /etc, /var, … is exposed. */
const RO_SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32']

/**
 * Build the argv that runs `innerArgv` inside a bwrap jail rooted at `workspace`.
 * `programPath` is the host-resolved absolute path of the program (its directory is
 * bound read-only so a non-system-path interpreter is still reachable).
 */
export function buildBwrapArgv(bwrap: string, innerArgv: readonly string[], workspace: string, programPath: string): string[] {
  const args: string[] = [
    bwrap,
    '--unshare-all',        // net + pid + ipc + uts + user + cgroup namespaces (network OFF)
    '--die-with-parent',    // children die with the sandbox → no lingering escapees
    '--new-session',        // detach controlling terminal (no TIOCSTI injection)
    '--clearenv',           // drop every inherited variable (no secrets/tokens/proxies)
    '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'HOME', workspace,
    '--setenv', 'CI', '1',
    '--setenv', 'npm_config_offline', 'true',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ]
  for (const d of RO_SYSTEM_DIRS) { if (fs.existsSync(d)) args.push('--ro-bind', d, d) }
  // Make the program reachable even if it lives outside the standard dirs (nvm, etc.).
  const progDir = path.dirname(programPath)
  if (!RO_SYSTEM_DIRS.some((d) => progDir === d || progDir.startsWith(d + '/'))) args.push('--ro-bind', progDir, progDir)
  args.push('--bind', workspace, workspace, '--chdir', workspace, '--')
  return args.concat(innerArgv as string[])
}

const PROBE_SCRIPT = `
const fs=require('fs'),net=require('net');
let outside='/etc/vibe_sandbox_probe_'+process.pid, wrote=false, connected=false;
try{ fs.writeFileSync(outside,'x'); wrote=true; try{fs.unlinkSync(outside)}catch(e){} }catch(e){}
const s=net.connect({host:'127.0.0.1',port:9},()=>{connected=true;fin()});
s.on('error',()=>fin()); setTimeout(fin,1200);
let done=false;
function fin(){ if(done)return; done=true; try{s.destroy()}catch(e){}
  process.stdout.write(JSON.stringify({fs_confined:!wrote, network_off:!connected})); process.exit(0); }
`

let cached: SandboxDetection | null = null

/** Detect and VERIFY an enforcing sandbox (cached per process). A test/edge override
 *  `VIBE_VERIFIER_SANDBOX=none` forces "unavailable" (to exercise fail-closed). */
export function detectEnforcingSandbox(nodeBin: string = process.execPath): SandboxDetection {
  if (cached) return cached
  if (process.env.VIBE_VERIFIER_SANDBOX === 'none') return (cached = { backend: 'none', enforces: false, reason: 'disabled by VIBE_VERIFIER_SANDBOX=none' })
  const bwrap = which('bwrap')
  if (!bwrap) return (cached = { backend: 'none', enforces: false, reason: 'no bubblewrap (bwrap) sandbox available' })
  // Live enforcement probe: BOTH an out-of-workspace write and a network connect
  // must be blocked, or we do not trust the sandbox.
  let probeWs: string | undefined
  try {
    probeWs = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-sbx-probe-'))
    const argv = buildBwrapArgv(bwrap, [nodeBin, '-e', PROBE_SCRIPT], probeWs, nodeBin)
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 8000 })
    if (r.status !== 0 || !r.stdout) return (cached = { backend: 'none', enforces: false, reason: `sandbox probe did not run cleanly (${r.error?.message ?? 'exit ' + r.status})` })
    let parsed: { fs_confined?: unknown; network_off?: unknown }
    try { parsed = JSON.parse(r.stdout.trim()) } catch { return (cached = { backend: 'none', enforces: false, reason: 'sandbox probe output unparseable' }) }
    const enforces = parsed.fs_confined === true && parsed.network_off === true
    return (cached = enforces ? { backend: 'bwrap', enforces: true } : { backend: 'none', enforces: false, reason: `sandbox probe did not confine (fs=${parsed.fs_confined}, net_off=${parsed.network_off})` })
  } catch (err) {
    return (cached = { backend: 'none', enforces: false, reason: `sandbox probe error: ${(err as Error).message}` })
  } finally {
    if (probeWs) { try { fs.rmSync(probeWs, { recursive: true, force: true }) } catch { /* */ } }
  }
}

/** Reset the cached detection (tests only). */
export function _resetSandboxDetectionCache(): void { cached = null }

/** True when this Node can enforce the verifier sandbox profile. */
export function sandboxCapabilityAvailable(): boolean { return detectEnforcingSandbox().enforces }

/**
 * Append the verifier-sandbox capability to a Node's base capabilities IFF this Node
 * can enforce the verifier sandbox (the live probe passed). The base capabilities are
 * preserved unchanged. `available` defaults to the REAL probe result — callers pass it
 * only in unit tests; the default never weakens the probe.
 *
 * Callers evaluate this at Node STARTUP (register/heartbeat), and the probe result is
 * cached per process, so installing or removing bubblewrap requires a Node restart to
 * re-evaluate the advertised capability.
 */
export function withVerifierSandboxCapability(base: readonly string[], available: boolean = sandboxCapabilityAvailable()): string[] {
  return available && !base.includes(VERIFY_SANDBOX_CAPABILITY) ? [...base, VERIFY_SANDBOX_CAPABILITY] : [...base]
}

export type SandboxWrap =
  | { ok: true; argv: string[]; backend: SandboxBackend }
  | { ok: false; code: 'sandbox_unavailable'; message: string }

/** Wrap a resolved verifier command for execution inside the enforcing sandbox.
 *  Fails closed if no enforcing sandbox is present. */
export function wrapVerifierCommand(innerArgv: readonly string[], workspace: string, programPath: string): SandboxWrap {
  const det = detectEnforcingSandbox()
  if (!det.enforces) return { ok: false, code: 'sandbox_unavailable', message: det.reason ?? 'no enforcing verifier sandbox' }
  const bwrap = which('bwrap')!
  return { ok: true, argv: buildBwrapArgv(bwrap, innerArgv, workspace, programPath), backend: 'bwrap' }
}
