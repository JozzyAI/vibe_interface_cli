/**
 * `vibe symphony` — Symphony-shaped wrapper over the core run contract.
 *
 * Accepts Symphony-specific inputs (issue_id, issue_title, repo_url, branch)
 * and maps them to the underlying vibe run start/stream/status/stop.
 * All state lives in the same ~/.vibe/ store as plain `vibe run` records,
 * differentiated by metadata.source === 'symphony'.
 *
 * Remote relay support: pass --node <id> --relay <ws-url> --token <tok> to
 * dispatch the run to a remote Vibe Node through the relay.
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
    .option('--node <id>', 'node to run on: auto | local | <node_id> (default: auto)')
    .option('--relay <url>', 'relay WebSocket URL (required for remote nodes)')
    .option('--token <token>', 'auth token for relay')
    .option('--encrypt', 'encrypt the run_start payload for the target node (requires node to have identity)')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action(async (opts) => {
      const nodeSelector: string = opts.node ?? 'auto'
      const isRemote = opts.relay && nodeSelector !== 'auto' && nodeSelector !== 'local'

      if (isRemote) {
        if (!opts.token) {
          process.stderr.write('error: --token is required with --relay for remote nodes\n')
          process.exit(1)
        }
        try {
          const { remoteRunStart, fetchRemoteNodes } = await import('../relay/client.js')

          let encryptionPublicKey: string | undefined
          if (opts.encrypt) {
            const nodes = await fetchRemoteNodes(opts.relay as string, opts.token as string)
            const target = nodes.find(n => n.node_id === nodeSelector)
            if (!target?.encryption_public_key) {
              process.stderr.write(`error: --encrypt requires the target node to have an identity (node ${nodeSelector} has no encryption_public_key)\n`)
              process.stderr.write('       Pair the node first: vibe node pair --relay ... --token ...\n')
              process.exit(1)
            }
            encryptionPublicKey = target.encryption_public_key
          }

          const extraMetadata: Record<string, unknown> = { source: 'symphony' }
          if (opts.issueId) extraMetadata.issue_id = opts.issueId
          if (opts.issueTitle) extraMetadata.issue_title = opts.issueTitle
          const record = await remoteRunStart(opts.relay as string, opts.token as string, nodeSelector, {
            agent: opts.agent as AgentBackend,
            workspaceKey: opts.workspaceKey ?? opts.issueId,
            repoUrl: opts.repoUrl,
            branch: opts.branch,
            promptFile: opts.promptFile,
            permissionMode: opts.permissionMode as PermissionMode | undefined,
            metadata: extraMetadata,
            encryptionPublicKey,
          })
          process.stdout.write(JSON.stringify(record) + '\n')
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        return
      }

      const extraMetadata: Record<string, unknown> = { source: 'symphony' }
      if (opts.issueId) extraMetadata.issue_id = opts.issueId
      if (opts.issueTitle) extraMetadata.issue_title = opts.issueTitle

      const workspaceKey: string | undefined = opts.workspaceKey ?? opts.issueId

      const record = await startRun({
        agent: opts.agent as AgentBackend,
        node: nodeSelector,
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
    .option('--relay <url>', 'relay WebSocket URL for remote stream')
    .option('--token <token>', 'auth token for relay')
    .action(async (run_id: string, opts) => {
      if (opts.relay) {
        if (!opts.token) {
          process.stderr.write('error: --token is required with --relay\n')
          process.exit(1)
        }
        try {
          const { remoteStream } = await import('../relay/client.js')
          await remoteStream(opts.relay as string, opts.token as string, run_id)
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        return
      }
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
    .option('--relay <url>', 'relay WebSocket URL for remote stop')
    .option('--token <token>', 'auth token for relay')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action(async (run_id: string, opts) => {
      if (opts.relay) {
        if (!opts.token) {
          process.stderr.write('error: --token is required with --relay\n')
          process.exit(1)
        }
        try {
          const { remoteStop } = await import('../relay/client.js')
          const record = await remoteStop(opts.relay as string, opts.token as string, run_id)
          process.stdout.write(JSON.stringify(record) + '\n')
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        return
      }
      const updated = stopRun(run_id)
      if (opts.reason) {
        process.stderr.write(`[symphony] stop reason: ${opts.reason}\n`)
      }
      process.stdout.write(JSON.stringify(updated) + '\n')
    })
}
