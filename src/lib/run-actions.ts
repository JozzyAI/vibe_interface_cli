/**
 * Shared run lifecycle actions used by both `vibe run` and `vibe symphony`.
 */
import fs from 'fs'
import { execSync } from 'child_process'
import { resolveConfig } from '../config.js'
import { generateRunId, readRun, updateRun, writeRun } from '../store.js'
import { appendEvent } from '../events.js'
import { resolveWorkspacePath, ensureWorkspace, cloneIfEmpty } from '../workspace.js'
import { mockBackend } from '../backends/mock.js'
import { claudeCodeBackend } from '../backends/claude-code.js'
import { codexBackend } from '../backends/codex.js'
import { resolveNode } from '../nodes.js'
import type { AgentBackend, PermissionMode, RunRecord } from '../types.js'
import type { Backend } from '../backends/types.js'

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

  if (opts.repoUrl) {
    cloneIfEmpty(workspacePath, opts.repoUrl, opts.branch)
  }

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

  if (['completed', 'failed', 'stopped', 'cancelled'].includes(record.status)) {
    process.stderr.write(`error: run ${run_id} is already in terminal state: ${record.status}\n`)
    process.exit(1)
  }

  if (record.session_id) {
    const pid = parseInt(record.session_id, 10)
    if (!isNaN(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    } else {
      try { execSync(`tmux kill-session -t ${record.session_id}`, { stdio: 'ignore' }) } catch {}
    }
  }
  if (record.child_pid) {
    try { process.kill(-record.child_pid, 'SIGTERM') } catch {}
    try { process.kill(record.child_pid, 'SIGTERM') } catch {}
  }

  appendEvent({ type: 'status', run_id, session_id: record.session_id, status: 'stopped', ts: new Date().toISOString() })
  return updateRun(run_id, { status: 'stopped' })
}
