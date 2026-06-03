import type { Command } from 'commander'

export function registerRelayCommand(program: Command): void {
  const relay = program.command('relay').description('manage the Vibe relay server')

  relay
    .command('dev')
    .description(
      'start a dev relay server (plaintext transport, E2E encrypted payloads)',
    )
    .option('--port <port>', 'port to listen on', '7433')
    .option('--host <host>', 'bind address (default: 127.0.0.1; use 0.0.0.0 for all interfaces)', '127.0.0.1')
    .option('--token <token>', 'auth token', 'dev')
    .option('--require-pairing', 'reject node_register from unpaired nodes (MVP 4A)')
    .action(async (opts) => {
      const port = parseInt(opts.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        process.stderr.write('error: --port must be a valid port number (1-65535)\n')
        process.exit(1)
      }

      const { startRelayServer } = await import('../relay/server.js')
      const server = await startRelayServer({
        port,
        host: opts.host,
        token: opts.token,
        requirePairing: Boolean(opts.requirePairing),
      })

      const boundHost = opts.host === '0.0.0.0' ? '0.0.0.0' : opts.host
      process.stderr.write(
        `[vibe-relay] dev relay started (plaintext + signed — no payload encryption)\n` +
        `[vibe-relay] listening on ws://${boundHost}:${server.port}\n` +
        `[vibe-relay] token: ${opts.token}\n` +
        (opts.requirePairing ? `[vibe-relay] require-pairing: ON — unpaired nodes will be rejected\n` : '') +
        `[vibe-relay] Ctrl-C to stop\n`,
      )

      function shutdown(signal: string): void {
        process.stderr.write(`\n[vibe-relay] received ${signal}, shutting down\n`)
        server.close().then(() => process.exit(0))
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))

      await new Promise<never>(() => {})
    })
}
