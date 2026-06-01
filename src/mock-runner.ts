import { appendEvent } from './events.js'
import { updateRun } from './store.js'

const FAKE_OUTPUT = [
  'Cloning repository...',
  'Installing dependencies...',
  'Analyzing codebase...',
  'Running linter...',
  'Executing task...',
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runMockRunner(run_id: string): Promise<void> {
  const ts = () => new Date().toISOString()

  appendEvent({ type: 'session_started', run_id, ts: ts() })

  for (const line of FAKE_OUTPUT) {
    await sleep(400)
    appendEvent({ type: 'output', run_id, ts: ts(), data: { text: line } })
  }

  appendEvent({ type: 'status_change', run_id, ts: ts(), data: { status: 'running' } })

  await sleep(1500)

  appendEvent({
    type: 'approval_required',
    run_id,
    ts: ts(),
    data: { message: 'Proceed with modifying tracked files?' },
  })

  await sleep(2000)

  appendEvent({ type: 'completed', run_id, ts: ts(), data: { exit_code: 0 } })
  updateRun(run_id, { status: 'completed' })
}
