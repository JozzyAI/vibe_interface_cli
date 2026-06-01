import type { Backend, StartOptions, StartResult } from './types.js'
import type { RunRecord } from '../types.js'

export const claudeCodeBackend: Backend = {
  async start(_run: RunRecord, _opts: StartOptions): Promise<StartResult> {
    process.stderr.write('error: claude-code backend not yet implemented — use --agent mock\n')
    process.exit(1)
  },
}
