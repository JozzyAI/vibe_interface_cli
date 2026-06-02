#!/usr/bin/env node
import { Command } from 'commander'
import { registerRunCommand } from './commands/run.js'
import { registerSymphonyCommand } from './commands/symphony.js'
import { registerNodeCommand } from './commands/node.js'
import { registerRelayCommand } from './commands/relay.js'
import { runMockRunner } from './mock-runner.js'
import { runClaudeRunner } from './claude-runner.js'

const program = new Command()
program.name('vibe').description('Vibe Interface CLI — universal worker-node runtime').version('0.1.0')

program
  .command('_mock-runner <run_id>', { hidden: true })
  .action((run_id: string) => {
    runMockRunner(run_id).catch((err) => {
      process.stderr.write(String(err) + '\n')
      process.exit(1)
    })
  })

program
  .command('_claude-runner <run_id>', { hidden: true })
  .action((run_id: string) => {
    runClaudeRunner(run_id).catch((err) => {
      process.stderr.write(String(err) + '\n')
      process.exit(1)
    })
  })

registerRunCommand(program)
registerSymphonyCommand(program)
registerNodeCommand(program)
registerRelayCommand(program)

program.parse()
