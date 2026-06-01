export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'blocked'

export type AgentBackend = 'mock' | 'claude-code' | 'codex' | 'opencode'

export interface RunRecord {
  run_id: string
  session_id: string
  node_id: string
  agent: AgentBackend
  status: RunStatus
  workspace_path: string
  session_url?: string
  repo_url?: string
  branch?: string
  prompt_file?: string
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type RunEventType =
  | 'session_started'
  | 'output'
  | 'status_change'
  | 'approval_required'
  | 'completed'
  | 'failed'
  | 'stopped'

export interface RunEvent {
  type: RunEventType
  run_id: string
  ts: string
  data?: {
    text?: string
    status?: RunStatus
    message?: string
    exit_code?: number
  }
}

export const TERMINAL_EVENTS: RunEventType[] = ['completed', 'failed', 'stopped']
