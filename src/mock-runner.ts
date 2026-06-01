import { appendEvent } from './events.js'
import { readRun, updateRun } from './store.js'

const FAKE_LOGS = [
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
  const record = readRun(run_id)
  const session_id = record.session_id
  const ts = () => new Date().toISOString()

  appendEvent({ type: 'status', run_id, session_id, status: 'running', ts: ts() })

  for (const message of FAKE_LOGS) {
    await sleep(400)
    appendEvent({ type: 'log', run_id, session_id, stream: 'stdout', message, ts: ts() })
  }

  await sleep(1500)

  const approval_id = `appr_${Date.now().toString(36)}`
  appendEvent({
    type: 'approval_required',
    run_id,
    session_id,
    approval_id,
    message: 'Proceed with modifying tracked files?',
    ts: ts(),
  })

  await sleep(2000)

  appendEvent({ type: 'status', run_id, session_id, status: 'completed', ts: ts() })
  updateRun(run_id, { status: 'completed' })
}
