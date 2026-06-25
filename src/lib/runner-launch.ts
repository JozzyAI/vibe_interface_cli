/**
 * Shared launcher for the per-run supervisor process.
 *
 * Every backend (mock / claude-code / codex) starts the same hidden
 * `_supervisor <run_id>` entry point. By default the supervisor is a detached
 * background process and its `session_id` is that process PID — stable,
 * persisted in the run record, and killable by `vibe run stop`.
 *
 * Opt-in tmux lifecycle (VIBE_USE_TMUX=1): the supervisor is launched inside a
 * detached tmux session named `vibe-run-<run_id>` so a user can
 * `vibe run attach <run_id>` and watch it live. In that mode `session_id` is the
 * tmux session name instead of a PID. tmux is OPTIONAL — if it is unavailable or
 * the launch fails, we fall back to the detached-process path, so behaviour is
 * unchanged on machines/CI without tmux.
 *
 * Security: tmux receives forwarded env via `-e KEY=VALUE`, which is visible in
 * the `tmux new-session` argv (e.g. in `ps`). We therefore forward only a
 * non-secret allowlist (VIBE_DIR, PATH, VIBE_MOCK_*). Secrets such as relay
 * tokens are never placed on the tmux argv. Local runs never need them anyway.
 */
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.resolve(__dirname, '..', 'index.js')

/** Deterministic, stable tmux session name for a run. */
export function tmuxSessionName(run_id: string): string {
  return `vibe-run-${run_id}`
}

/** True if tmux-backed sessions are requested and tmux is on PATH. */
function tmuxEnabled(): boolean {
  if (process.env.VIBE_USE_TMUX !== '1') return false
  const probe = spawnSync('tmux', ['-V'], { stdio: 'ignore' })
  return probe.status === 0
}

/**
 * Env vars safe to forward onto the tmux argv. Explicitly excludes anything
 * secret (tokens, keys); only the test/runtime knobs the local supervisor needs.
 */
function forwardableEnv(): string[] {
  const args: string[] = []
  for (const key of Object.keys(process.env)) {
    const forward = key === 'VIBE_DIR' || key === 'PATH' || key.startsWith('VIBE_MOCK_')
    const value = process.env[key]
    if (forward && value != null) args.push('-e', `${key}=${value}`)
  }
  return args
}

export interface LaunchResult {
  session_id: string
}

/**
 * Launch the supervisor for `run_id` and return its stable session reference.
 * tmux session name when tmux-backed, otherwise the detached process PID.
 */
export function launchSupervisor(run_id: string): LaunchResult {
  if (tmuxEnabled()) {
    const session = tmuxSessionName(run_id)
    const result = spawnSync(
      'tmux',
      ['new-session', '-d', '-s', session, ...forwardableEnv(), '--', process.execPath, ENTRY, '_supervisor', run_id],
      { stdio: 'ignore' },
    )
    if (result.status === 0) return { session_id: session }
    // tmux unavailable / too old / failed — fall through to detached process.
  }

  const child = spawn(process.execPath, [ENTRY, '_supervisor', run_id], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return { session_id: String(child.pid ?? 0) }
}
