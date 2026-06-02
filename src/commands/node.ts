import type { Command } from 'commander'
import { listNodes, getNode } from '../nodes.js'

export function registerNodeCommand(program: Command): void {
  const node = program.command('node').description('manage Vibe Nodes')

  node
    .command('list')
    .description('list available nodes')
    .option('--json', 'output machine-readable JSON')
    .action(() => {
      process.stdout.write(JSON.stringify(listNodes()) + '\n')
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
    .command('daemon')
    .description('run the local Vibe Node daemon (writes heartbeat to ~/.vibe/node-local.json)')
    .option('--local', 'run as the local machine node (required for MVP 3C)')
    .action(async (opts) => {
      if (!opts.local) {
        process.stderr.write('error: --local flag is required (remote nodes not yet supported)\n')
        process.exit(1)
      }
      const { runLocalDaemon } = await import('../node-daemon.js')
      await runLocalDaemon()
    })
}
