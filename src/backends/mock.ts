import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import type { Backend, StartOptions, StartResult } from './types.js'
import type { RunRecord } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.resolve(__dirname, '..', 'index.js')

export const mockBackend: Backend = {
  async start(run: RunRecord, _opts: StartOptions): Promise<StartResult> {
    const session_id = `mock_${run.run_id}`

    const child = spawn(process.execPath, [ENTRY, '_mock-runner', run.run_id], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    return { session_id }
  },
}
