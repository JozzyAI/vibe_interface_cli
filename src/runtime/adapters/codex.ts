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
    return execAgent(record, ctx, {
      binary: 'codex',
      label: 'codex',
      buildArgs: (rec) => {
        // --skip-git-repo-check: workspace may not be a git repo (no repo_url).
        const args = ['exec', '--skip-git-repo-check']
        if (rec.permission_mode === 'unsafe-skip') args.push('--dangerously-bypass-approvals-and-sandbox')
        args.push('--cd', rec.workspace_path)
        args.push('-') // read prompt from stdin
        return args
      },
      onStdoutLine: handleLine,
    })
  },
}
