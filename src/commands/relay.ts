import type { Command } from 'commander'

export function registerRelayCommand(program: Command): void {
  const relay = program.command('relay').description('manage the Vibe relay server')

  relay
    .command('dev')
    .description(
      'start a local dev relay server (plaintext — E2E encryption planned for MVP 4)',
    )
    .option('--port <port>', 'port to listen on', '7433')
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
        token: opts.token,
        requirePairing: Boolean(opts.requirePairing),
      })

      process.stderr.write(
        `[vibe-relay] dev relay started (plaintext + signed — no payload encryption)\n` +
        `[vibe-relay] listening on ws://localhost:${server.port}\n` +
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
