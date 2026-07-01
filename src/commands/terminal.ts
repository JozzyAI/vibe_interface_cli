import type { Command } from 'commander'
import {
  tmuxAvailable,
  tmuxSessionExists,
  validateControlBind,
  isLoopbackHost,
  generateControlToken,
  startTerminalServer,
  startRemoteTerminalServer,
} from '../lib/terminal-web.js'

/**
 * `vibe terminal` — a WRITE-CAPABLE web terminal.
 *
 *   local (PR #41):   vibe terminal serve --session <local-tmux-session>
 *   remote (this PR): vibe terminal serve --node <id> --session <name> --relay <ws> --token-file <path>
 *
 * Local mode drives a LOCAL tmux session directly. Remote mode is a gateway:
 * the browser bridges over the relay to the node's terminal (echo skeleton for
 * now — no node-side tmux yet). Loopback-only by default; a control token gates
 * the page and the WS.
 */
export function registerTerminalCommand(program: Command): void {
  const terminal = program.command('terminal').description('interactive web terminal (local tmux, or remote node over the relay)')

  terminal
    .command('serve')
    .description('serve a browser terminal for a local tmux session, or a remote node over the relay (write-capable)')
    .requiredOption('--session <name>', 'tmux session name (local: existing session; remote: node-side session)')
    .option('--node <node_id>', 'REMOTE mode: bridge to this node over the relay instead of a local tmux session')
    .option('--relay <url>', 'relay WebSocket URL (required with --node)')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file (required with --node unless --token/env)')
    .option('--host <host>', 'bind host (default 127.0.0.1; non-loopback requires --allow-control-bind)', '127.0.0.1')
    .option('--port <port>', 'port to bind (default 8790)', '8790')
    .option('--allow-control-bind', 'permit a non-loopback bind — exposes WRITE access on the network (discouraged)')
    .option('--json', 'print the listening URL as JSON and keep serving')
    .action(async (opts) => {
      const fail = (code: string, message: string): never => {
        process.stdout.write(JSON.stringify({ error: true, code, message, ts: new Date().toISOString() }) + '\n')
        process.exit(1)
      }

      const session = opts.session as string
      const host = opts.host as string
      const remote = Boolean(opts.node)

      // Bind guard (both modes): refuse a non-loopback bind unless allowed, warn loudly.
      const bind = validateControlBind(host, Boolean(opts.allowControlBind))
      if (!bind.ok) fail(bind.code, bind.message)
      if (!isLoopbackHost(host)) {
        process.stderr.write(
          `warning: --allow-control-bind exposes a WRITE-CAPABLE terminal on ${host}. Anyone who obtains the URL ` +
          `(one-time control token) can type into the ${remote ? 'remote node' : 'tmux'} session. Prefer loopback + an SSH tunnel.\n`,
        )
      }

      const port = Number.parseInt(opts.port as string, 10) || 8790
      const controlToken = generateControlToken()

      let server
      if (remote) {
        // Remote mode: bridge to a node over the relay. tmux lives on the node.
        if (!opts.relay) fail('relay_required', '--relay <url> is required with --node')
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile: opts.tokenFile, token: opts.token })
        } catch (err) {
          fail('auth_token_error', (err as Error).message)
          return
        }
        warnIfTokenArg({ tokenFile: opts.tokenFile, token: opts.token })
        try {
          server = await startRemoteTerminalServer({
            session, host, port, controlToken,
            relay: opts.relay as string, token, nodeId: opts.node as string,
          })
        } catch (err) {
          fail('terminal_start_failed', `failed to bind ${host}:${port}: ${(err as Error).message}`)
          return
        }
      } else {
        // Local mode (unchanged): drive a LOCAL tmux session.
        if (!tmuxAvailable()) {
          fail('terminal_dependency_missing', 'the web terminal requires tmux (tmux -V failed); install tmux first')
        }
        if (!tmuxSessionExists(session)) {
          fail('tmux_session_not_found', `no tmux session named "${session}" — create it first, e.g. \`tmux new -d -s ${session} 'bash'\``)
        }
        try {
          server = await startTerminalServer({ session, host, port, controlToken })
        } catch (err) {
          fail('terminal_start_failed', `failed to bind ${host}:${port}: ${(err as Error).message}`)
          return
        }
      }

      const info = {
        session,
        ...(remote ? { node: opts.node as string, remote: true } : {}),
        url: server.url,
        host: server.host,
        port: server.port,
        mode: 'write-capable',
        auth: 'control-token',
        ts: new Date().toISOString(),
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(info) + '\n')
      } else {
        const where = remote ? `remote node ${opts.node} session "${session}"` : `tmux session "${session}"`
        process.stdout.write(`vibe terminal: write-capable terminal for ${where} at ${server.url}  (Ctrl-C to stop)\n`)
      }

      const shutdown = (): void => { server!.close().finally(() => process.exit(0)) }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
}
