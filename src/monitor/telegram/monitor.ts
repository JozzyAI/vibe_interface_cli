/**
 * Orchestration for `vibe monitor telegram`.
 *
 * Strictly read-only: each tick collects snapshots (relay/nodes, local runs,
 * optionally Symphony/Linear), diffs them against the last persisted state,
 * pushes alert messages for anything that changed, and answers the six
 * status-query commands. There is no code path here — or anywhere in this
 * module tree — that can approve, deny, merge, start/stop a run, mutate
 * Linear, edit workflow files, or execute shell commands from Telegram input.
 */
import { collectLinearStatus, collectLocalRuns, collectSymphonyStatus, nodeToSnapshot, pollRelay } from './collectors.js'
import { diffNodes, diffRelay, diffRuns } from './diff.js'
import {
  formatHelp,
  formatLinearStatus,
  formatNodeChange,
  formatNodesList,
  formatRelayChange,
  formatRunChange,
  formatRunsList,
  formatStatusSummary,
  formatSymphonyStatus,
} from './format.js'
import { redactSecrets, relayHostname } from './secrets.js'
import { loadState, saveState } from './state.js'
import { TelegramClient, type TelegramMessage } from './telegram-client.js'
import type {
  LinearSnapshot,
  MonitorState,
  NodeSnapshot,
  RelaySnapshot,
  RunSnapshot,
  SymphonySnapshot,
} from './types.js'

export interface MonitorOptions {
  relayUrl: string
  relayToken: string
  telegramToken: string
  telegramChatId: string
  symphonyWorkdir?: string
  linearApiKey?: string
  /** how often to collect + diff, in milliseconds (default 60s, floor 15s) */
  pollIntervalMs?: number
  /** injection point for tests — defaults to the real ISO-now */
  now?: () => string
}

// ── Command dispatch (pure — testable without a live bot) ───────────────────

export interface CommandContext {
  state: MonitorState
  relay: RelaySnapshot
  nodes: NodeSnapshot[]
  runs: RunSnapshot[]
  symphony: SymphonySnapshot | null
  linear: LinearSnapshot | null
}

type CommandHandler = (ctx: CommandContext) => string

/**
 * The complete set of commands this bot understands. Intentionally a fixed,
 * exhaustive map of read-only status queries — adding anything here that
 * could mutate state (approve/deny/merge/start/stop/...) would violate the
 * monitor's read-only contract, so this map is the single place that defines
 * "everything Telegram input can ever trigger."
 */
const COMMANDS: Record<string, CommandHandler> = {
  '/status': (ctx) => formatStatusSummary(ctx.state, ctx.relay),
  '/nodes': (ctx) => formatNodesList(ctx.nodes),
  '/runs': (ctx) => formatRunsList(ctx.runs),
  '/symphony': (ctx) => formatSymphonyStatus(ctx.symphony),
  '/linear': (ctx) => formatLinearStatus(ctx.linear),
  '/help': () => formatHelp(),
}

/** Returns null for anything that isn't one of the six known status commands — including any look-alike control verb. */
export function dispatchCommand(text: string, ctx: CommandContext): string | null {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase().split('@', 1)[0]
  if (!command) return null
  const handler = COMMANDS[command]
  return handler ? handler(ctx) : null
}

// ── Tick: collect, diff, alert, persist ──────────────────────────────────────

interface TickResult {
  state: MonitorState
  context: CommandContext
}

async function tick(opts: MonitorOptions, client: TelegramClient, previous: MonitorState, sendAlert: (text: string) => Promise<void>): Promise<TickResult> {
  const now = (opts.now ?? (() => new Date().toISOString()))()

  const { relay, nodes: rawNodes } = await pollRelay(opts.relayUrl, opts.relayToken, () => now)

  const relayChange = diffRelay(previous.relay, relay)
  if (relayChange) await sendAlert(formatRelayChange(relayChange))

  // Keep the prior node snapshots when the relay can't be reached this tick —
  // a momentary outage shouldn't be reported as every node going dark.
  const nodeSnapshots: NodeSnapshot[] = rawNodes
    ? rawNodes.map((node) => nodeToSnapshot(node, previous.nodes[node.node_id], now))
    : Object.values(previous.nodes)

  if (rawNodes) {
    for (const change of diffNodes(previous.nodes, nodeSnapshots)) {
      await sendAlert(formatNodeChange(change))
    }
  }

  const runSnapshots = collectLocalRuns()
  for (const change of diffRuns(previous.runs, runSnapshots)) {
    await sendAlert(formatRunChange(change))
  }

  const symphony = opts.symphonyWorkdir ? collectSymphonyStatus(opts.symphonyWorkdir) : null
  const linear = opts.linearApiKey ? await collectLinearStatus(opts.linearApiKey) : null

  const state: MonitorState = {
    version: 1,
    relay,
    nodes: Object.fromEntries(nodeSnapshots.map((n) => [n.node_id, n])),
    runs: Object.fromEntries(runSnapshots.map((r) => [r.run_id, r])),
    updated_at: now,
  }
  saveState(state)

  return { state, context: { state, relay, nodes: nodeSnapshots, runs: runSnapshots, symphony, linear } }
}

// ── Main loop ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runTelegramMonitor(opts: MonitorOptions): Promise<void> {
  const pollIntervalSeconds = Math.max(15, Math.round((opts.pollIntervalMs ?? 60_000) / 1000))
  const client = new TelegramClient(opts.telegramToken)
  const secrets = [opts.relayToken, opts.telegramToken, opts.linearApiKey]

  const sendAlert = async (text: string): Promise<void> => {
    try {
      await client.sendMessage(opts.telegramChatId, text)
    } catch (err) {
      process.stderr.write(`[telegram-monitor] failed to send alert: ${redactSecrets((err as Error).message, secrets)}\n`)
    }
  }

  let state = loadState()
  let context: CommandContext | null = null
  let offset = 0
  let stopped = false

  const stop = (): void => {
    stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  process.stderr.write(
    `[telegram-monitor] starting — relay=${process.env.VIBE_RELAY_NAME || relayHostname(opts.relayUrl)} interval=${pollIntervalSeconds}s` +
      `${opts.symphonyWorkdir ? ' symphony=on' : ''}${opts.linearApiKey ? ' linear=on' : ''}\n`,
  )

  while (!stopped) {
    try {
      const result = await tick(opts, client, state, sendAlert)
      state = result.state
      context = result.context
    } catch (err) {
      process.stderr.write(`[telegram-monitor] tick failed: ${redactSecrets((err as Error).message, secrets)}\n`)
    }

    if (stopped) break

    let updates: TelegramMessage[] = []
    try {
      updates = await client.getUpdates(offset, opts.telegramChatId, pollIntervalSeconds)
    } catch (err) {
      process.stderr.write(`[telegram-monitor] getUpdates failed: ${redactSecrets((err as Error).message, secrets)}\n`)
      await delay(pollIntervalSeconds * 1000)
    }

    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1)
      if (!context) continue
      const reply = dispatchCommand(update.text, context)
      if (reply) await sendAlert(reply)
    }
  }

  process.stderr.write('[telegram-monitor] stopped\n')
}
