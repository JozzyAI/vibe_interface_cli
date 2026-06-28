import type { Command } from 'commander'
import { spawnSync } from 'child_process'
import { readRun } from '../store.js'
import { streamEvents } from '../events.js'
import { startRun, stopRun, resolveAttach } from '../lib/run-actions.js'
import { resolveWebTarget, tmuxAvailable, validateBind, startViewerServer } from '../lib/run-web.js'
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

  run
    .command('attach <run_id>')
    .description('attach to a local run\'s live tmux session (local runs only)')
    .option('--json', 'print the attach decision as JSON instead of attaching interactively')
    .action((run_id: string, opts) => {
      const result = resolveAttach(run_id) // readRun inside exits 3 if the run is unknown
      if (!result.ok) {
        process.stdout.write(JSON.stringify({
          error: true,
          code: result.code,
          run_id: result.run_id,
          status: result.status,
          message: result.message,
          ts: new Date().toISOString(),
        }) + '\n')
        process.exit(1)
      }

      // A non-interactive caller (no TTY, or --json) can't host an interactive
      // tmux client, so report how to attach instead of attaching.
      if (opts.json || !process.stdout.isTTY) {
        process.stdout.write(JSON.stringify({
          run_id: result.run_id,
          session_id: result.session_id,
          mode: result.mode,
          attach_command: `tmux attach -t ${result.tmux_session}`,
          ts: new Date().toISOString(),
        }) + '\n')
        return
      }

      const r = spawnSync('tmux', ['attach', '-t', result.tmux_session], { stdio: 'inherit' })
      process.exit(r.status ?? 0)
    })

  run
    .command('web <run_id>')
    .description('serve a personal, local, read-only web viewer for a run (local tmux runs, or a remote run with --node)')
    .option('--node <node_id>', 'view a REMOTE run owned by this node over the relay (read-only)')
    .option('--relay <url>', 'relay WebSocket URL (required with --node)')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file')
    .option('--port <port>', 'port to bind (default: an ephemeral free port)', '0')
    .option('--host <host>', 'host to bind (default: 127.0.0.1 — private)', '127.0.0.1')
    .option('--allow-public-bind', 'permit binding a non-loopback host (exposes the session on the network)')
    .option('--json', 'print the listening URL as JSON and keep serving')
    .action(async (run_id: string, opts) => {
      const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => {
        process.stdout.write(JSON.stringify({ error: true, code, run_id, message, ...extra, ts: new Date().toISOString() }) + '\n')
        process.exit(1)
      }

      // Remote viewer branch: --node => view a run on another node over the relay.
      if (opts.node) {
        await serveRemoteWebViewer(run_id, opts, fail)
        return
      }

      // 1. Refuse a public bind unless explicitly allowed.
      const bind = validateBind(opts.host as string, Boolean(opts.allowPublicBind))
      if (!bind.ok) fail(bind.code, bind.message)
      if (!('ok' in bind) || !bind.ok) return
      if (opts.allowPublicBind && !['127.0.0.1', 'localhost', '::1'].includes(opts.host)) {
        process.stderr.write(`warning: binding ${opts.host} exposes this run's session on the network. The viewer is read-only, but anyone who can reach this host can watch it.\n`)
      }

      // 2. The viewer's only hard dependency is tmux.
      if (!tmuxAvailable()) {
        fail('web_viewer_dependency_missing', 'the web viewer requires tmux (tmux -V failed); install tmux or use `vibe run stream` instead')
        return
      }

      // 3. Resolve the run to a live tmux session (readRun exits 3 if unknown).
      const target = resolveWebTarget(run_id)
      if (!target.ok) {
        fail(target.code, target.message, { status: target.status })
        return
      }

      // 4. Start the read-only server.
      const port = Number.parseInt(opts.port as string, 10) || 0
      let server
      try {
        server = await startViewerServer({ run_id, tmux_session: target.tmux_session, host: bind.host, port })
      } catch (err) {
        fail('web_viewer_start_failed', `failed to bind ${bind.host}:${port}: ${(err as Error).message}`)
        return
      }

      const info = { run_id, session_id: target.tmux_session, url: server.url, host: server.host, port: server.port, mode: 'read-only', ts: new Date().toISOString() }
      if (opts.json) {
        process.stdout.write(JSON.stringify(info) + '\n')
      } else {
        process.stdout.write(`vibe run web: read-only viewer for ${run_id} at ${server.url}  (Ctrl-C to stop)\n`)
      }

      const shutdown = () => { server!.close().finally(() => process.exit(0)) }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
}

/**
 * Read-only personal web viewer for a REMOTE run (owned by another node, reached
 * over the relay). Private by default (127.0.0.1); reuses the existing
 * remoteRunStatus/remoteStream relay APIs; stop stays a CLI op (no browser
 * control). Token comes from --token-file/env (never echoed).
 */
async function serveRemoteWebViewer(
  run_id: string,
  opts: Record<string, unknown>,
  fail: (code: string, message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const node_id = opts.node as string
  if (!opts.relay) { fail('relay_required', '--relay <url> is required with --node', { node_id }); return }

  // 1. Refuse a public bind unless explicitly allowed (same rule as the local viewer).
  const bind = validateBind(opts.host as string, Boolean(opts.allowPublicBind))
  if (!bind.ok) { fail(bind.code, bind.message, { node_id }); return }
  if (opts.allowPublicBind && !['127.0.0.1', 'localhost', '::1'].includes(opts.host as string)) {
    process.stderr.write(`warning: binding ${opts.host} exposes this remote run's viewer on the network. It is read-only, but anyone who can reach this host can watch it.\n`)
  }

  // 2. Resolve the relay token without putting it in argv.
  const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
  let token: string
  try {
    token = resolveRelayToken({ tokenFile: opts.tokenFile as string | undefined, token: opts.token as string | undefined })
  } catch (err) {
    fail('auth_token_error', (err as Error).message, { node_id })
    return
  }
  warnIfTokenArg({ tokenFile: opts.tokenFile as string | undefined, token: opts.token as string | undefined })

  const { remoteRunStatus, remoteStream } = await import('../relay/client.js')
  const { RemoteRunBuffer, mapRemoteStatusError, startRemoteViewerServer } = await import('../lib/run-web-remote.js')

  // 3. Pre-flight: confirm the node is online and the run exists (structured codes).
  let record
  try {
    record = await remoteRunStatus(opts.relay as string, token, run_id)
  } catch (err) {
    const mapped = mapRemoteStatusError(err)
    fail(mapped.code, mapped.message, { node_id })
    return
  }

  // 4. Background subscription fills the buffer the viewer serves. A stream error
  //    just ends the buffer — the viewer keeps serving the last snapshot.
  const buffer = new RemoteRunBuffer(run_id, node_id, record.status)
  const controller = new AbortController()
  void remoteStream(opts.relay as string, token, run_id, {
    onRunEvent: (ev) => buffer.push(ev),
    suppressStdout: true,
    signal: controller.signal,
  }).catch(() => buffer.markEnded())

  // 5. Start the read-only HTTP viewer.
  const port = Number.parseInt(opts.port as string, 10) || 0
  let server
  try {
    server = await startRemoteViewerServer({ run_id, node_id, host: bind.host, port, buffer })
  } catch (err) {
    controller.abort()
    fail('web_viewer_start_failed', `failed to bind ${bind.host}:${port}: ${(err as Error).message}`, { node_id })
    return
  }

  const info = { run_id, node_id, url: server.url, host: server.host, port: server.port, mode: 'read-only', remote: true, ts: new Date().toISOString() }
  if (opts.json) {
    process.stdout.write(JSON.stringify(info) + '\n')
  } else {
    process.stdout.write(`vibe run web: read-only REMOTE viewer for ${run_id} (node ${node_id}) at ${server.url}  (Ctrl-C to stop)\n`)
  }

  const shutdown = () => { controller.abort(); server!.close().finally(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
