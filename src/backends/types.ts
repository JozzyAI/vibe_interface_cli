import type { RunRecord } from '../types.js'

export interface StartOptions {
  promptFile?: string
  repoUrl?: string
  branch?: string
  metadata?: Record<string, unknown>
}

export interface StartResult {
  session_id: string
}

export interface Backend {
  start(run: RunRecord, opts: StartOptions): Promise<StartResult>
}
