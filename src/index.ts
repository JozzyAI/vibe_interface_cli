#!/usr/bin/env node
import { Command } from 'commander'
import { registerRunCommand } from './commands/run.js'
import { runMockRunner } from './mock-runner.js'

const program = new Command()
program.name('vibe').description('Vibe Interface CLI — universal worker-node runtime').version('0.1.0')

// internal hidden command used by mock backend
program
  .command('_mock-runner <run_id>', { hidden: true })
  .action((run_id: string) => {
    runMockRunner(run_id).catch((err) => {
      process.stderr.write(String(err) + '\n')
      process.exit(1)
    })
  })

registerRunCommand(program)

program.parse()
