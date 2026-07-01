#!/usr/bin/env node
import { Command } from 'commander'
import { registerRunCommand } from './commands/run.js'
import { registerSymphonyCommand } from './commands/symphony.js'
import { registerNodeCommand } from './commands/node.js'
import { registerRelayCommand } from './commands/relay.js'
import { registerApprovalCommand } from './commands/approval.js'
import { registerMonitorCommand } from './commands/monitor.js'
import { registerConnectCommand } from './commands/connect.js'
import { registerTerminalCommand } from './commands/terminal.js'
import { runSupervisor } from './runtime/supervisor.js'

const program = new Command()
program.name('vibe').description('Vibe Interface CLI — universal worker-node runtime').version('0.1.0')

// The supervisor is the single detached entrypoint behind every backend: it
// runs the primary agent and, per the run's agent_policy, may fall back to
// another agent under the same run_id.
const runSupervised = (run_id: string) => {
  runSupervisor(run_id).catch((err) => {
    process.stderr.write(String(err) + '\n')
    process.exit(1)
  })
}

program.command('_supervisor <run_id>', { hidden: true }).action(runSupervised)

// Back-compat shims: older callers may still invoke the per-agent runner names.
// With no agent_policy metadata the supervisor collapses to a single-agent run,
// so these behave exactly like the old runners.
program.command('_mock-runner <run_id>', { hidden: true }).action(runSupervised)
program.command('_claude-runner <run_id>', { hidden: true }).action(runSupervised)
program.command('_codex-runner <run_id>', { hidden: true }).action(runSupervised)

registerConnectCommand(program)
registerRunCommand(program)
registerSymphonyCommand(program)
registerNodeCommand(program)
registerRelayCommand(program)
registerApprovalCommand(program)
registerMonitorCommand(program)
registerTerminalCommand(program)

program.parse()
