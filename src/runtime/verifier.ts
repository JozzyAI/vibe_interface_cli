/**
 * Node/Harness-owned **task verifier** — runs a TRUSTED, spec-declared test command
 * after the Agent exits and before the AgentTaskResult is finalized, then records
 * structured `tests_passed` / `tests_failed` evidence.
 *
 * Enforced sandbox (a spec author supplies ONLY an argv; everything below is fixed
 * by the harness and cannot be widened from the spec):
 *   - NO shell: `spawn(argv[0], argv.slice(1), { shell: false })` — no expansion,
 *     globbing, pipes, redirection, `&&`, or command substitution.
 *   - FIXED cwd: the leased workspace path (the verifier cannot run elsewhere).
 *   - SCRUBBED env: a tiny allowlist (PATH/HOME/LANG/…); every inherited secret,
 *     token, and proxy/credential variable is dropped — no secret or arbitrary env
 *     injection, and no network credentials are handed to the command.
 *   - BOUNDED output: stdout+stderr captured up to a byte cap (then the child is
 *     killed) — the capture is hashed but NEVER parsed for correctness.
 *   - BOUNDED runtime: a hard wall-clock timeout kills the process group.
 *   - detached process GROUP so a timeout kill reaps children too.
 *
 * Success is decided SOLELY by the exit code (0 ⇒ tests_passed). The captured text
 * is only hashed for integrity/idempotency; it is never scraped to infer semantic
 * correctness, and Agent-reported results are never consulted.
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

/** The only environment variables a verifier inherits. Everything else (API keys,
 *  tokens, cloud creds, HTTP(S)_PROXY, GIT_* auth, npm auth, …) is dropped. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SHLVL', 'TERM']

function scrubbedEnv(cwd: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const k of ENV_ALLOWLIST) { const v = process.env[k]; if (typeof v === 'string') out[k] = v }
  // Fixed, workspace-local HOME so the command cannot read the caller's dotfiles/creds.
  out.HOME = cwd
  // Best-effort "offline" hints for common toolchains (belt-and-suspenders; the real
  // guarantee is that NO network credentials are present in this env).
  out.npm_config_offline = 'true'
  out.CI = '1'
  return out
}

export type VerifierPreflight =
  | { ok: true; program: string }
  | { ok: false; code: 'invalid_config' | 'program_not_found'; message: string }

/**
 * Fail-closed capability check, run BEFORE the Agent launches. Confirms the config
 * is well-formed and that `argv[0]` resolves to an executable (absolute path, or on
 * PATH). If verification is required but cannot run, the caller must fail the run
 * WITHOUT executing the Agent — never a "completed" that can't be verified.
 */
export function verifierPreflight(config: unknown): VerifierPreflight {
  const v = validateTaskVerifyConfig(config)
  if (!v.ok) return { ok: false, code: 'invalid_config', message: v.message }
  const program = v.value.argv[0]
  const resolved = resolveProgram(program, scrubbedEnv(process.cwd()).PATH ?? '')
  if (!resolved) return { ok: false, code: 'program_not_found', message: `verifier program not found on PATH: ${program}` }
  return { ok: true, program: resolved }
}

/** Resolve a program to an executable path (absolute/relative-with-slash checked
 *  directly; a bare name searched on PATH). Returns null if not runnable. */
function resolveProgram(program: string, pathEnv: string): string | null {
  const isExecutable = (p: string): boolean => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false } }
  if (program.includes('/')) return isExecutable(program) ? program : null
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const cand = path.join(dir, program)
    if (isExecutable(cand)) return cand
  }
  return null
}

export interface RunVerifierOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  /** injectable clock for deterministic tests */
  now?: () => string
}

/**
 * Execute the verifier in `workspaceCwd` and return a durable verification record.
 * Never throws for a failing test suite: a non-zero exit, a timeout, or a spawn
 * error all yield a `tests_failed` record (fail-closed). Throws ONLY if the config
 * is structurally invalid (caller should preflight first).
 */
export async function runVerifier(config: TaskVerifyConfig, workspaceCwd: string, opts: RunVerifierOptions = {}): Promise<TaskVerificationV1> {
  const v = validateTaskVerifyConfig(config)
  if (!v.ok) throw new Error(`invalid verifier config: ${v.message}`)
  const argv = v.value.argv
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS
  const maxBytes = opts.maxOutputBytes ?? MAX_VERIFY_OUTPUT_BYTES
  const now = opts.now ?? (() => new Date().toISOString())
  const startedAt = now()

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
      resolve(buildTaskVerification({ argv, exitCode, startedAt, finishedAt: now(), output }))
    }

    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: workspaceCwd,
        env: scrubbedEnv(workspaceCwd),
        shell: false,               // NO shell — argv is executed verbatim
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,             // own process group → killpg on timeout
        windowsHide: true,
      })
    } catch (err) {
      // e.g. ENOENT — treat as a failed (non-zero) verification, fail-closed.
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
      // A signal-terminated process (no numeric code) counts as failure.
      finish(typeof code === 'number' ? code : 1, signal ? `verifier killed by signal ${signal}` : undefined)
    })
  })
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}
