/**
 * Codex adapter — treats each stdout line as a log line (codex exec is not
 * stream-json) and scans it for a PR URL. Lifecycle status is owned by the
 * supervisor.
 */
import { detectPrUrl } from '../../pr-detect.js'
import { execAgent, type EmitHelpers } from './exec.js'
import type { RunRecord } from '../../types.js'
import type { AgentAdapter, AgentAdapterContext, AgentOutcome } from '../types.js'

function handleLine(line: string, emit: EmitHelpers): void {
  emit.log('stdout', line)
  const prUrl = detectPrUrl(line)
  if (prUrl) emit.pr(prUrl)
}

export const codexAdapter: AgentAdapter = {
  run(record: RunRecord, ctx: AgentAdapterContext): Promise<AgentOutcome> {
    // The supervisor's codex-sandbox gate resolves this from the permission mode,
    // the task's write policy, and the Node-validated workspace lease. Absent →
    // read-only (the safe default). `unsafe-skip` bypasses it below.
    const sandbox = ctx.codexSandbox
    return execAgent(record, ctx, {
      binary: 'codex',
      label: 'codex',
      buildArgs: (rec, ctx) => {
        // --skip-git-repo-check: workspace may not be a git repo (no repo_url).
        const args = ['exec', '--skip-git-repo-check']
        if (rec.permission_mode === 'unsafe-skip') {
          // Explicit, pre-existing bypass — unchanged public semantics.
          args.push('--dangerously-bypass-approvals-and-sandbox')
        } else if (sandbox === 'workspace-write') {
          // Writes permitted inside the leased workspace ONLY. Codex scopes the
          // writable root to `--cd` (added below); network stays OFF and approvals
          // disabled under workspace-write for unattended execution.
          args.push('--sandbox', 'workspace-write')
        }
        // else: read-only — Codex's default sandbox (no flag), unchanged.
        // Codex `exec` stdout MIXES reasoning/progress with the final answer, so it
        // is NOT an authoritative result channel. `--output-last-message` writes ONLY
        // the agent's final message to a dedicated file — the authoritative final
        // output, isolated from mixed stdout. (Verified against codex-cli 0.139.0.)
        if (ctx.finalOutputFile) args.push('--output-last-message', ctx.finalOutputFile)
        args.push('--cd', rec.workspace_path)
        args.push('-') // read prompt from stdin
        return args
      },
      onStdoutLine: handleLine,
      // Authoritative final output = codex's dedicated final-message file (never the
      // mixed stdout stream, never a heuristic scrape). Empty → result_status missing.
      finalOutputStrategy: 'last-message-file',
    })
  },
}
