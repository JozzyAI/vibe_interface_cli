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
    .action(async (opts) => {
      if (!opts.local) {
        process.stderr.write('error: --local flag is required (remote nodes not yet supported without --relay)\n')
        process.exit(1)
      }
      // Relay mode needs a token, but it must not have to come from argv: resolve
      // it from --token-file / --token / VIBE_RELAY_TOKEN so the long-running
      // daemon can be launched without the token in `ps` output.
      let token: string | undefined
      if (opts.relay) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        try {
          token = resolveRelayToken({ tokenFile: opts.tokenFile as string | undefined, token: opts.token as string | undefined })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile: opts.tokenFile as string | undefined, token: opts.token as string | undefined })
      }
      const { runLocalDaemon } = await import('../node-daemon.js')
      await runLocalDaemon({
        relay: opts.relay as string | undefined,
        token,
        nodeId: opts.nodeId as string | undefined,
      })
    })
}
