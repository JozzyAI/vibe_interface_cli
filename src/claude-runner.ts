import { spawn } from 'child_process'
import fs from 'fs'
import { appendEvent } from './events.js'
import { readRun, updateRun } from './store.js'
import { redact } from './redact.js'
import { cloneIfEmpty } from './workspace.js'
import { detectPrUrl } from './pr-detect.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

interface ClaudeStreamEvent {
  type: string
  session_id?: string
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>
  }
}

function handleStreamEvent(
  msg: ClaudeStreamEvent,
  run_id: string,
  session_id: string,
  ts: () => string,
): void {
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        appendEvent({ type: 'log', run_id, session_id, stream: 'stdout', message: redact(block.text), ts: ts() })
        const prUrl = detectPrUrl(block.text)
        if (prUrl) {
          appendEvent({ type: 'pr_created', run_id, session_id, url: prUrl, ts: ts() })
        }
      } else if (block.type === 'tool_use' && block.name) {
        appendEvent({ type: 'tool_call', run_id, session_id, tool: block.name, input: block.input, ts: ts() })
      }
    }
  }
}

export async function runClaudeRunner(run_id: string): Promise<void> {
  const record = readRun(run_id)
  let session_id = record.session_id
  const ts = () => new Date().toISOString()
  const timeoutMs = parseInt(process.env.VIBE_RUN_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10)

  appendEvent({ type: 'status', run_id, session_id, status: 'running', ts: ts() })

  let prompt = ''
  if (record.prompt_file) {
    if (!fs.existsSync(record.prompt_file)) {
      appendEvent({ type: 'error', run_id, session_id, message: `prompt file not found: ${record.prompt_file}`, ts: ts() })
      appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
      updateRun(run_id, { status: 'failed' })
      return
    }
    prompt = fs.readFileSync(record.prompt_file, 'utf8').trim()
  }

  if (record.repo_url) {
    try {
      cloneIfEmpty(record.workspace_path, record.repo_url, record.branch)
    } catch (err) {
      appendEvent({ type: 'error', run_id, session_id, message: `clone failed: ${(err as Error).message}`, ts: ts() })
      appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
      updateRun(run_id, { status: 'failed' })
      return
    }
  }

  const claudeArgs = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']
  if (record.permission_mode === 'unsafe-skip') {
    claudeArgs.push('--dangerously-skip-permissions')
  }

  const child = spawn('claude', claudeArgs, {
    cwd: record.workspace_path,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })

  let childStarted = false
  let timedOut = false

  const fail = (msg: string) => {
    appendEvent({ type: 'error', run_id, session_id, message: msg, ts: ts() })
    appendEvent({ type: 'status', run_id, session_id, status: 'failed', ts: ts() })
    updateRun(run_id, { status: 'failed', child_pid: undefined })
  }

  child.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    fail(code === 'ENOENT' ? 'claude CLI not found in PATH' : `spawn error: ${err.message}`)
  })

  if (child.pid) {
    childStarted = true
    updateRun(run_id, { child_pid: child.pid })
  }

  const timer = setTimeout(() => {
    timedOut = true
    if (child.pid) try { process.kill(-child.pid, 'SIGTERM') } catch {}
  }, timeoutMs)

  child.stdin?.write(prompt + '\n')
  child.stdin?.end()

  let stdoutBuf = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as ClaudeStreamEvent
        if (msg.type === 'system' && msg.session_id) session_id = msg.session_id
        handleStreamEvent(msg, run_id, session_id, ts)
      } catch {
        appendEvent({ type: 'log', run_id, session_id, stream: 'stdout', message: redact(line), ts: ts() })
        const prUrl = detectPrUrl(line)
        if (prUrl) {
          appendEvent({ type: 'pr_created', run_id, session_id, url: prUrl, ts: ts() })
        }
      }
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      appendEvent({ type: 'log', run_id, session_id, stream: 'stderr', message: redact(line), ts: ts() })
    }
  })

  await new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (!childStarted) return resolve()
      if (timedOut) {
        fail(`run timed out after ${timeoutMs}ms`)
      } else if (code === 0) {
        appendEvent({ type: 'status', run_id, session_id, status: 'completed', ts: ts() })
        updateRun(run_id, { status: 'completed', child_pid: undefined })
      } else {
        fail(signal ? `claude exited with signal ${signal}` : `claude exited with code ${code}`)
      }
      resolve()
    })
  })
}
