/**
 * Controlled environment for spawned real-agent CLIs.
 *
 * The real-agent canary reproduced the JOZ-32 root cause: a Claude Code agent
 * working over a WSL workspace resolved git credentials through the *Windows*
 * Git Credential Manager (personal account `ZhaoyiLi`) instead of the WSL `gh`
 * helper (`JozzyAI`). It happened because Windows `git.exe` was reachable on the
 * inherited PATH (`/mnt/c/Program Files/Git/cmd`) and the agent operated via
 * `\\wsl.localhost\...` paths, so its `git push` used the Windows credential
 * stack and was rejected with HTTP 403.
 *
 * This module builds the environment we hand to agent processes so that every
 * git operation deterministically uses WSL git + the controlled `gh` credential
 * helper, and can never fall through to the Windows GCM / personal-account path.
 *
 * Secret hygiene: no token VALUES are placed in the environment. We force the
 * `gh auth git-credential` helper, which streams the token to git over the
 * credential protocol — it never lands in argv, a remote URL, or a log line.
 */
import fs from 'fs'

/** Git config entries injected via the GIT_CONFIG_COUNT/KEY/VALUE env protocol.
 *  These take precedence over any repo/global/system config (including a Windows
 *  GCM `credential.helper = manager`). The empty `credential.helper` reset MUST
 *  come first: it clears any inherited helper list, after which the github.com
 *  helper is the only one that applies for github.com. */
export const AGENT_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // Reset: drop any inherited credential helper (incl. Windows Git Credential Manager).
  ['credential.helper', ''],
  // Force the controlled WSL gh helper for github.com (resolves to the JozzyAI account).
  ['credential.https://github.com.helper', '!/usr/bin/gh auth git-credential'],
  // Controlled commit identity so agent commits never fail for a missing git identity.
  ['user.name', 'JozzyAI Vibe Agent'],
  ['user.email', 'actions@users.noreply.github.com'],
]

/** True when running under WSL (Windows interop reachable, so git.exe / GCM is a risk). */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  try {
    const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase()
    return v.includes('microsoft') || v.includes('wsl')
  } catch {
    return false
  }
}

/**
 * Whether to apply agent git hardening. Default-on under WSL (where the Windows
 * GCM fallback exists); overridable via VIBE_AGENT_GIT_HARDENING=1|0 so non-WSL
 * / CI runs stay byte-compatible and the live node can be toggled if needed.
 */
export function gitHardeningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.VIBE_AGENT_GIT_HARDENING
  if (flag === '1' || flag === 'true') return true
  if (flag === '0' || flag === 'false') return false
  return isWsl()
}

/**
 * Remove Windows Git directories from a PATH so a bare `git` can only resolve to
 * the WSL binary (/usr/bin/git), and guarantee /usr/bin and /bin precede any
 * retained Windows-interop entry. Non-WSL: returned unchanged.
 */
export function sanitizePath(rawPath: string | undefined, isWslHost: boolean): string {
  const raw = rawPath ?? ''
  if (!isWslHost) return raw

  const entries = raw.split(':').filter(Boolean)
  // Drop any Windows-interop entry that is a Git install dir (would resolve to git.exe),
  // e.g. /mnt/c/Program Files/Git/cmd, /mnt/c/Program Files/Git/bin, .../Git/mingw64/bin.
  const filtered = entries.filter((e) => !(e.startsWith('/mnt/') && /\/git\//i.test(e)))

  // Hoist core WSL bins to the front so /usr/bin/git always wins over any retained
  // Windows path, and so they are present even if the inherited PATH omitted them.
  const core = ['/usr/bin', '/bin']
  const rest = filtered.filter((e) => !core.includes(e))
  return [...core, ...rest].join(':')
}

/**
 * Build the environment for a spawned agent process. When hardening is enabled,
 * this sanitizes PATH, disables interactive git prompts (fail-closed), and
 * injects the controlled git credential helper + identity. When disabled it
 * returns a copy of the base env unchanged.
 */
export function buildAgentEnv(
  baseEnv: NodeJS.ProcessEnv,
  hardening: boolean = gitHardeningEnabled(baseEnv),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (!hardening) return env

  // 1. PATH: strip Windows git so the agent uses WSL git, never git.exe + GCM.
  env.PATH = sanitizePath(baseEnv.PATH, true)

  // 2. Never prompt interactively — fail closed instead of falling back to a
  //    credential-manager / personal-account path.
  env.GIT_TERMINAL_PROMPT = '0'

  // 3. Authoritative git config via env (highest precedence, applies regardless
  //    of which git binary or repo/global config is in play).
  env.GIT_CONFIG_COUNT = String(AGENT_GIT_CONFIG.length)
  AGENT_GIT_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })

  return env
}
