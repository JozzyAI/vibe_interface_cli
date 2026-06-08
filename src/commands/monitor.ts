/**
 * `vibe monitor telegram` — read-only Telegram status reporter.
 *
 * Polls the relay, local run store, and (optionally) the Symphony workdir and
 * Linear, and pushes alerts plus answers /status /nodes /runs /symphony
 * /linear /help to a single Telegram chat. Strictly observational: see
 * ../monitor/telegram/monitor.ts for the read-only contract this enforces.
 */
import type { Command } from 'commander'

const REQUIRED_ENV = ['VIBE_RELAY_URL', 'VIBE_RELAY_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const

export function registerMonitorCommand(program: Command): void {
  const monitor = program.command('monitor').description('read-only status monitors (no workflow control)')

  monitor
    .command('telegram')
    .description('run a read-only Telegram bot that reports relay/node/run status')
    .option('--poll-interval <seconds>', 'how often to collect and diff status (default: 60)', '60')
    .action(async (opts) => {
      const missing = REQUIRED_ENV.filter((name) => !process.env[name])
      if (missing.length > 0) {
        process.stderr.write(`error: missing required environment variable(s): ${missing.join(', ')}\n`)
        process.stderr.write('       required: VIBE_RELAY_URL, VIBE_RELAY_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID\n')
        process.stderr.write('       optional: SYMPHONY_WORKDIR, LINEAR_API_KEY\n')
        process.exit(1)
      }

      const pollIntervalSeconds = parseInt(opts.pollInterval, 10)
      if (isNaN(pollIntervalSeconds) || pollIntervalSeconds < 1) {
        process.stderr.write('error: --poll-interval must be a positive number of seconds\n')
        process.exit(1)
      }

      const { runTelegramMonitor } = await import('../monitor/telegram/monitor.js')
      try {
        await runTelegramMonitor({
          relayUrl: process.env.VIBE_RELAY_URL as string,
          relayToken: process.env.VIBE_RELAY_TOKEN as string,
          telegramToken: process.env.TELEGRAM_BOT_TOKEN as string,
          telegramChatId: process.env.TELEGRAM_CHAT_ID as string,
          symphonyWorkdir: process.env.SYMPHONY_WORKDIR || undefined,
          linearApiKey: process.env.LINEAR_API_KEY || undefined,
          pollIntervalMs: pollIntervalSeconds * 1000,
        })
      } catch (err) {
        process.stderr.write(`error: ${(err as Error).message}\n`)
        process.exit(1)
      }
    })
}
