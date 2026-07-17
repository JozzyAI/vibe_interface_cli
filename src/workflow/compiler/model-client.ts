/**
 * CompilerModelClient — runs the compiler prompt through the EXISTING durable Agent
 * Task path and returns the AUTHORITATIVE AgentTaskResult final output. The compiler
 * never calls the relay / Node / provider adapters / WorkflowRuntime directly; it
 * only creates + observes a durable task via the injected {@link AgentTaskClient}.
 * Misleading JSON in intermediate task events is ignored — only the AgentTaskResult
 * final output is consulted.
 */
import { TransientAgentTaskError, type AgentTaskClient } from '../task-client.js'

export interface CompilerModelRequest { prompt: string; agent: string; node_id?: string; idempotency_key: string; permission_mode?: 'default' | 'unsafe-skip' }
export type CompilerModelOutcome =
  | { task_id: string; status: 'available'; output_text: string }
  | { task_id: string; status: 'missing' | 'invalid' | 'failed' }

export interface CompilerModelClient {
  compile(req: CompilerModelRequest): Promise<CompilerModelOutcome>
}

/** Production adapter over the durable Agent Task client. Idempotent by the caller's
 *  idempotency_key (a crash/retry reuses the SAME task — never a second run). */
export class AgentTaskCompilerModelClient implements CompilerModelClient {
  constructor(private readonly task: AgentTaskClient, private readonly waitWindowMs = 30_000, private readonly maxWaits = 40) {}
  async compile(req: CompilerModelRequest): Promise<CompilerModelOutcome> {
    // The compiler task runs with a MINIMUM-CAPABILITY profile: permission_mode
    // 'default' (approval-gated; never unsafe-skip) and NO workspace_key (no workspace
    // binding / write). Enforcement is by the Node/provider, not prompt text.
    const ref = await this.task.createTask({ agent: req.agent, ...(req.node_id ? { node_id: req.node_id } : {}), input: { text: req.prompt }, permission_mode: req.permission_mode ?? 'default', idempotency_key: req.idempotency_key })
    let cursor = -1
    for (let i = 0; i < this.maxWaits; i++) {
      let read
      try { read = await this.task.waitForTerminal(ref.task_id, { afterId: cursor, budgetMs: this.waitWindowMs }) }
      catch (err) { if (err instanceof TransientAgentTaskError) continue; throw err }
      cursor = read.next_event_id
      if (read.terminal) {
        if (read.status === 'completed' && read.result_status === 'available' && read.result_text !== undefined) return { task_id: ref.task_id, status: 'available', output_text: read.result_text }
        return { task_id: ref.task_id, status: read.status === 'completed' ? (read.result_status === 'invalid' ? 'invalid' : 'missing') : 'failed' }
      }
    }
    return { task_id: ref.task_id, status: 'missing' }
  }
}
