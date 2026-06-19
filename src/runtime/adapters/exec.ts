/**
 * Shared agent-execution core for the spawned-CLI adapters (claude, codex).
 *
 * This is the body of the old per-agent runners, minus the lifecycle status
 * emission: it resolves the prompt, clones if needed, spawns the agent CLI,
 * streams stdout/stderr to the event log, tracks the child pid for stop, keeps
 * a bounded output tail for failure classification, and returns a normalized
 * AgentOutcome. It never emits `status:running` or the final terminal status —
 * the supervisor owns those so a fallback can supersede a failure.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import { appendEvent } from '../../events.js'
import { readRun, updateRun } from '../../store.js'
import { redact } from '../../redact.js'
import { cloneIfEmpty, WorkspaceRepoMismatchError } from '../../workspace.js'
import { detectPrUrl, createPrUrlTracker } from '../../pr-detect.js'
import type { RunRecord } from '../../types.js'
import type { AgentOutcome, AgentAdapterContext } from '../types.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
const TAIL_LIMIT = 64 * 1024 // bytes of stdout+stderr retained for classification

/** Per-line stdout handler — the only real difference between claude (stream-json) and codex (raw). */
export type StdoutLineHandler = (line: string, emit: EmitHelpers) => void

export interface EmitHelpers {
  run_id: string
  /** Update the session id (claude discovers it from the system/init line). */
  setSession(id: string): void
  log(stream: 'stdout' | 'stderr', message: string): void
  toolCall(tool: string, input: unknown): void
  /** Emit a pr_created event once per unique URL. */
  pr(url: string): void
}

export interface ExecAgentOptions {
  binary: string
  /** Build CLI args given the resolved record (prompt is always piped via stdin). */
  buildArgs(record: RunRecord): string[]
  onStdoutLine: StdoutLineHandler
  /** Friendly binary label for error messages (defaults to `binary`). */
  label?: string
}

export async function execAgent(record: RunRecord, ctx: AgentAdapterContext, options: ExecAgentOptions): Promise<AgentOutcome> {
  const run_id = record.run_id
  let session_id = record.session_id
  const ts = () => new Date().toISOString()
  const timeoutMs = parseInt(process.env.VIBE_RUN_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10)
  const label = options.label ?? options.binary
  const isNewPrUrl = createPrUrlTracker()

  // Bounded tail of everything the agent printed — fed to the classifier on failure.
  let tail = ''
  const appendTail = (s: string) => {
    tail += s
    if (tail.length > TAIL_LIMIT) tail = tail.slice(tail.length - TAIL_LIMIT)
  }

  const diagnosticError = (message: string, code?: string): AgentOutcome => {
    appendEvent({ type: 'error', run_id, session_id, message, ...(code && { code }), ts: ts() })
    return { result: 'failed', failureMessage: message, tailOutput: tail }
  }

  // ── Prompt resolution (handoff override wins over the record's prompt file) ──
  const promptPath = ctx.promptOverridePath ?? record.prompt_file
  let prompt = ''
  if (promptPath) {
    if (!fs.existsSync(promptPath)) {
      return diagnosticError(`prompt file not found: ${promptPath}`)
    }
    prompt = fs.readFileSync(promptPath, 'utf8').trim()
  }

  // ── Clone if needed (no-op on a populated workspace that already matches) ──
  if (record.repo_url) {
    try {
      cloneIfEmpty(record.workspace_path, record.repo_url, record.branch)
    } catch (err) {
      const isMismatch = err instanceof WorkspaceRepoMismatchError
      const message = isMismatch ? err.message : `clone failed: ${(err as Error).message}`
      return diagnosticError(message, isMismatch ? err.code : undefined)
    }
  }

  const emit: EmitHelpers = {
    run_id,
    setSession: (id) => { session_id = id },
    log: (stream, message) => appendEvent({ type: 'log', run_id, session_id, stream, message: redact(message), ts: ts() }),
    toolCall: (tool, input) => appendEvent({ type: 'tool_call', run_id, session_id, tool, input, ts: ts() }),
    pr: (url) => { if (isNewPrUrl(url)) appendEvent({ type: 'pr_created', run_id, session_id, url, ts: ts() }) },
  }

  const child = spawn(options.binary, options.buildArgs(record), {
    cwd: record.workspace_path,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })

  let childStarted = false
  let timedOut = false
  let spawnError: string | null = null

  child.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    spawnError = code === 'ENOENT' ? `${label} CLI not found in PATH` : `spawn error: ${err.message}`
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
    const text = chunk.toString('utf8')
    appendTail(text)
    stdoutBuf += text
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      options.onStdoutLine(line, emit)
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    appendTail(text)
    for (const line of text.split('\n').filter(Boolean)) {
      emit.log('stderr', line)
    }
  })

  return await new Promise<AgentOutcome>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      // Re-read the record in case `vibe run stop` flipped status to stopped while we ran.
      const current = readRun(run_id)
      updateRun(run_id, { child_pid: undefined })

      if (!childStarted) {
        return resolve(diagnosticError(spawnError ?? `${label} failed to start`))
      }
      if (current.status === 'stopped') {
        // Stop already wrote the terminal status; report failed-but-do-nothing-terminal upstream.
        return resolve({ result: 'failed', failureMessage: 'run stopped', tailOutput: tail })
      }
      if (timedOut) {
        return resolve(diagnosticError(`run timed out after ${timeoutMs}ms`))
      }
      if (code === 0) {
        return resolve({ result: 'completed', tailOutput: tail })
      }
      return resolve(diagnosticError(signal ? `${label} exited with signal ${signal}` : `${label} exited with code ${code}`))
    })
  })
}
