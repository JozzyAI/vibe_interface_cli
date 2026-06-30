import type { Command } from 'commander'
import { spawnSync } from 'child_process'
import { readRun } from '../store.js'
import { streamEvents } from '../events.js'
import { startRun, stopRun, resolveAttach } from '../lib/run-actions.js'
import { resolveWebTarget, tmuxAvailable, validateBind, startViewerServer, generateAccessToken } from '../lib/run-web.js'
import { addViewer, removeViewer, generateViewerId, listActiveViewers, findViewer } from '../lib/viewer-registry.js'
import { loadProfile, resolveClientDefaults } from '../lib/node-config.js'
import { buildRunErrorEnvelope, runErrorExitCode } from '../lib/run-error.js'
import { buildAgentPolicyMetadata } from '../runtime/policy.js'
import type { AgentBackend, PermissionMode } from '../types.js'

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

/**
 * Record an active viewer in the local registry (best-effort — a registry failure
 * must never break the viewer). Stores base URL + pid only: never the relay token
 * or the access token. Returns the viewer_id for later removal.
 */
function recordViewer(args: {
  run_id: string
  node_id?: string
  mode: 'local' | 'remote'
  server: { url: string; host: string; port: number }
  accessToken?: string
}): string | undefined {
  try {
    const now = new Date().toISOString()
    const viewer_id = generateViewerId()
    addViewer({
      viewer_id,
      run_id: args.run_id,
      ...(args.node_id ? { node_id: args.node_id } : {}),
      mode: args.mode,
      url: args.server.url, // base host:port — no ?access token
      host: args.server.host,
      port: args.server.port,
      pid: process.pid,
      auth: args.accessToken ? 'token' : 'none',
      created_at: now,
      updated_at: now,
    })
    return viewer_id
  } catch {
    return undefined
  }
}

function safeRemoveViewer(viewer_id: string | undefined): void {
  if (!viewer_id) return
  try { removeViewer(viewer_id) } catch { /* best-effort */ }
}

/** A one-time viewer access token for a non-loopback (public) bind; none for loopback. */
function viewerAccessToken(host: string): string | undefined {
  return LOOPBACK_HOSTS.includes(host) ? undefined : generateAccessToken()
}

/** Operator-facing URL: carries the access token as a query when one is required. */
function accessUrl(baseUrl: string, accessToken?: string): string {
  return accessToken ? `${baseUrl}/?access=${accessToken}` : baseUrl
}

/**
 * Render a remote run failure for `run start/stream/stop`: a stable,
 * machine-readable error envelope to stdout (the contract an orchestrator
 * branches on) plus a short human line to stderr, then exit with the mapped
 * code (3 for run_not_found, else 1). Never prints a token. Never returns.
 */
function failRemote(err: unknown, run_id?: string): never {
  const env = buildRunErrorEnvelope(err, run_id ? { run_id } : {})
  process.stdout.write(JSON.stringify(env) + '\n')
  process.stderr.write(`error: ${env.code}: ${env.message}\n`)
  process.exit(runErrorExitCode(env.code))
}

