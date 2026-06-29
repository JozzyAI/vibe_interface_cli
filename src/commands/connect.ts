/**
 * `vibe connect` — UX-compression onboarding for a single machine.
 *
 * Hides VIBE_DIR / identity / pairing / relay-token / daemon / advertised-agents /
 * node_id behind one guided command: create or reuse a node identity, write a
 * reusable local profile (non-secret), pair with the relay ONLY after explicit
 * confirmation, and print the daemon command. `--dry-run` plans with zero writes
 * and zero relay contact. No daemon is started, no real agent is run, and a token
 * value is never printed or stored.
 */
import type { Command } from 'commander'
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { ensureIdentity } from '../identity.js'
import { resolveAdvertisedAgents, AdvertiseAllowlistError } from '../agent-registry.js'
import { loadProfile, saveProfile, profilePath, type NodeProfile } from '../lib/node-config.js'

const LOOPBACK_DEFAULT_VIBE_DIR = () => process.env.VIBE_DIR ?? path.join(os.homedir(), '.vibe')

function daemonCommand(vibeDir: string, agents: string[], relay?: string, tokenFile?: string): string {
  const parts = [
    `VIBE_DIR=${vibeDir}`,
    `VIBE_NODE_ADVERTISE_AGENTS=${agents.join(',')}`,
    'vibe node daemon --local',
  ]
  if (relay) parts.push(`--relay ${relay}`)
  if (tokenFile) parts.push(`--token-file ${tokenFile}`)
  return parts.join(' ')
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Prompt on stderr so stdout stays clean for `--json`/piping.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    rl.question(prompt, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())) })
  })
}

