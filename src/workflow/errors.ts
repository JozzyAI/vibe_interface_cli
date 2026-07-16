/**
 * Stable, sanitized error + block reason codes for the Workflow Runtime.
 *
 * These codes are DURABLE and machine-readable — they appear in persisted step /
 * workflow error metadata and in `workflow.failed` / `workflow.blocked` payloads.
 * A message NEVER echoes a raw prompt, a full agent output, an input value, a
 * fingerprint, a DB path, SQL, or a stack trace: only bounded, safe diagnostics.
 */

export type WorkflowErrorCode =
  | 'invalid_spec'              // the WorkflowSpec failed validation
  | 'invalid_input_values'     // input values missing/unknown/type-mismatched
  | 'invalid_transition'       // an illegal workflow lifecycle transition
  | 'render_error'             // a prompt/workspace template could not be rendered
  | 'output_unparseable'       // agent output was not exactly one JSON object
  | 'output_schema_invalid'    // parsed output violated the declared schema
  | 'routing_no_edge'          // no outgoing edge matched (and no fallback)
  | 'routing_ambiguous'        // more than one outgoing edge matched
  | 'workflow_limit_exceeded'  // a durable limit (rounds/tasks/runtime/failures) was hit
  | 'task_failed'              // the Agent Task reported a terminal failure
  | 'task_cancelled_external'  // the Agent Task was cancelled without our intent
  | 'task_result_invalid'      // the AgentTaskResult envelope itself was malformed/corrupted
  | 'workspace_lease_conflict' // a required workspace is already leased by another workflow
  | 'workspace_node_ambiguous' // a workspace-bound step's node routing is not explicit
  | 'workspace_lease_unavailable' // the workspace-lease service was unreachable at start
  | 'workspace_lease_unsupported' // a workspace-bound workflow has no lease client (fail closed)
  | 'runtime_internal'         // an unexpected runtime error (sanitized)

/** Stable reasons for a non-terminal `blocked` workflow. */
export type WorkflowBlockReason =
  | 'task_result_missing'      // task terminal but no authoritative AgentTaskResult was available
  | 'task_history_incomplete'  // (legacy diagnostic) canonical history not complete
  | 'agent_blocked'            // an agent output declared status blocked
  | 'routed_blocked'           // routing selected the reserved $blocked target
  | 'workspace_revision_conflict' // an out-of-band workspace change diverged from the lease's expected revision

export class WorkflowRuntimeError extends Error {
  constructor(
    public readonly code: WorkflowErrorCode,
    message: string,
    /** Bounded, safe diagnostic metadata (never raw output/prompt/secrets). */
    public readonly meta?: Record<string, unknown>,
  ) { super(message); this.name = 'WorkflowRuntimeError' }
}

/** Which limit was exceeded (kept explicit for stable failure metadata). */
export type LimitKind = 'max_rounds' | 'max_tasks' | 'max_runtime_seconds' | 'max_failures' | 'max_step_attempts'
