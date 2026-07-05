import type { Command } from 'commander'
import { listNodes, getNode } from '../nodes.js'
import { ensureIdentity, toPublicIdentity } from '../identity.js'

export function registerNodeCommand(program: Command): void {
  const node = program.command('node').description('manage Vibe Nodes')

  node
    .command('list')
    .description('list available nodes')
    .option('--json', 'output machine-readable JSON')
    .option('--remote', 'query remote relay node registry instead of local')
    .option('--relay <url>', 'relay WebSocket URL (required with --remote)')
    .option('--token <token>', 'auth token (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .action(async (opts) => {
      if (opts.remote) {
        if (!opts.relay) {
          process.stderr.write('error: --relay <url> is required with --remote\n')
          process.exit(1)
        }
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile: opts.tokenFile as string | undefined, token: opts.token as string | undefined })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile: opts.tokenFile as string | undefined, token: opts.token as string | undefined })
        try {
          const { fetchRemoteNodes } = await import('../relay/client.js')
          const nodes = await fetchRemoteNodes(opts.relay as string, token)
          process.stdout.write(JSON.stringify(nodes) + '\n')
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
      } else {
        process.stdout.write(JSON.stringify(listNodes()) + '\n')
      }
    })

  node
    .command('status <node_id>')
    .description('get status of a node')
    .option('--json', 'output machine-readable JSON')
    .action((nodeId: string) => {
      const n = getNode(nodeId)
      if (!n) {
        process.stdout.write(JSON.stringify({
          error: true,
          code: 'node_not_found',
          message: `Node not found: ${nodeId}`,
          ts: new Date().toISOString(),
        }) + '\n')
        process.exit(3)
      }
      process.stdout.write(JSON.stringify(n) + '\n')
    })

  node
    .command('identity')
    .description('show (or create) this node\'s identity — auto-creates if missing')
    .option('--json', 'output machine-readable JSON')
    .action((_opts) => {
      const identity = ensureIdentity()
      const pub = toPublicIdentity(identity)
      process.stdout.write(JSON.stringify(pub) + '\n')
    })

  node
    .command('pair')
    .description('pair this node with a relay (sends public identity to relay)')
    .requiredOption('--relay <url>', 'relay WebSocket URL')
    .option('--token <token>', 'auth token (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts) => {
      const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
      let token: string
      try {
        token = resolveRelayToken({ tokenFile: opts.tokenFile as string | undefined, token: opts.token as string | undefined })
      } catch (err) {
        process.stderr.write(`error: ${(err as Error).message}\n`)
        process.exit(1)
      }
      warnIfTokenArg({ tokenFile: opts.tokenFile as string | undefined, token: opts.token as string | undefined })
      try {
        const { relayNodePair } = await import('../relay/client.js')
        const record = await relayNodePair(opts.relay as string, token)
        process.stdout.write(JSON.stringify(record) + '\n')
      } catch (err) {
        process.stderr.write(`error: ${(err as Error).message}\n`)
        process.exit(1)
      }
    })

  node
    .command('daemon')
    .description('run the Vibe Node daemon')
    .option('--local', 'run as the local machine node (required for MVP 3C/3D)')
    .option('--relay <url>', 'relay WebSocket URL (relay mode)')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file (kept out of process args)')
    .option('--node-id <id>', 'override node ID (default: hostname or "local")')
    .option(
      '--advertise-agent <agent>',
      'restrict the agents advertised to the relay (repeatable or comma-separated, e.g. "mock"); also settable via VIBE_NODE_ADVERTISE_AGENTS',
      (val: string, prev: string[]) => prev.concat(val),
      [] as string[],
    )
    .option('--allow-terminal-create', 'allow remote `vibe terminal serve --create` to spawn a login shell on this node (default OFF; also VIBE_TERMINAL_ALLOW_CREATE=1)')
    .action(async (opts) => {
      // Fill missing daemon settings from the `vibe connect` profile so a connected
      // machine can just run `vibe node daemon`. Precedence: CLI flag > env > profile
      // > default. A profile also implies local mode (the machine was onboarded as a
      // local node); without a profile, --local stays required (back-compat).
      const { loadProfile, resolveDaemonDefaults } = await import('../lib/node-config.js')
      const defaults = resolveDaemonDefaults(
        {
          local: opts.local as boolean | undefined,
          relay: opts.relay as string | undefined,
          token: opts.token as string | undefined,
          tokenFile: opts.tokenFile as string | undefined,
          advertiseAgent: opts.advertiseAgent as string[],
        },
        loadProfile(),
        {
          VIBE_DIR: process.env.VIBE_DIR,
          VIBE_RELAY_TOKEN: process.env.VIBE_RELAY_TOKEN,
          VIBE_NODE_ADVERTISE_AGENTS: process.env.VIBE_NODE_ADVERTISE_AGENTS,
        },
      )

      if (!defaults.local) {
        process.stderr.write('error: --local flag is required (remote nodes not yet supported without --relay)\n')
        process.exit(1)
      }
      // Apply the profile's VIBE_DIR only when the env var is unset (env > profile),
      // before any identity/daemon work reads vibeDir().
      if (defaults.vibeDir) process.env.VIBE_DIR = defaults.vibeDir

      // Terminal session-creation opt-in (default OFF). The flag simply sets the
      // env the daemon reads (VIBE_TERMINAL_ALLOW_CREATE=1); leaving it unset
      // keeps `--create` refused with terminal_create_disabled.
      if (opts.allowTerminalCreate) process.env.VIBE_TERMINAL_ALLOW_CREATE = '1'

      // Validate the advertise allowlist up front so a bad value (or env) fails
      // fast with a structured error, before any relay connection is attempted.
      // `advertiseAgents` is undefined unless a flag (or, via the profile, an
      // explicit value) was set, so resolveAdvertisedAgents still applies env/default.
      const advertiseAgents = defaults.advertiseAgents
      {
        const { resolveAdvertisedAgents, AdvertiseAllowlistError } = await import('../agent-registry.js')
        try {
          resolveAdvertisedAgents(advertiseAgents)
        } catch (err) {
          if (err instanceof AdvertiseAllowlistError) {
            process.stderr.write(JSON.stringify({ error: true, code: err.code, message: err.message, ts: new Date().toISOString() }) + '\n')
            process.exit(1)
          }
          throw err
        }
      }
      // Relay mode needs a token, but it must not have to come from argv: resolve
      // it from --token-file (CLI or profile) / --token / VIBE_RELAY_TOKEN so the
      // long-running daemon can be launched without the token in `ps` output.
      let token: string | undefined
      if (defaults.relay) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        try {
          token = resolveRelayToken({ tokenFile: defaults.tokenFile, token: opts.token as string | undefined })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile: defaults.tokenFile, token: opts.token as string | undefined })
      }
      const { runLocalDaemon } = await import('../node-daemon.js')
      await runLocalDaemon({
        relay: defaults.relay,
        token,
        nodeId: opts.nodeId as string | undefined,
        advertiseAgents,
      })
    })
}
