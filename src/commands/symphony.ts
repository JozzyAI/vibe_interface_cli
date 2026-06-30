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
import { loadProfile, resolveClientDefaults } from '../lib/node-config.js'
import { failRemote } from '../lib/run-error.js'
import { buildAgentPolicyMetadata } from '../runtime/policy.js'
import type { AgentBackend, PermissionMode } from '../types.js'

export function registerSymphonyCommand(program: Command): void {
  const sym = program.command('symphony').description('Symphony orchestrator integration')

  // Mirror `vibe run`: after `vibe connect`, every symphony subcommand reads
  // VIBE_DIR from the profile so local run-record lookup is consistent across
  // the namespace. Precedence: env VIBE_DIR > profile.vibe_dir > default ~/.vibe.
  sym.hook('preAction', () => {
    if (!process.env.VIBE_DIR) {
      const vibeDir = loadProfile()?.vibe_dir
      if (vibeDir) process.env.VIBE_DIR = vibeDir
    }
  })

  sym
    .command('start')
    .description('start a Symphony-dispatched run')
    .option('--issue-id <id>', 'Symphony issue / task ID')
    .option('--issue-title <title>', 'human-readable issue title')
    .option('--agent <backend>', 'agent backend (mock, claude-code, codex, opencode)', 'mock')
    .option('--fallback-agent <agents...>', 'fallback agent(s) to try on a recoverable failure (repeatable or comma-separated)')
    .option('--switch-on <reasons>', 'comma-separated failure reasons that trigger fallback (default: session_limit,usage_limit,quota_exceeded,rate_limited)')
    .option('--handoff-on-failure', 'write a handoff doc when switching agents (default: on)')
    .option('--preserve-workspace', 'reuse the same workspace/branch for the fallback agent (default: on)')
    .option('--repo-url <url>', 'git repo to clone into workspace')
    .option('--branch <branch>', 'branch to checkout (default: repo default)')
    .option('--workspace-key <key>', 'unique workspace directory key (default: issue-id or run_id)')
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
      // Fill relay/token-file from the connect profile when not given on CLI/env.
      const { relay, tokenFile } = resolveClientDefaults(
        { relay: opts.relay, token: opts.token, tokenFile: opts.tokenFile },
        loadProfile(),
        { VIBE_DIR: process.env.VIBE_DIR, VIBE_RELAY_TOKEN: process.env.VIBE_RELAY_TOKEN },
      )
      const isRemote = relay && nodeSelector !== 'auto' && nodeSelector !== 'local'

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
          token = resolveRelayToken({ tokenFile, token: opts.token })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile, token: opts.token })
        try {
          const { remoteRunStart, fetchRemoteNodes } = await import('../relay/client.js')

          let encryptionPublicKey: string | undefined
          if (opts.encrypt) {
            const nodes = await fetchRemoteNodes(relay as string, token)
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
          if (agentPolicy) extraMetadata.agent_policy = agentPolicy
          const record = await remoteRunStart(relay as string, token, nodeSelector, {
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
          failRemote(err)
        }
        return
      }

      const extraMetadata: Record<string, unknown> = { source: 'symphony' }
      if (opts.issueId) extraMetadata.issue_id = opts.issueId
      if (opts.issueTitle) extraMetadata.issue_title = opts.issueTitle
      if (agentPolicy) extraMetadata.agent_policy = agentPolicy

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
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .action(async (run_id: string, opts) => {
      // Fill relay/token-file from the connect profile when not given on CLI/env.
      const { relay, tokenFile } = resolveClientDefaults(
        { relay: opts.relay, token: opts.token, tokenFile: opts.tokenFile },
        loadProfile(),
        { VIBE_DIR: process.env.VIBE_DIR, VIBE_RELAY_TOKEN: process.env.VIBE_RELAY_TOKEN },
      )
      if (relay) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile, token: opts.token })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile, token: opts.token })
        try {
          const { remoteRunStatus, remoteStream } = await import('../relay/client.js')
          // Pre-flight existence/reachability check (same as `vibe run stream`):
          // the stream swallows a fatal run_not_found into a graceful
          // `stream_disconnected` event, so confirming status first lets an
          // unknown run surface a structured run_not_found envelope (exit 3).
          await remoteRunStatus(relay, token, run_id)
          await remoteStream(relay, token, run_id)
        } catch (err) {
          failRemote(err, run_id)
        }
        return
      }
      readRun(run_id) // validates existence, exits 3 if not found
      streamEvents(run_id)
    })

  sym
    .command('status <run_id>')
    .description('get current status of a Symphony run')
    .option('--relay <url>', 'relay WebSocket URL: query the owning node for authoritative remote status')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action(async (run_id: string, opts) => {
      // Fill relay/token-file from the connect profile when not given on CLI/env.
      const { relay, tokenFile } = resolveClientDefaults(
        { relay: opts.relay, token: opts.token, tokenFile: opts.tokenFile },
        loadProfile(),
        { VIBE_DIR: process.env.VIBE_DIR, VIBE_RELAY_TOKEN: process.env.VIBE_RELAY_TOKEN },
      )
      if (relay) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile, token: opts.token })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile, token: opts.token })
        try {
          const { remoteRunStatus } = await import('../relay/client.js')
          const record = await remoteRunStatus(relay, token, run_id)
          process.stdout.write(JSON.stringify(record) + '\n')
        } catch (err) {
          failRemote(err, run_id)
        }
        return
      }
      const record = readRun(run_id)
      process.stdout.write(JSON.stringify(record) + '\n')
    })

  sym
    .command('stop <run_id>')
    .description('stop a Symphony run')
    .option('--reason <reason>', 'human-readable reason for stopping')
    .option('--relay <url>', 'relay WebSocket URL for remote stop')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .action(async (run_id: string, opts) => {
      // Fill relay/token-file from the connect profile when not given on CLI/env.
      const { relay, tokenFile } = resolveClientDefaults(
        { relay: opts.relay, token: opts.token, tokenFile: opts.tokenFile },
        loadProfile(),
        { VIBE_DIR: process.env.VIBE_DIR, VIBE_RELAY_TOKEN: process.env.VIBE_RELAY_TOKEN },
      )
      if (relay) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile, token: opts.token })
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`)
          process.exit(1)
        }
        warnIfTokenArg({ tokenFile, token: opts.token })
        try {
          const { remoteStop } = await import('../relay/client.js')
          const record = await remoteStop(relay, token, run_id)
          process.stdout.write(JSON.stringify(record) + '\n')
        } catch (err) {
          failRemote(err, run_id)
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
