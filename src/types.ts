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

// ── Stable JSONL event schema ──────────────────────────────────────────────

interface BaseEvent {
  run_id: string
  session_id?: string
  ts: string
}

export interface StatusEvent extends BaseEvent {
  type: 'status'
  status: RunStatus
}

export interface LogEvent extends BaseEvent {
  type: 'log'
  stream: 'stdout' | 'stderr'
  message: string
}

export interface ApprovalRequiredEvent extends BaseEvent {
  type: 'approval_required'
  approval_id: string
  message: string
}

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call'
  tool: string
  input?: unknown
}

export interface PrCreatedEvent extends BaseEvent {
  type: 'pr_created'
  url: string
}

export interface ErrorEvent extends BaseEvent {
  type: 'error'
  message: string
}

export type RunEvent =
  | StatusEvent
  | LogEvent
  | ApprovalRequiredEvent
  | ToolCallEvent
  | PrCreatedEvent
  | ErrorEvent

export const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'stopped']

export function isTerminal(event: RunEvent): boolean {
  return event.type === 'status' && TERMINAL_STATUSES.includes((event as StatusEvent).status)
}
