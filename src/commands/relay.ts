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
    .option('--token <token>', 'auth token (DEPRECATED: visible in process args; prefer VIBE_RELAY_TOKEN env or --token-file). Defaults to "dev"')
    .option('--token-file <path>', 'read the auth token from a file (kept out of process args)')
    .option('--require-pairing', 'reject node_register from unpaired nodes (MVP 4A)')
    .option('--pairings-file <path>', 'persist paired node identities here so they survive a relay restart (default: ~/.vibe/relay-pairings.json when --require-pairing; also VIBE_RELAY_PAIRINGS_FILE)')
    .action(async (opts) => {
      const port = parseInt(opts.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        process.stderr.write('error: --port must be a valid port number (1-65535)\n')
        process.exit(1)
      }

      // Accept the UNION of every configured token (rotation grace window):
      // --token-file, --token, VIBE_RELAY_TOKENS, VIBE_RELAY_TOKEN[/_CURRENT/_NEXT].
      // Falls back to the dev-server default 'dev' when nothing is configured.
      const { resolveRelayServerTokens, warnIfTokenArg } = await import('../relay/token.js')
      let tokens = resolveRelayServerTokens({ tokenFile: opts.tokenFile, token: opts.token })
      if (tokens.length === 0) tokens = ['dev']
      warnIfTokenArg({ tokenFile: opts.tokenFile, token: opts.token })

      // Pairing persistence: explicit flag/env, else default under ~/.vibe when
      // require-pairing is on. Off (in-memory only) otherwise.
      const path = await import('node:path')
      const { vibeDir } = await import('../config.js')
      const pairingsFile: string | undefined =
        opts.pairingsFile ??
        process.env.VIBE_RELAY_PAIRINGS_FILE ??
        (opts.requirePairing ? path.join(vibeDir(), 'relay-pairings.json') : undefined)

      const { startRelayServer } = await import('../relay/server.js')
      const server = await startRelayServer({
        port,
        host: opts.host,
        token: tokens[0],
        tokens,
        requirePairing: Boolean(opts.requirePairing),
        pairingsFile,
      })

      const isDevDefault = tokens.length === 1 && tokens[0] === 'dev'
      const boundHost = opts.host === '0.0.0.0' ? '0.0.0.0' : opts.host
      process.stderr.write(
        `[vibe-relay] dev relay started (plaintext + signed — no payload encryption)\n` +
        `[vibe-relay] listening on ws://${boundHost}:${server.port}\n` +
        `[vibe-relay] tokens: ${isDevDefault ? 'dev (default)' : `${tokens.length} accepted [REDACTED]`}\n` +
        (opts.requirePairing ? `[vibe-relay] require-pairing: ON — unpaired nodes will be rejected\n` : '') +
        (pairingsFile ? `[vibe-relay] pairing persistence: ${pairingsFile}\n` : `[vibe-relay] pairing persistence: OFF (in-memory only)\n`) +
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
