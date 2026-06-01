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
}
