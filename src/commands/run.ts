import type { Command } from 'commander'
import { readRun } from '../store.js'
import { streamEvents } from '../events.js'
import { startRun, stopRun } from '../lib/run-actions.js'
import type { AgentBackend, PermissionMode } from '../types.js'

export function registerRunCommand(program: Command): void {
  const run = program.command('run').description('manage runs')

  run
    .command('start')
    .description('start a new run')
    .option('--agent <backend>', 'agent backend (mock, claude-code, codex, opencode)', 'mock')
    .option('--repo-url <url>', 'git repo to clone into workspace')
    .option('--branch <branch>', 'branch to checkout (default: repo default)')
    .option('--workspace-key <key>', 'unique key for workspace directory (default: run_id)')
    .option('--prompt-file <path>', 'path to prompt file')
    .option('--metadata-file <path>', 'path to JSON metadata file')
    .option('--permission-mode <mode>', 'permission mode: default | unsafe-skip (unsafe-skip enables --dangerously-skip-permissions)')
    .option('--node <id>', 'node to run on: auto | local | <node_id> (default: auto)')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action(async (opts) => {
      const record = await startRun({
        agent: opts.agent as AgentBackend,
        node: opts.node as string | undefined,
        workspaceKey: opts.workspaceKey,
        repoUrl: opts.repoUrl,
        branch: opts.branch,
        promptFile: opts.promptFile,
        metadataFile: opts.metadataFile,
        permissionMode: opts.permissionMode as PermissionMode | undefined,
      })
      process.stdout.write(JSON.stringify(record) + '\n')
    })

  run
    .command('stream <run_id>')
    .description('stream events for a run as JSONL')
    .option('--jsonl', 'output machine-readable JSONL to stdout (default behaviour)')
    .action((run_id: string) => {
      readRun(run_id) // validates existence, exits 3 if not found
      streamEvents(run_id)
    })

  run
    .command('status <run_id>')
    .description('get current status of a run')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action((run_id: string) => {
      const record = readRun(run_id)
      process.stdout.write(JSON.stringify(record) + '\n')
    })

  run
    .command('stop <run_id>')
    .description('stop a running run')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action((run_id: string) => {
      const updated = stopRun(run_id)
      process.stdout.write(JSON.stringify(updated) + '\n')
    })
}
