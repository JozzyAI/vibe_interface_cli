import type { Backend, StartOptions, StartResult } from './types.js'
import type { RunRecord } from '../types.js'
import { launchSupervisor } from '../lib/runner-launch.js'

export const claudeCodeBackend: Backend = {
  async start(run: RunRecord, _opts: StartOptions): Promise<StartResult> {
    return launchSupervisor(run.run_id)
  },
}
