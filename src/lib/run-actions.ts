/**
 * Shared run lifecycle actions used by both `vibe run` and `vibe symphony`.
 */
import fs from 'fs'
import { spawnSync } from 'child_process'
import { resolveConfig } from '../config.js'
import { generateRunId, readRun, updateRun, writeRun } from '../store.js'
import { appendEvent } from '../events.js'
import { resolveWorkspacePath, ensureWorkspace, cloneIfEmpty, WorkspaceRepoMismatchError, RepoUrlCredentialsError } from '../workspace.js'
import { RepoNotAllowedError } from '../repo-policy.js'
import { mockBackend } from '../backends/mock.js'
import { claudeCodeBackend } from '../backends/claude-code.js'
import { codexBackend } from '../backends/codex.js'
import { resolveNode } from '../nodes.js'
import type { AgentBackend, PermissionMode, RunRecord, RunStatus } from '../types.js'
import type { Backend } from '../backends/types.js'

const TERMINAL_STATES: readonly RunStatus[] = ['completed', 'failed', 'stopped', 'cancelled']

/** A run's session_id is a tmux session name (not a PID) when tmux-backed. */
function isTmuxSessionName(session_id: string): boolean {
  return Boolean(session_id) && !/^\d+$/.test(session_id)
}

/** True if `session_id` names a tmux session that currently exists. */
function isLiveTmuxSession(session_id: string): boolean {
  if (!isTmuxSessionName(session_id)) return false
  const r = spawnSync('tmux', ['has-session', '-t', session_id], { stdio: 'ignore' })
  return r.status === 0
}

export interface StartRunOpts {
  agent: AgentBackend
  node?: string            // 'auto' | 'local' | explicit node_id; default: 'auto'
  workspaceKey?: string
  repoUrl?: string
  branch?: string
  promptFile?: string
  metadataFile?: string
  /** Additional metadata merged into the RunRecord (e.g. Symphony issue fields). */
  extraMetadata?: Record<string, unknown>
  permissionMode?: PermissionMode
}

function getBackend(agent: AgentBackend): Backend {
  switch (agent) {
    case 'mock': return mockBackend
    case 'claude-code': return claudeCodeBackend
    case 'codex': return codexBackend
    default:
      process.stderr.write(`error: unknown agent backend "${agent}"\n`)
      process.exit(1)
  }
}

