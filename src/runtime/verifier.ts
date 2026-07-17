/**
 * Node/Harness-owned **task verifier** — runs a TRUSTED, Node-policy-owned test
 * command (selected by profile ID) inside a real OS sandbox after the Agent exits
 * and before the AgentTaskResult is finalized, then records structured
 * `tests_passed` / `tests_failed` evidence.
 *
 * Two gates:
 *   1. PROFILE POLICY — the command is resolved from `verifier-profiles.ts` by the
 *      step's profile ID. A spec never supplies argv/interpreter/args, so there is
 *      no arbitrary-execution surface.
 *   2. OS SANDBOX — the resolved command runs inside a `bwrap` jail (see
 *      `sandbox.ts`): writes confined to the leased workspace, external files/
 *      secrets absent, network unshared (off), children inherit the jail. If the
 *      Node cannot enforce this, the verifier capability is UNAVAILABLE and the
 *      caller fails closed BEFORE the Agent runs — never a silent degrade.
 *
 * Success is decided SOLELY by the exit code (0 => tests_passed). The captured text
 * is only hashed for integrity/idempotency; it is never scraped for correctness.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  buildTaskVerification,
  MAX_VERIFY_OUTPUT_BYTES,
  VERIFY_TIMEOUT_MS,
  validateTaskVerifyConfig,
  type TaskVerifyConfig,
  type TaskVerificationV1,
} from '../lib/task-verification.js'
import { resolveVerifierProfile } from './verifier-profiles.js'
import { detectEnforcingSandbox, wrapVerifierCommand } from './sandbox.js'

export type VerifierPreflight =
  | { ok: true; profile: string; argv: string[]; programPath: string }
  | { ok: false; code: 'invalid_config' | 'unknown_profile' | 'program_not_found' | 'sandbox_unavailable'; message: string }

/** Resolve a program to an executable path (abs/relative-with-slash checked
 *  directly; a bare name searched on PATH). */
function resolveProgram(program: string): string | null {
  const isExe = (p: string): boolean => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false } }
  if (program.includes('/')) return isExe(program) ? program : null
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) { if (dir && isExe(path.join(dir, program))) return path.join(dir, program) }
  return null
}

/**
 * Fail-closed capability check, run BEFORE the Agent launches. In order:
 *   (1) the config shape is valid and names an ADVERTISED profile,
 *   (2) the profile's program is installed,
 *   (3) an ENFORCING OS sandbox is available on this Node.
 * Any miss → fail closed; the caller must NOT run the Agent.
 */
export function verifierPreflight(config: unknown): VerifierPreflight {
  const v = validateTaskVerifyConfig(config)
  if (!v.ok) return { ok: false, code: v.code === 'unknown_profile' ? 'unknown_profile' : 'invalid_config', message: v.message }
  const profile = resolveVerifierProfile(v.value.profile)
  if (!profile) return { ok: false, code: 'unknown_profile', message: `unknown verifier profile: ${v.value.profile}` }
  const programPath = resolveProgram(profile.argv[0])
  if (!programPath) return { ok: false, code: 'program_not_found', message: `verifier program not found on PATH: ${profile.argv[0]}` }
  const det = detectEnforcingSandbox()
  if (!det.enforces) return { ok: false, code: 'sandbox_unavailable', message: `verifier sandbox unavailable: ${det.reason ?? 'no enforcing sandbox'}` }
  // The resolved, sandbox-executed argv uses the absolute program path.
  const argv = [programPath, ...profile.argv.slice(1)]
  return { ok: true, profile: profile.id, argv, programPath }
}

export interface RunVerifierOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  now?: () => string
}

/**
 * Execute the profile's verifier in `workspaceCwd` INSIDE the OS sandbox and return
 * a durable verification record. Never throws for a failing suite: a non-zero exit,
 * a timeout, or a spawn error all yield a `tests_failed` record (fail-closed).
 * Throws only if preflight fails (caller must preflight first).
 */
export async function runVerifier(config: TaskVerifyConfig, workspaceCwd: string, opts: RunVerifierOptions = {}): Promise<TaskVerificationV1> {
  const pf = verifierPreflight(config)
  if (!pf.ok) throw new Error(`verifier preflight failed (${pf.code}): ${pf.message}`)
  const wrapped = wrapVerifierCommand(pf.argv, workspaceCwd, pf.programPath)
  if (!wrapped.ok) throw new Error(`verifier sandbox unavailable: ${wrapped.message}`)
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS
  const maxBytes = opts.maxOutputBytes ?? MAX_VERIFY_OUTPUT_BYTES
  const now = opts.now ?? (() => new Date().toISOString())
  const startedAt = now()
  const outerArgv = wrapped.argv // [bwrap, …flags, --, program, args]

  return await new Promise<TaskVerificationV1>((resolve) => {
    let settled = false
    let captured = Buffer.alloc(0)
    let killedForCap = false
    let timedOut = false

    const finish = (exitCode: number, extra?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const output = (extra ? extra + '\n' : '') + captured.toString('utf8')
      resolve(buildTaskVerification({ profile: pf.profile, argv: pf.argv, exitCode, startedAt, finishedAt: now(), output }))
    }

    let child
    try {
      child = spawn(outerArgv[0], outerArgv.slice(1), { cwd: workspaceCwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true })
    } catch (err) {
      finish(127, `verifier spawn error: ${(err as Error).message}`)
      return
    }

    const onChunk = (buf: Buffer): void => {
      if (settled) return
      if (captured.length < maxBytes) {
        captured = Buffer.concat([captured, buf]).subarray(0, maxBytes)
        if (captured.length >= maxBytes && !killedForCap) { killedForCap = true; killGroup(child.pid) }
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid) }, timeoutMs)

    child.on('error', (err) => finish(127, `verifier process error: ${err.message}`))
    child.on('close', (code, signal) => {
      if (timedOut) return finish(124, `verifier timed out after ${timeoutMs}ms`)
      if (killedForCap) return finish(1, `verifier output exceeded ${maxBytes} bytes; killed`)
      finish(typeof code === 'number' ? code : 1, signal ? `verifier killed by signal ${signal}` : undefined)
    })
  })
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}
