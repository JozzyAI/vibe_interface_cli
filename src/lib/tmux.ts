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