export async function startRun(opts: StartRunOpts): Promise<RunRecord> {
  const config = resolveConfig()

  // Node resolution and agent capability check
  const nodeSelector = opts.node ?? 'auto'
  const nodeResult = resolveNode(nodeSelector)
  if ('error' in nodeResult) {
    process.stdout.write(JSON.stringify(nodeResult) + '\n')
    process.exit(1)
  }
  if (!nodeResult.agents.includes(opts.agent)) {
    process.stdout.write(JSON.stringify({
      error: true,
      code: 'agent_not_supported',
      message: `Node ${nodeResult.node_id} does not support agent ${opts.agent}`,
      ts: new Date().toISOString(),
    }) + '\n')
    process.exit(1)
  }

  const run_id = generateRunId()
  const workspaceKey: string = opts.workspaceKey ?? run_id
  const workspacePath = resolveWorkspacePath(workspaceKey, config.workspace_root)

  ensureWorkspace(workspacePath)

  let metadata: Record<string, unknown> | undefined
  if (opts.metadataFile) {
    metadata = JSON.parse(fs.readFileSync(opts.metadataFile, 'utf8')) as Record<string, unknown>
  }
  if (opts.extraMetadata) {
    metadata = { ...metadata, ...opts.extraMetadata }
  }

  const record: RunRecord = {
    run_id,
    session_id: '',
    node_id: nodeResult.node_id,
    node_selector: nodeSelector,
    agent: opts.agent,
    status: 'queued',
    workspace_path: workspacePath,
    repo_url: opts.repoUrl,
    branch: opts.branch,
    prompt_file: opts.promptFile,
    permission_mode: opts.permissionMode,
    metadata,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  writeRun(record)

  if (opts.repoUrl) {
    try {
      cloneIfEmpty(workspacePath, opts.repoUrl, opts.branch)
    } catch (err) {
      // Structured workspace/repo-binding errors (mismatch, token-in-URL,
      // not-allowlisted) carry a code and a token-free message; surface those.
      const known =
        err instanceof WorkspaceRepoMismatchError ||
        err instanceof RepoUrlCredentialsError ||
        err instanceof RepoNotAllowedError
      const message = known ? (err as Error).message : `clone failed: ${(err as Error).message}`
      const code = known ? (err as { code: string }).code : undefined
      const ts = new Date().toISOString()
      appendEvent({ type: 'error', run_id, message, ...(code && { code }), ts })
      appendEvent({ type: 'status', run_id, status: 'failed', ts })
      return updateRun(run_id, { status: 'failed' })
    }
  }

  const backend = getBackend(record.agent)
  const result = await backend.start(record, {
    promptFile: opts.promptFile,
    repoUrl: opts.repoUrl,
    branch: opts.branch,
    metadata,
  })

  return updateRun(run_id, { session_id: result.session_id, status: 'running' })
}

export function stopRun(run_id: string): RunRecord {
  const record = readRun(run_id)

  if (TERMINAL_STATES.includes(record.status)) {
    process.stderr.write(`error: run ${run_id} is already in terminal state: ${record.status}\n`)
    process.exit(1)
  }

  // session_id is either a numeric PID (detached process) or a tmux session
  // name (tmux-backed run). Tear down whichever applies.
  if (record.session_id) {
    if (isTmuxSessionName(record.session_id)) {
      spawnSync('tmux', ['kill-session', '-t', record.session_id], { stdio: 'ignore' })
    } else {
      const pid = parseInt(record.session_id, 10)
      if (!isNaN(pid) && pid > 0) {
        try { process.kill(pid, 'SIGTERM') } catch {}
      }
    }
  }
  if (record.child_pid) {
    try { process.kill(-record.child_pid, 'SIGTERM') } catch {}
    try { process.kill(record.child_pid, 'SIGTERM') } catch {}
  }

  appendEvent({ type: 'status', run_id, session_id: record.session_id, status: 'stopped', ts: new Date().toISOString() })
  return updateRun(run_id, { status: 'stopped' })
}

/** Structured outcome for `vibe run attach`. */
export type AttachResult =
  | { ok: true; run_id: string; session_id: string; mode: 'tmux'; tmux_session: string }
  | { ok: false; run_id: string; status: RunStatus; code: 'session_not_found' | 'session_not_attachable'; message: string }

/**
 * Decide how to attach to a run's live session, without performing any
 * interactive I/O (the caller does the actual `tmux attach`). Reads the run
 * record (which exits 3 if the run does not exist).
 *
 *  - terminal run            → session_not_found (nothing live to attach to)
 *  - active + live tmux       → ok: attach to the tmux session
 *  - active + detached process → session_not_attachable (use `run stream`)
 */
export function resolveAttach(run_id: string): AttachResult {
  const record = readRun(run_id)

  if (TERMINAL_STATES.includes(record.status)) {
    return {
      ok: false,
      run_id,
      status: record.status,
      code: 'session_not_found',
      message: `run ${run_id} has no active session (status: ${record.status}); use \`vibe run status ${run_id}\` or \`vibe run stream ${run_id}\``,
    }
  }

  if (isLiveTmuxSession(record.session_id)) {
    return { ok: true, run_id, session_id: record.session_id, mode: 'tmux', tmux_session: record.session_id }
  }

  return {
    ok: false,
    run_id,
    status: record.status,
    code: 'session_not_attachable',
    message: `run ${run_id} is active as a detached process (no tmux session); use \`vibe run stream ${run_id}\` to follow output, or start the run with VIBE_USE_TMUX=1 for an attachable tmux session`,
  }
}
