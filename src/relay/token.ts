/**
 * Shared relay auth-token resolver.
 *
 * Long-running commands — notably `vibe node daemon` — must not receive the
 * relay token as a CLI argument, because the value then lives in the process
 * argv and is readable by any local user via `ps` / /proc/<pid>/cmdline. This
 * resolver lets every relay command load the token from a file or the
 * environment instead, keeping it out of argv.
 *
 * Precedence:  --token-file <path>  >  --token <token>  >  VIBE_RELAY_TOKEN env
 *
 * The token value is never logged and is never included in a thrown error
 * message (only the env-var name and the (non-secret) file path appear).
 */
import fs from 'fs'

export const RELAY_TOKEN_ENV = 'VIBE_RELAY_TOKEN'
/** Grace-window envs: relay accepts the union of every configured token. */
export const RELAY_TOKEN_ENV_CURRENT = 'VIBE_RELAY_TOKEN_CURRENT'
export const RELAY_TOKEN_ENV_NEXT = 'VIBE_RELAY_TOKEN_NEXT'
/** Comma-separated list form, e.g. VIBE_RELAY_TOKENS=old,new */
export const RELAY_TOKENS_ENV = 'VIBE_RELAY_TOKENS'

export interface RelayTokenSources {
  /** Path from --token-file: the file is read and trimmed. Highest precedence. */
  tokenFile?: string
  /** Literal token from --token (deprecated: visible in process args). */
  token?: string
}

/**
 * Resolve the relay auth token from --token-file, --token, then the
 * VIBE_RELAY_TOKEN environment variable. Returns the trimmed token, or throws a
 * token-free Error if no source provides one.
 */
export function resolveRelayToken(sources: RelayTokenSources = {}): string {
  if (sources.tokenFile !== undefined) {
    let raw: string
    try {
      raw = fs.readFileSync(sources.tokenFile, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'read error'
      throw new Error(`--token-file could not be read (${code}): ${sources.tokenFile}`)
    }
    const trimmed = raw.trim()
    if (!trimmed) throw new Error(`--token-file is empty: ${sources.tokenFile}`)
    return trimmed
  }

  if (sources.token !== undefined && sources.token.trim() !== '') {
    return sources.token.trim()
  }

  const fromEnv = process.env[RELAY_TOKEN_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim()
  }

  throw new Error(
    `relay auth token required: set ${RELAY_TOKEN_ENV}, or pass --token-file <path> ` +
      `(--token <token> also works but is visible in process args)`,
  )
}

/**
 * Resolve the *set* of relay auth tokens the relay SERVER should accept.
 *
 * Unlike {@link resolveRelayToken} (which picks the single token a client
 * presents), the server may accept several tokens at once — this is what makes
 * a zero-downtime token rotation possible: during the grace window the relay
 * accepts both the current and the next token, so old and new clients both
 * connect while each side is updated.
 *
 * Sources (all unioned, de-duplicated, trimmed; empties dropped):
 *   --token-file <path>, --token <token> (deprecated),
 *   VIBE_RELAY_TOKENS (comma-separated), VIBE_RELAY_TOKEN,
 *   VIBE_RELAY_TOKEN_CURRENT, VIBE_RELAY_TOKEN_NEXT.
 *
 * Returns a list (possibly empty); token values are never logged or thrown.
 */
export function resolveRelayServerTokens(sources: RelayTokenSources = {}): string[] {
  const out = new Set<string>()
  const add = (v: string | undefined): void => {
    if (v === undefined) return
    const t = v.trim()
    if (t !== '') out.add(t)
  }

  if (sources.tokenFile !== undefined) {
    try { add(fs.readFileSync(sources.tokenFile, 'utf8')) } catch { /* ignore unreadable file */ }
  }
  add(sources.token)

  const list = process.env[RELAY_TOKENS_ENV]
  if (list) for (const part of list.split(',')) add(part)
  add(process.env[RELAY_TOKEN_ENV])
  add(process.env[RELAY_TOKEN_ENV_CURRENT])
  add(process.env[RELAY_TOKEN_ENV_NEXT])

  return [...out]
}

/**
 * Emit a one-line stderr warning when the deprecated --token CLI arg is the
 * token source (it exposes the value in process args). Never prints the value.
 */
export function warnIfTokenArg(sources: RelayTokenSources): void {
  if (!sources.tokenFile && sources.token !== undefined && sources.token.trim() !== '') {
    process.stderr.write(
      `[vibe] warning: --token is visible in process args (ps); ` +
        `prefer ${RELAY_TOKEN_ENV} env or --token-file <path>\n`,
    )
  }
}
