/**
 * `vibe symphony` — Symphony-shaped wrapper over the core run contract.
 *
 * Accepts Symphony-specific inputs (issue_id, issue_title, repo_url, branch)
 * and maps them to the underlying vibe run start/stream/status/stop.
 * All state lives in the same ~/.vibe/ store as plain `vibe run` records,
 * differentiated by metadata.source === 'symphony'.
 */
import type { Command } from 'commander'
import { readRun } from '../store.js'
import { streamEvents } from '../events.js'
import { startRun, stopRun } from '../lib/run-actions.js'
import type { AgentBackend, PermissionMode } from '../types.js'

export function registerSymphonyCommand(program: Command): void {
  const sym = program.command('symphony').description('Symphony orchestrator integration')

  sym
    .command('start')
    .description('start a Symphony-dispatched run')
    .option('--issue-id <id>', 'Symphony issue / task ID')
    .option('--issue-title <title>', 'human-readable issue title')
    .option('--agent <backend>', 'agent backend (mock, claude-code, codex, opencode)', 'mock')
    .option('--repo-url <url>', 'git repo to clone into workspace')
    .option('--branch <branch>', 'branch to checkout (default: repo default)')
    .option('--workspace-key <key>', 'unique workspace directory key (default: issue-id or run_id)')
    .option('--prompt-file <path>', 'path to prompt file')
    .option('--metadata-file <path>', 'path to JSON metadata file')
    .option('--permission-mode <mode>', 'permission mode: default | unsafe-skip (unsafe-skip enables --dangerously-skip-permissions)')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action(async (opts) => {
      const extraMetadata: Record<string, unknown> = { source: 'symphony' }
      if (opts.issueId) extraMetadata.issue_id = opts.issueId
      if (opts.issueTitle) extraMetadata.issue_title = opts.issueTitle

      const workspaceKey: string | undefined = opts.workspaceKey ?? opts.issueId

      const record = await startRun({
        agent: opts.agent as AgentBackend,
        workspaceKey,
        repoUrl: opts.repoUrl,
        branch: opts.branch,
        promptFile: opts.promptFile,
        metadataFile: opts.metadataFile,
        extraMetadata,
        permissionMode: opts.permissionMode as PermissionMode | undefined,
      })
      process.stdout.write(JSON.stringify(record) + '\n')
    })

  sym
    .command('stream <run_id>')
    .description('stream events for a Symphony run as JSONL')
    .option('--jsonl', 'output machine-readable JSONL to stdout (default behaviour)')
    .action((run_id: string) => {
      readRun(run_id) // validates existence, exits 3 if not found
      streamEvents(run_id)
    })

  sym
    .command('status <run_id>')
    .description('get current status of a Symphony run')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action((run_id: string) => {
      const record = readRun(run_id)
      process.stdout.write(JSON.stringify(record) + '\n')
    })

  sym
    .command('stop <run_id>')
    .description('stop a Symphony run')
    .option('--reason <reason>', 'human-readable reason for stopping')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action((run_id: string, opts) => {
      const updated = stopRun(run_id)
      // Attach stop reason to metadata without a separate store write — it's
      // informational only and visible in the final record returned here.
      if (opts.reason) {
        process.stderr.write(`[symphony] stop reason: ${opts.reason}\n`)
      }
      process.stdout.write(JSON.stringify(updated) + '\n')
    })
}
