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
    .option('--token <token>', 'auth token (required with --remote)')
    .action(async (opts) => {
      if (opts.remote) {
        if (!opts.relay || !opts.token) {
          process.stderr.write('error: --relay <url> and --token <token> are required with --remote\n')
          process.exit(1)
        }
        try {
          const { fetchRemoteNodes } = await import('../relay/client.js')
          const nodes = await fetchRemoteNodes(opts.relay as string, opts.token as string)
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
    .requiredOption('--token <token>', 'auth token')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts) => {
      try {
        const { relayNodePair } = await import('../relay/client.js')
        const record = await relayNodePair(opts.relay as string, opts.token as string)
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
    .option('--token <token>', 'auth token for relay')
    .option('--node-id <id>', 'override node ID (default: hostname or "local")')
    .action(async (opts) => {
      if (!opts.local) {
        process.stderr.write('error: --local flag is required (remote nodes not yet supported without --relay)\n')
        process.exit(1)
      }
      if (opts.relay && !opts.token) {
        process.stderr.write('error: --token is required when --relay is set\n')
        process.exit(1)
      }
      const { runLocalDaemon } = await import('../node-daemon.js')
      await runLocalDaemon({
        relay: opts.relay as string | undefined,
        token: opts.token as string | undefined,
        nodeId: opts.nodeId as string | undefined,
      })
    })
}
