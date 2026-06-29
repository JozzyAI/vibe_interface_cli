/**
 * Local "connection profile" for `vibe connect` — the non-secret settings a single
 * machine uses to reach a relay, so onboarding (and later commands) don't have to
 * repeat relay/token/name/VIBE_DIR every time.
 *
 * IMPORTANT: this file stores ONLY non-secret metadata — display name, relay URL,
 * the token-file PATH (never the token value), VIBE_DIR, advertised agents, and the
 * derived node_id. It must never hold the relay token.
 *
 * It lives at a stable, VIBE_DIR-independent path (it records *which* VIBE_DIR to
 * use, so it can't live inside one). Note this is distinct from the existing
 * <VIBE_DIR>/config.json runtime config (workspace_root / node_id).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface NodeProfile {
  version: 1
  display_name?: string
  relay_url?: string
  /** PATH to a 0600 token file — never the token value. */
  token_file?: string
  vibe_dir?: string
  advertise_agents?: string[]
  /** Derived from the node identity (reference only). */
  node_id?: string
  created_at?: string
  updated_at?: string
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config')
}

/** Profile location. `VIBE_PROFILE` overrides it (used to isolate tests). */
export function profilePath(): string {
  return process.env.VIBE_PROFILE ?? path.join(configHome(), 'vibe', 'profile.json')
}

// ── Daemon defaults resolution ───────────────────────────────────────────────
// `vibe node daemon` fills missing settings from the profile written by
// `vibe connect`, so a connected machine can just run `vibe node daemon`.
// Precedence (highest first): CLI flag > env var > profile > existing default.

export interface DaemonFlagInput {
  local?: boolean
  relay?: string
  token?: string
  tokenFile?: string
  advertiseAgent?: string[]
}
export interface DaemonEnvInput {
  VIBE_DIR?: string
  VIBE_RELAY_TOKEN?: string
  VIBE_NODE_ADVERTISE_AGENTS?: string
}
export interface ResolvedDaemonDefaults {
  /** Local-node mode applies when --local is passed OR a profile exists (a profile
   *  means this machine was onboarded via `vibe connect` as a local node). */
  local: boolean
  relay?: string
  /** token-file PATH to hand to resolveRelayToken; undefined lets it fall back to
   *  --token / VIBE_RELAY_TOKEN. NEVER a token value. */
  tokenFile?: string
  /** undefined lets resolveAdvertisedAgents fall back to env/default. */
  advertiseAgents?: string[]
  /** VIBE_DIR to apply only when the env var is unset; undefined = leave as-is. */
  vibeDir?: string
}

/**
 * Pure precedence resolver (no fs/env reads — caller passes them) so it is fully
 * unit-testable. Only ever surfaces a token-file PATH, never a token value.
 */
export function resolveDaemonDefaults(
  flags: DaemonFlagInput,
  profile: NodeProfile | null,
  env: DaemonEnvInput,
): ResolvedDaemonDefaults {
  const local = Boolean(flags.local) || profile !== null
  const relay = flags.relay ?? profile?.relay_url ?? undefined

  const advFlag = flags.advertiseAgent && flags.advertiseAgent.length ? flags.advertiseAgent : undefined
  // flag > env > profile > default: inject the profile list only when there is no
  // flag and no env (undefined then lets resolveAdvertisedAgents apply env/default).
  const advertiseAgents = advFlag
    ?? ((!env.VIBE_NODE_ADVERTISE_AGENTS && profile?.advertise_agents?.length) ? profile.advertise_agents : undefined)

  // flag (--token-file/--token) > env (VIBE_RELAY_TOKEN) > profile token-file path.
  const tokenFile = flags.tokenFile
    ?? ((!flags.token && !env.VIBE_RELAY_TOKEN) ? (profile?.token_file ?? undefined) : undefined)

  // env VIBE_DIR > profile.vibe_dir (existing default ~/.vibe applies when neither).
  const vibeDir = !env.VIBE_DIR ? (profile?.vibe_dir ?? undefined) : undefined

  return { local, relay, tokenFile, advertiseAgents, vibeDir }
}

export function loadProfile(): NodeProfile | null {
  const p = profilePath()
  if (!fs.existsSync(p)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as NodeProfile
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Persist the profile atomically (temp write + fsync + rename), 0600 — same shape
 * as pairing-store. Defensively strips any token-shaped key so a secret can never
 * be written even if a caller passes one.
 */
export function saveProfile(profile: NodeProfile): void {
  const safe: NodeProfile = { ...profile, version: 1 }
  // Belt-and-suspenders: never persist a token value under any common key.
  for (const k of ['token', 'relay_token', 'access_token', 'VIBE_RELAY_TOKEN']) {
    delete (safe as unknown as Record<string, unknown>)[k]
  }
  const file = profilePath()
  const json = JSON.stringify(safe, null, 2)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
}
