import type { Command } from 'commander'
import {
  tmuxAvailable,
  tmuxSessionExists,
  validateControlBind,
  isLoopbackHost,
  generateControlToken,
  startTerminalServer,
} from '../lib/terminal-web.js'

/**
 * `vibe terminal` — a local, WRITE-CAPABLE web terminal for an existing tmux
 * session. Loopback-only by default; a control token gates the page and the WS.
 * This is the Terminal Mode MVP: local tmux only (no relay, no agent launching).
 */
export function registerTerminalCommand(program: Command): void {
  const terminal = program.command('terminal').description('interactive web terminal for a local tmux session')

  terminal
    .command('serve')
    .description('serve a browser terminal bound to an existing local tmux session (write-capable)')
    .requiredOption('--session <name>', 'name of an EXISTING tmux session to attach to')
    .option('--host <host>', 'bind host (default 127.0.0.1; non-loopback requires --allow-control-bind)', '127.0.0.1')
    .option('--port <port>', 'port to bind (default 8790)', '8790')
    .option('--allow-control-bind', 'permit a non-loopback bind — exposes WRITE access on the network (discouraged)')
    .option('--json', 'print the listening URL as JSON and keep serving')
    .action(async (opts) => {
      const fail = (code: string, message: string): never => {
        process.stdout.write(JSON.stringify({ error: true, code, message, ts: new Date().toISOString() }) + '\n')
        process.exit(1)
      }

      // 1. tmux must be available.
      if (!tmuxAvailable()) {
        fail('terminal_dependency_missing', 'the web terminal requires tmux (tmux -V failed); install tmux first')
      }

      // 2. The session must already exist (we never create shells/sessions).
      const session = opts.session as string
      if (!tmuxSessionExists(session)) {
        fail('tmux_session_not_found', `no tmux session named "${session}" — create it first, e.g. \`tmux new -d -s ${session} 'bash'\``)
      }

      // 3. Refuse a non-loopback bind unless explicitly allowed.
      const host = opts.host as string
      const bind = validateControlBind(host, Boolean(opts.allowControlBind))
      if (!bind.ok) {
        fail(bind.code, bind.message)
      }

      // 4. Loud warning on a network-exposed WRITE-capable bind.
      if (!isLoopbackHost(host)) {
        process.stderr.write(
          `warning: --allow-control-bind exposes a WRITE-CAPABLE terminal on ${host}. Anyone who obtains the URL ` +
          `(one-time control token) can type into the tmux session. Prefer loopback + an SSH tunnel.\n`,
        )
      }

      const port = Number.parseInt(opts.port as string, 10) || 8790
      const controlToken = generateControlToken()

      let server
      try {
        server = await startTerminalServer({ session, host, port, controlToken })
      } catch (err) {
        fail('terminal_start_failed', `failed to bind ${host}:${port}: ${(err as Error).message}`)
        return
      }

      const info = {
        session,
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
        process.stdout.write(`vibe terminal: write-capable terminal for tmux session "${session}" at ${server.url}  (Ctrl-C to stop)\n`)
      }

      const shutdown = (): void => { server!.close().finally(() => process.exit(0)) }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
}