export function registerConnectCommand(program: Command): void {
  program
    .command('connect')
    .description('connect this machine to a Vibe relay (identity + profile + pairing) — one guided step')
    .option('--name <display-name>', 'friendly node display name (shown in `node list`)')
    .option('--relay <url>', 'relay WebSocket URL')
    .option('--token-file <path>', 'path to a 0600 relay token file (its path is stored, never the value)')
    .option('--vibe-dir <path>', 'node state dir (default: $VIBE_DIR or ~/.vibe)')
    .option('--advertise-agent <agent>', 'agent to advertise (repeatable; default: mock)', (v: string, p: string[]) => p.concat(v), [] as string[])
    .option('--mock-only', 'advertise only the mock agent (the default)')
    .option('--dry-run', 'show the plan without creating, writing, or pairing anything')
    .option('--yes', 'skip the interactive pairing confirmation (non-interactive)')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts) => {
      const ts = () => new Date().toISOString()
      const fail = (code: string, message: string, extra: Record<string, unknown> = {}): never => {
        process.stdout.write(JSON.stringify({ error: true, code, message, ...extra, ts: ts() }) + '\n')
        process.exit(1)
      }

      // JSON can't prompt — require an explicit non-interactive choice.
      if (opts.json && !opts.yes && !opts.dryRun) {
        fail('confirmation_required', '--json requires --yes (non-interactive) or --dry-run')
      }

      const profile: NodeProfile = loadProfile() ?? { version: 1 }
      const name: string | undefined = (opts.name as string | undefined) ?? profile.display_name
      const relay: string | undefined = (opts.relay as string | undefined) ?? profile.relay_url
      const tokenFile: string | undefined = (opts.tokenFile as string | undefined) ?? profile.token_file
      const vibeDirPath: string = (opts.vibeDir as string | undefined) ?? profile.vibe_dir ?? LOOPBACK_DEFAULT_VIBE_DIR()
      const advertise: string[] = opts.mockOnly
        ? ['mock']
        : ((opts.advertiseAgent as string[]).length ? (opts.advertiseAgent as string[]) : (profile.advertise_agents ?? ['mock']))

      // Validate advertised agents up front (fail fast on a bad name).
      try {
        resolveAdvertisedAgents(advertise)
      } catch (err) {
        if (err instanceof AdvertiseAllowlistError) fail(err.code, err.message)
        throw err
      }

      const identityFile = path.join(vibeDirPath, 'identity.json')
      const identityExists = fs.existsSync(identityFile)

      // ── dry-run: plan only, no writes, no relay contact ──────────────────────
      if (opts.dryRun) {
        const plan = {
          dry_run: true,
          would: {
            identity: identityExists ? 'reuse existing' : 'create new',
            display_name: name ?? '(hostname)',
            vibe_dir: vibeDirPath,
            profile_path: profilePath(),
            relay_url: relay ?? null,
            token_file: tokenFile ?? null,
            advertise_agents: advertise,
            pair: relay ? `pair with ${relay} (after confirmation)` : 'skipped — no --relay set',
            daemon_command: daemonCommand(vibeDirPath, advertise, relay, tokenFile),
          },
          ts: ts(),
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(plan) + '\n')
        } else {
          process.stdout.write(
            `vibe connect (dry-run) — nothing was created or paired:\n` +
            `  identity   ${plan.would.identity}  (display: ${plan.would.display_name})\n` +
            `  vibe-dir   ${vibeDirPath}\n` +
            `  profile    ${plan.would.profile_path}  (no token value stored)\n` +
            `  relay      ${relay ?? '(not set)'}\n` +
            `  token-file ${tokenFile ?? '(not set)'}\n` +
            `  advertise  ${advertise.join(', ')}\n` +
            `  pair       ${plan.would.pair}\n` +
            `  then run:  ${plan.would.daemon_command}\n`,
          )
        }
        return
      }

      // ── real run: identity (local) + profile (local) ─────────────────────────
      process.env.VIBE_DIR = vibeDirPath
      // Display name only bites when creating a new identity (it is persisted then).
      if (!identityExists && name) process.env.VIBE_NODE_DISPLAY_NAME = name
      const identity = ensureIdentity()
      const node_id = identity.id

      const now = ts()
      saveProfile({
        version: 1,
        display_name: identity.display_name,
        relay_url: relay,
        token_file: tokenFile,
        vibe_dir: vibeDirPath,
        advertise_agents: advertise,
        node_id,
        created_at: profile.created_at ?? now,
        updated_at: now,
      })

      // ── pairing (only after explicit confirmation; contacts the relay) ───────
      let paired: { node_id: string; status: string } | null = null
      let pair_skipped: string | undefined
      if (!relay) {
        pair_skipped = 'no --relay set'
      } else {
        const goAhead = opts.yes ? true : await confirm(`Pair node ${node_id} with ${relay}? [y/N] `)
        if (!goAhead) {
          pair_skipped = 'declined at confirmation'
        } else {
          const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
          let token: string
          try {
            token = resolveRelayToken({ tokenFile, token: undefined })
          } catch (err) {
            fail('auth_token_error', (err as Error).message, { node_id })
          }
          warnIfTokenArg({ tokenFile, token: undefined })
          try {
            const { relayNodePair } = await import('../relay/client.js')
            const record = await relayNodePair(relay, token!)
            paired = { node_id: record.node_id, status: record.status }
          } catch (err) {
            fail('pair_failed', (err as Error).message, { node_id })
          }
        }
      }

      const daemon_command = daemonCommand(vibeDirPath, advertise, relay, tokenFile)
      const name_note = (opts.name && identityExists && identity.display_name !== opts.name)
        ? `--name ignored: identity already exists with display_name "${identity.display_name}" (set at creation)`
        : undefined

      const result = {
        connected: true,
        node_id,
        display_name: identity.display_name,
        identity_reused: identityExists,
        vibe_dir: vibeDirPath,
        profile: profilePath(),
        relay_url: relay ?? null,
        advertise_agents: advertise,
        paired,
        ...(pair_skipped ? { pair_skipped } : {}),
        ...(name_note ? { name_note } : {}),
        daemon_command,
        ts: now,
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(result) + '\n')
      } else {
        process.stdout.write(
          `vibe connect — ${identityExists ? 'reused' : 'created'} node ${node_id} (display: ${identity.display_name})\n` +
          `  vibe-dir   ${vibeDirPath}\n` +
          `  profile    ${profilePath()}  (saved; no token value stored)\n` +
          `  advertise  ${advertise.join(', ')}\n` +
          (paired ? `  paired     with ${relay} ✓\n` : `  paired     no — ${pair_skipped}\n`) +
          (name_note ? `  note       ${name_note}\n` : '') +
          `\nStart the node daemon when ready:\n  ${daemon_command}\n`,
        )
      }
    })
}
