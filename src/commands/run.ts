import fs from 'fs'
import { execSync } from 'child_process'
import type { Command } from 'commander'
import { resolveConfig } from '../config.js'
import { generateRunId, readRun, updateRun, writeRun } from '../store.js'
import { appendEvent, streamEvents } from '../events.js'
import { resolveWorkspacePath, ensureWorkspace, cloneIfEmpty } from '../workspace.js'
import { mockBackend } from '../backends/mock.js'
import { claudeCodeBackend } from '../backends/claude-code.js'
import type { AgentBackend, RunRecord } from '../types.js'
import type { Backend } from '../backends/types.js'

// All human-readable messages go to stderr so stdout stays machine-readable.
function err(msg: string): void {
  process.stderr.write(msg + '\n')
}

function getBackend(agent: AgentBackend): Backend {
  switch (agent) {
    case 'mock': return mockBackend
    case 'claude-code': return claudeCodeBackend
    default:
      err(`error: unknown agent backend "${agent}"`)
      process.exit(1)
  }
}

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
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action(async (opts) => {
      const config = resolveConfig()
      const run_id = generateRunId()
      const workspaceKey: string = opts.workspaceKey ?? run_id
      const workspacePath = resolveWorkspacePath(workspaceKey, config.workspace_root)

      ensureWorkspace(workspacePath)

      if (opts.repoUrl) {
        cloneIfEmpty(workspacePath, opts.repoUrl, opts.branch)
      }

      let metadata: Record<string, unknown> | undefined
      if (opts.metadataFile) {
        metadata = JSON.parse(fs.readFileSync(opts.metadataFile, 'utf8'))
      }

      const record: RunRecord = {
        run_id,
        session_id: '',
        node_id: config.node_id,
        agent: opts.agent as AgentBackend,
        status: 'queued',
        workspace_path: workspacePath,
        repo_url: opts.repoUrl,
        branch: opts.branch,
        prompt_file: opts.promptFile,
        metadata,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      writeRun(record)

      const backend = getBackend(record.agent)
      const result = await backend.start(record, {
        promptFile: opts.promptFile,
        repoUrl: opts.repoUrl,
        branch: opts.branch,
        metadata,
      })

      const running = updateRun(run_id, { session_id: result.session_id, status: 'running' })
      process.stdout.write(JSON.stringify(running) + '\n')
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
      const record = readRun(run_id)

      if (record.status === 'completed' || record.status === 'failed' || record.status === 'stopped' || record.status === 'cancelled') {
        err(`error: run ${run_id} is already in terminal state: ${record.status}`)
        process.exit(1)
      }

      if (record.session_id) {
        const pid = parseInt(record.session_id, 10)
        if (!isNaN(pid) && pid > 0) {
          try { process.kill(pid, 'SIGTERM') } catch {}
        } else {
          try { execSync(`tmux kill-session -t ${record.session_id}`, { stdio: 'ignore' }) } catch {}
        }
      }

      appendEvent({ type: 'status', run_id, session_id: record.session_id, status: 'stopped', ts: new Date().toISOString() })
      const updated = updateRun(run_id, { status: 'stopped' })
      process.stdout.write(JSON.stringify(updated) + '\n')
    })
}
