import type { Command } from 'commander'
import { readRun } from '../store.js'
import { streamEvents } from '../events.js'
import { startRun, stopRun } from '../lib/run-actions.js'
import { buildAgentPolicyMetadata } from '../runtime/policy.js'
import type { AgentBackend, PermissionMode } from '../types.js'

export function registerRunCommand(program: Command): void {
  const run = program.command('run').description('manage runs')

  run
    .command('start')
    .description('start a new run')
    .option('--agent <backend>', 'agent backend (mock, claude-code, codex, opencode, auto — local runs only)', 'mock')
    .option('--fallback-agent <agents...>', 'fallback agent(s) to try on a recoverable failure (repeatable or comma-separated)')
    .option('--switch-on <reasons>', 'comma-separated failure reasons that trigger fallback (default: session_limit,usage_limit,quota_exceeded,rate_limited)')
    .option('--handoff-on-failure', 'write a handoff doc when switching agents (default: on)')
    .option('--preserve-workspace', 'reuse the same workspace/branch for the fallback agent (default: on)')
    .option('--repo-url <url>', 'git repo to clone into workspace')
    .option('--branch <branch>', 'branch to checkout (default: repo default)')
    .option('--workspace-key <key>', 'unique key for workspace directory (default: run_id)')
    .option('--prompt-file <path>', 'path to prompt file')
    .option('--metadata-file <path>', 'path to JSON metadata file')
    .option('--permission-mode <mode>', 'permission mode: default | unsafe-skip (unsafe-skip enables --dangerously-skip-permissions)')
    .option('--node <id>', 'node to run on: auto | local | <node_id> (default: auto)')
    .option('--relay <url>', 'relay WebSocket URL (required for remote nodes)')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .option('--encrypt', 'encrypt the run_start payload for the target node (requires node to have identity)')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action(async (opts) => {
      const nodeSelector: string = opts.node ?? 'auto'
      const isRemote = opts.relay && nodeSelector !== 'auto' && nodeSelector !== 'local'

      const agentPolicy = buildAgentPolicyMetadata({
        fallbackAgents: opts.fallbackAgent,
        switchOn: opts.switchOn,
        handoffOnFailure: opts.handoffOnFailure,
        preserveWorkspace: opts.preserveWorkspace,
      })

      if (isRemote) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile: opts.tokenFile, token: opts.token })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile: opts.tokenFile, token: opts.token })
        try {
          const { remoteRunStart, fetchRemoteNodes } = await import('../relay/client.js')

          let encryptionPublicKey: string | undefined
          if (opts.encrypt) {
            const nodes = await fetchRemoteNodes(opts.relay as string, token)
            const target = nodes.find(n => n.node_id === nodeSelector)
            if (!target?.encryption_public_key) {
              process.stderr.write(`error: --encrypt requires the target node to have an identity (node ${nodeSelector} has no encryption_public_key)\n`)
              process.stderr.write('       Pair the node first: vibe node pair --relay ... --token ...\n')
              process.exit(1)
            }
            encryptionPublicKey = target.encryption_public_key
          }

          const record = await remoteRunStart(opts.relay as string, token, nodeSelector, {
            agent: opts.agent as AgentBackend,
            workspaceKey: opts.workspaceKey,
            repoUrl: opts.repoUrl,
            branch: opts.branch,
            promptFile: opts.promptFile,
            permissionMode: opts.permissionMode as PermissionMode | undefined,
            ...(agentPolicy && { metadata: { agent_policy: agentPolicy } }),
            encryptionPublicKey,
          })
          process.stdout.write(JSON.stringify(record) + '\n')
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        return
      }

      let localAgent: AgentBackend
      if ((opts.agent as string) === 'auto') {
        const { selectRunner, defaultAvailability } = await import('../runtime/router.js')
        const picked = selectRunner('auto', defaultAvailability)
        if (!picked.ok) {
          process.stdout.write(JSON.stringify({
            error: true,
            code: picked.code,
            message: picked.message,
            ts: new Date().toISOString(),
          }) + '\n')
          process.exit(1)
        }
        localAgent = picked.agent
      } else {
        localAgent = opts.agent as AgentBackend
      }

      const record = await startRun({
        agent: localAgent,
        node: nodeSelector,
        workspaceKey: opts.workspaceKey,
        repoUrl: opts.repoUrl,
        branch: opts.branch,
        promptFile: opts.promptFile,
        metadataFile: opts.metadataFile,
        permissionMode: opts.permissionMode as PermissionMode | undefined,
        ...(agentPolicy && { extraMetadata: { agent_policy: agentPolicy } }),
      })
      process.stdout.write(JSON.stringify(record) + '\n')
    })

  run
    .command('stream <run_id>')
    .description('stream events for a run as JSONL')
    .option('--jsonl', 'output machine-readable JSONL to stdout (default behaviour)')
    .option('--relay <url>', 'relay WebSocket URL for remote stream')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .action(async (run_id: string, opts) => {
      if (opts.relay) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile: opts.tokenFile, token: opts.token })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile: opts.tokenFile, token: opts.token })
        try {
          const { remoteStream } = await import('../relay/client.js')
          await remoteStream(opts.relay as string, token, run_id)
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        return
      }
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
    .option('--relay <url>', 'relay WebSocket URL for remote stop')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .action(async (run_id: string, opts) => {
      if (opts.relay) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile: opts.tokenFile, token: opts.token })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile: opts.tokenFile, token: opts.token })
        try {
          const { remoteStop } = await import('../relay/client.js')
          const record = await remoteStop(opts.relay as string, token, run_id)
          process.stdout.write(JSON.stringify(record) + '\n')
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        return
      }
      const updated = stopRun(run_id)
      process.stdout.write(JSON.stringify(updated) + '\n')
    })
}
