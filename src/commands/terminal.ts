import type { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import {
  tmuxAvailable,
  tmuxSessionExists,
  validateControlBind,
  isLoopbackHost,
  generateControlToken,
  startTerminalServer,
  startRemoteTerminalServer,
} from '../lib/terminal-web.js'
import { loadProfile, resolveClientDefaults } from '../lib/node-config.js'

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
    .option('--relay <url>', 'relay WebSocket URL (remote mode; defaults to the connect-profile relay_url)')
    .option('--token <token>', 'auth token for relay (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file)')
    .option('--token-file <path>', 'read relay auth token from a file (remote mode; defaults to the connect-profile token_file)')
    .option('--host <host>', 'bind host (default 127.0.0.1; non-loopback requires --allow-control-bind)', '127.0.0.1')
    .option('--port <port>', 'port to bind (default 8790)', '8790')
    .option('--allow-control-bind', 'permit a non-loopback bind — exposes WRITE access on the network (discouraged)')
    .option('--url-file <path>', 'write the full tokenized URL to this file (0600, parent dir created) instead of printing it')
    .option('--print-url-only', 'print ONLY the full URL to stdout (for scripting), nothing else')
    .option('--quiet', 'suppress the human info/warning lines (errors still print)')
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
      if (!isLoopbackHost(host) && !opts.quiet) {
        process.stderr.write(
          `warning: WRITE-CAPABLE terminal access is now exposed on ${host} (LAN/VPN bind). The control URL is a ` +
          `SECRET — anyone who obtains it can type into the ${remote ? 'remote node' : 'tmux'} session (and any Claude ` +
          `running in it). Use on a trusted LAN/VPN only; do NOT expose this host/port to the public internet. ` +
          `Loopback + an SSH tunnel is safer.\n`,
        )
      }

      const port = Number.parseInt(opts.port as string, 10) || 8790
      const controlToken = generateControlToken()

      let server
      if (remote) {
        // Remote mode: bridge to a node over the relay. tmux lives on the node.
        // Fill relay/token-file from the connect profile when not given on CLI/env
        // (precedence: explicit flag > env > profile), like `run status`/`doctor`.
        const { relay, tokenFile } = resolveClientDefaults(
          { relay: opts.relay, token: opts.token, tokenFile: opts.tokenFile },
          loadProfile(),
          { VIBE_DIR: process.env.VIBE_DIR, VIBE_RELAY_TOKEN: process.env.VIBE_RELAY_TOKEN },
        )
        if (!relay) {
          fail('relay_required', 'no relay URL — pass --relay <url> or set relay_url in your Vibe profile (run `vibe connect`)')
        }
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        let token: string
        try {
          token = resolveRelayToken({ tokenFile, token: opts.token })
        } catch (err) {
          fail('auth_token_error', (err as Error).message)
          return
        }
        warnIfTokenArg({ tokenFile, token: opts.token })
        try {
          server = await startRemoteTerminalServer({
            session, host, port, controlToken,
            relay: relay as string, token, nodeId: opts.node as string,
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

      // Write the tokenized URL to a 0600 file if requested (parent dir created).
      // This keeps the write-capable URL out of the terminal scrollback.
      let urlFileWritten: string | undefined
      if (opts.urlFile) {
        try {
          const p = path.resolve(opts.urlFile as string)
          fs.mkdirSync(path.dirname(p), { recursive: true })
          fs.writeFileSync(p, server.url + '\n', { mode: 0o600 })
          urlFileWritten = p
        } catch (err) {
          fail('url_file_write_failed', `could not write --url-file: ${(err as Error).message}`)
          return
        }
      }

      const where = remote ? `remote node ${opts.node} session "${session}"` : `tmux session "${session}"`
      if (opts.printUrlOnly) {
        // Explicit scripting mode: the bare URL (contains the token) and nothing else.
        process.stdout.write(server.url + '\n')
      } else if (opts.json) {
        process.stdout.write(JSON.stringify({
          session,
          ...(remote ? { node: opts.node as string, remote: true } : {}),
          // With --url-file the token stays OUT of stdout — surface the path instead.
          ...(urlFileWritten ? { url_file: urlFileWritten } : { url: server.url }),
          host: server.host, port: server.port,
          mode: 'write-capable', auth: 'control-token', ts: new Date().toISOString(),
        }) + '\n')
      } else if (!opts.quiet) {
        process.stdout.write(urlFileWritten
          ? `vibe terminal: write-capable terminal for ${where} — URL written to ${urlFileWritten}  (Ctrl-C to stop)\n`
          : `vibe terminal: write-capable terminal for ${where} at ${server.url}  (Ctrl-C to stop)\n`)
      }

      const shutdown = (): void => { server!.close().finally(() => process.exit(0)) }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
}