export function registerRunCommand(program: Command): void {
  const run = program.command('run').description('manage runs')

  // After `vibe connect`, every run subcommand reads VIBE_DIR from the profile so a
  // custom `connect --vibe-dir` stays consistent across the namespace: `run start`
  // writes records into it and `run stream/stop/status/attach` (and the viewer
  // registry) read from the same place. Precedence: env VIBE_DIR > profile.vibe_dir
  // > default ~/.vibe. This only sets a state directory — no viewer behavior changes.
  // (relay/token-file defaults are applied per-command in start/stream/stop only.)
  run.hook('preAction', () => {
    if (!process.env.VIBE_DIR) {
      const vibeDir = loadProfile()?.vibe_dir
      if (vibeDir) process.env.VIBE_DIR = vibeDir
    }
  })

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

          const record = await remoteRunStart(relay as string, token, nodeSelector, {
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
          failRemote(err)
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
          // Pre-flight existence/reachability check (same pattern as the remote
          // web viewer): the stream itself swallows a fatal run_not_found into a
          // graceful `stream_disconnected` event, so without this an unknown run
          // would exit 0. Confirming status first lets an unknown run surface a
          // structured run_not_found envelope (exit 3) — and node_offline /
          // unauthorized / relay_unavailable up front — before streaming.
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

  run
    .command('status <run_id>')
    .description('get current status of a run')
    .option('--json', 'output machine-readable JSON to stdout (default behaviour)')
    .option('--relay <url>', 'relay WebSocket URL: query the owning node for authoritative remote status')
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
          const { remoteRunStatus } = await import('../relay/client.js')
          const record = await remoteRunStatus(relay, token, run_id)
          process.stdout.write(JSON.stringify(record) + '\n')
        } catch (err) {
          failRemote(err, run_id)
        }
        return
      }
      const record = readRun(run_id) // local path: exits 3 if not found
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
        process.stderr.write(`warning: binding ${opts.host} exposes this run's session on the network. The viewer is read-only and now gated by a one-time access token (in the printed URL); only someone with that URL can watch it.\n`)
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

      // 4. Start the read-only server. A non-loopback (public) bind is gated by a
      //    one-time access token; loopback stays frictionless (no token).
      const port = Number.parseInt(opts.port as string, 10) || 0
      const accessToken = viewerAccessToken(bind.host)
      let server
      try {
        server = await startViewerServer({ run_id, tmux_session: target.tmux_session, host: bind.host, port, accessToken })
      } catch (err) {
        fail('web_viewer_start_failed', `failed to bind ${bind.host}:${port}: ${(err as Error).message}`)
        return
      }

      const url = accessUrl(server.url, accessToken)
      const viewer_id = recordViewer({ run_id, mode: 'local', server, accessToken })
      const info = { run_id, viewer_id, session_id: target.tmux_session, url, host: server.host, port: server.port, mode: 'read-only', auth: accessToken ? 'token' : 'none', ts: new Date().toISOString() }
      if (opts.json) {
        process.stdout.write(JSON.stringify(info) + '\n')
      } else {
        process.stdout.write(`vibe run web: read-only viewer for ${run_id} at ${url}  (Ctrl-C to stop)\n`)
      }

      const shutdown = () => { safeRemoveViewer(viewer_id); server!.close().finally(() => process.exit(0)) }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })

  // ── run viewers: manage the local registry of active web viewers ────────────
  const viewers = run
    .command('viewers')
    .description('list / open / stop active personal web viewers (local registry)')

  viewers
    .command('list')
    .description('list active viewers (dead-pid records are pruned)')
    .option('--json', 'output machine-readable JSON')
    .action((opts) => {
      const { live, pruned } = listActiveViewers()
      if (opts.json) {
        process.stdout.write(JSON.stringify({ viewers: live, pruned }) + '\n')
        return
      }
      if (live.length === 0) {
        process.stdout.write('no active viewers\n')
        return
      }
      for (const v of live) {
        const ageS = Math.max(0, Math.round((Date.now() - new Date(v.created_at).getTime()) / 1000))
        const node = v.node_id ? `  node ${v.node_id}` : ''
        process.stdout.write(`${v.run_id}  ${v.viewer_id}  ${v.mode}  ${v.url}  pid ${v.pid}  auth:${v.auth}  ${ageS}s${node}\n`)
      }
    })

  viewers
    .command('open <target>')
    .description('print the URL of an active viewer (by run_id or viewer_id)')
    .option('--json', 'output machine-readable JSON')
    .action((target: string, opts) => {
      const v = findViewer(target)
      if (!v) {
        process.stdout.write(JSON.stringify({ error: true, code: 'viewer_not_found', target, message: `no active viewer for ${target}`, ts: new Date().toISOString() }) + '\n')
        process.exit(1)
      }
      // The access token is never stored, so a public-bind viewer's full ?access=
      // URL cannot be reconstructed — print the base URL and say so. Loopback URLs
      // need no token and work as-is.
      const note = v.auth === 'token'
        ? 'this viewer requires its one-time access token, shown only in the output when it started'
        : undefined
      if (opts.json) {
        process.stdout.write(JSON.stringify({ viewer_id: v.viewer_id, run_id: v.run_id, mode: v.mode, url: v.url, auth: v.auth, ...(note ? { note } : {}) }) + '\n')
      } else {
        process.stdout.write(`${v.url}${note ? `  (${note})` : ''}\n`)
      }
    })

  viewers
    .command('stop <target>')
    .description('stop a LOCAL viewer process (by run_id or viewer_id) — does NOT stop the remote run')
    .option('--json', 'output machine-readable JSON')
    .action((target: string, opts) => {
      const v = findViewer(target)
      if (!v) {
        process.stdout.write(JSON.stringify({ error: true, code: 'viewer_not_found', target, message: `no active viewer for ${target}`, ts: new Date().toISOString() }) + '\n')
        process.exit(1)
      }
      try { process.kill(v.pid, 'SIGTERM') } catch { /* already gone */ }
      removeViewer(v.viewer_id)
      const out = { stopped: true, viewer_id: v.viewer_id, run_id: v.run_id, pid: v.pid, ts: new Date().toISOString() }
      if (opts.json) {
        process.stdout.write(JSON.stringify(out) + '\n')
      } else {
        process.stdout.write(`stopped viewer ${v.viewer_id} (run ${v.run_id}, pid ${v.pid})\n`)
      }
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
    process.stderr.write(`warning: binding ${opts.host} exposes this remote run's viewer on the network. It is read-only and now gated by a one-time access token (in the printed URL); only someone with that URL can watch it.\n`)
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

  // 4. Background subscription fills the buffer the viewer serves. Connection
  //    state feeds the UI's live/reconnecting/disconnected chip; when the stream
  //    settles the buffer is finalized either way, so the viewer keeps serving the
  //    last snapshot and clearly shows ended vs disconnected.
  const buffer = new RemoteRunBuffer(run_id, node_id, record.status)
  const controller = new AbortController()
  void remoteStream(opts.relay as string, token, run_id, {
    onRunEvent: (ev) => buffer.push(ev),
    onEvent: (s) => buffer.setStreamState(s),
    suppressStdout: true,
    signal: controller.signal,
  })
    .then(() => buffer.markEnded())
    .catch(() => buffer.markEnded('disconnected'))

  // 5. Start the read-only HTTP viewer. A non-loopback (public) bind is gated by a
  //    one-time access token; loopback stays frictionless (no token).
  const port = Number.parseInt(opts.port as string, 10) || 0
  const accessToken = viewerAccessToken(bind.host)
  let server
  try {
    server = await startRemoteViewerServer({ run_id, node_id, host: bind.host, port, buffer, accessToken })
  } catch (err) {
    controller.abort()
    fail('web_viewer_start_failed', `failed to bind ${bind.host}:${port}: ${(err as Error).message}`, { node_id })
    return
  }

  const url = accessUrl(server.url, accessToken)
  const viewer_id = recordViewer({ run_id, node_id, mode: 'remote', server, accessToken })
  const info = { run_id, viewer_id, node_id, url, host: server.host, port: server.port, mode: 'read-only', remote: true, auth: accessToken ? 'token' : 'none', ts: new Date().toISOString() }
  if (opts.json) {
    process.stdout.write(JSON.stringify(info) + '\n')
  } else {
    process.stdout.write(`vibe run web: read-only REMOTE viewer for ${run_id} (node ${node_id}) at ${url}  (Ctrl-C to stop)\n`)
  }

  const shutdown = () => { safeRemoveViewer(viewer_id); controller.abort(); server!.close().finally(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
