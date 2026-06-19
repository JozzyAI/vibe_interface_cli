/**
 * Handoff generation.
 *
 * When the supervisor switches from a failed primary agent to a fallback, it
 * writes a Markdown handoff so the fallback (and any human reviewing the run)
 * inherits the context the primary built up: what issue/repo/branch we're on,
 * what work already landed in the workspace, why the primary stopped, and what
 * to do next.
 *
 * Hard rule: NO SECRETS. We only read git metadata (branch, porcelain status,
 * short log) and record metadata that is already non-sensitive, and we run
 * redact() over the composed document defensively. Tokens are never embedded in
 * remotes or printed here.
 */
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { vibeDir } from '../config.js'
import { redact } from '../redact.js'
import type { RunRecord } from '../types.js'
import type { AgentBackend } from '../types.js'
import type { FailureReason } from './types.js'

function handoffDir(): string {
  const dir = path.join(vibeDir(), 'handoff')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function handoffPath(run_id: string): string {
  return path.join(handoffDir(), `${run_id}.md`)
}

/** Run a read-only git command in the workspace; return '' if it fails (no throw). */
function git(workspace: string, args: string): string {
  try {
    return execSync(`git -C ${JSON.stringify(workspace)} ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim()
  } catch {
    return ''
  }
}

function metaString(record: RunRecord, key: string): string | undefined {
  const v = record.metadata?.[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

const NEXT_ACTION: Record<string, string> = {
  session_limit: 'The primary agent hit its session limit. Resume the work in this same workspace and branch — do not restart from scratch.',
  usage_limit: 'The primary agent hit a usage limit. Continue the in-progress work in this same workspace and branch.',
  quota_exceeded: 'The primary agent ran out of quota/credits. Continue the in-progress work in this same workspace and branch.',
  rate_limited: 'The primary agent was rate limited. Continue the in-progress work in this same workspace and branch.',
  context_limit: 'The primary agent exceeded its context window. Continue the work; summarize prior progress from the git state below rather than re-reading everything.',
  auth_expired: 'The primary agent lost authentication. Continue the work in this same workspace and branch.',
}

/**
 * Compose and write the handoff document. Returns the file path. `reason` is the
 * classified failure reason; `failureMessage` is the diagnostic the primary
 * emitted (already redacted upstream, redacted again here for safety).
 */
export function writeHandoff(
  record: RunRecord,
  prevAgent: AgentBackend,
  nextAgent: AgentBackend,
  reason: FailureReason,
  failureMessage?: string,
): string {
  const ws = record.workspace_path
  const issueId = metaString(record, 'issue_id')
  const issueTitle = metaString(record, 'issue_title')

  const branch = git(ws, 'rev-parse --abbrev-ref HEAD') || record.branch || '(unknown)'
  const status = git(ws, 'status --porcelain') || '(clean or not a git checkout)'
  const log = git(ws, 'log -5 --oneline') || '(no commits)'

  const nextAction = NEXT_ACTION[reason] ?? `The primary agent (${prevAgent}) failed (${reason}). Continue the work in this same workspace and branch.`

  const doc = [
    `# Handoff — ${record.run_id}`,
    '',
    `**From agent:** ${prevAgent}`,
    `**To agent:** ${nextAgent}`,
    `**Failure reason:** ${reason}`,
    failureMessage ? `**Primary diagnostic:** ${failureMessage}` : '',
    '',
    '## Task',
    '',
    issueId ? `- **Issue:** ${issueId}${issueTitle ? ` — ${issueTitle}` : ''}` : '- **Issue:** (none)',
    `- **Repo:** ${record.repo_url ?? '(local workspace, no remote)'}`,
    `- **Branch:** ${branch}`,
    `- **Workspace:** ${ws}`,
    '',
    '## Work already in the workspace',
    '',
    '### git status --porcelain',
    '```',
    status,
    '```',
    '',
    '### git log -5 --oneline',
    '```',
    log,
    '```',
    '',
    '## Next action',
    '',
    nextAction,
    '',
    '## Constraints',
    '',
    '- Continue in THIS workspace and branch. Do not delete, reset, or re-clone it.',
    '- Do not overwrite or force-push existing commits.',
    '- Do not embed tokens into git remotes or print secrets.',
    '- Pick up the original task below; the prior agent already made the changes shown above.',
    '',
  ].filter((line) => line !== '').join('\n')

  const safe = redact(doc) + '\n'
  const p = handoffPath(record.run_id)
  fs.writeFileSync(p, safe)
  return p
}
