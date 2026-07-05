/**
 * Minimal tmux helpers used by the NODE daemon's remote-terminal bridge. Every
 * call uses a spawned ARGUMENT ARRAY (no shell, no interpolation) so session
 * names and keystrokes can never be interpreted by a shell. Keystroke `data` is
 * passed straight to send-keys and is NEVER logged here.
 *
 * These intentionally duplicate the tiny tmux calls the LOCAL terminal
 * (terminal-web.ts) makes inline, rather than importing that WS/HTTP-heavy
 * module into the daemon.
 */
import { spawnSync } from 'child_process'

/** True if the tmux binary is usable at all. */
export function tmuxAvailable(): boolean {
  try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0 } catch { return false }
}

/** True if a session with this exact name exists on the default tmux server. */
export function tmuxHasSession(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0
}

/** Capture the visible pane WITH escape sequences (-e), for xterm rendering. */
export function tmuxCapturePane(session: string): { ok: boolean; pane: string } {
  const r = spawnSync('tmux', ['capture-pane', '-p', '-e', '-t', session], { encoding: 'utf8' })
  return { ok: r.status === 0, pane: r.stdout ?? '' }
}

/** Send literal keystrokes (no shell). Never log `data`. */
export function tmuxSendKeys(session: string, data: string): void {
  spawnSync('tmux', ['send-keys', '-t', session, '-l', '--', data], { stdio: 'ignore' })
}

/** Best-effort window resize; a detached session may clamp — errors ignored. */
export function tmuxResizeWindow(session: string, cols: number, rows: number): void {
  spawnSync('tmux', ['resize-window', '-t', session, '-x', String(cols), '-y', String(rows)], { stdio: 'ignore' })
}

// ── session lifecycle (create / list / kill) — Vibe-owned only ───────────────

/** tmux user-option that marks a session as created (and owned) by Vibe. */
const OWNED_OPT = '@vibe_owned'

/**
 * Strict session-name allow-list. Discrete `-t <name>` arg + this guard means a
 * name can never inject a tmux flag/target or reach a shell: letters/digits to
 * start, then letters/digits/`_`/`-`, 1–64 chars. Rejects spaces, `;`, `:`,
 * leading `-`, empty, and over-long names.
 */
export function isSafeSessionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
}

/**
 * Create a detached login-shell session and STAMP it Vibe-owned. Fixed command
 * (`bash -l`) — no caller-supplied command, no shell interpolation. Returns
 * false if the name is unsafe or tmux refuses.
 */
export function tmuxCreateOwnedSession(name: string): boolean {
  if (!isSafeSessionName(name)) return false
  const created = spawnSync('tmux', ['new-session', '-d', '-s', name, 'bash -l'], { stdio: 'ignore' })
  if (created.status !== 0) return false
  spawnSync('tmux', ['set-option', '-t', name, OWNED_OPT, '1'], { stdio: 'ignore' })
  return true
}

/** True only if the session exists AND carries the Vibe-owned marker. */
export function tmuxIsOwned(name: string): boolean {
  if (!isSafeSessionName(name)) return false
  const r = spawnSync('tmux', ['show-options', '-v', '-t', name, OWNED_OPT], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim() === '1'
}

/** Names of all Vibe-owned sessions on the default tmux server. */
export function tmuxListOwnedSessions(): string[] {
  // value-first (tab) so an odd session name can't shift the parse.
  const r = spawnSync('tmux', ['list-sessions', '-F', `#{${OWNED_OPT}}\t#{session_name}`], { encoding: 'utf8' })
  if (r.status !== 0) return []
  return r.stdout.split('\n')
    .filter((l) => l.startsWith('1\t'))
    .map((l) => l.slice(2))
}

/**
 * Kill a session — but ONLY if it is Vibe-owned (never `vibe-node`, a user
 * session, or the tmux server). Returns 'killed' | 'not_owned' | 'missing'.
 */
export function tmuxKillOwnedSession(name: string): 'killed' | 'not_owned' | 'missing' {
  if (!tmuxHasSession(name)) return 'missing'
  if (!tmuxIsOwned(name)) return 'not_owned'
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
  return 'killed'
}
