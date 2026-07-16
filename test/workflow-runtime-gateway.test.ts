/**
 * Real-Gateway acceptance for the Workflow Runtime: a single-step validated
 * workflow driven end-to-end through a durable Agent Gateway (local mock backend)
 * over the production GatewayAgentTaskClient. The mock emits a deterministic
 * structured JSON result (VIBE_MOCK_OUTPUT) the runtime parses + validates. Uses
 * only a temporary Gateway + temporary ControlStore; never touches production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startAgentGateway, type GatewayServer } from '../src/lib/agent-gateway.js'
import { openControlStore, type SqliteControlStore } from '../src/control/sqlite-store.js'
import { GatewayClient } from '../src/mcp/gateway-client.js'
import { WorkflowRuntime } from '../src/workflow/runtime.js'
import { GatewayAgentTaskClient } from '../src/workflow/task-client.js'
import type { WorkflowSpec } from '../src/workflow/contract.js'

const TOKEN = `wf-gw-${Math.random().toString(36).slice(2)}`
const mkdir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))

/** A minimal, valid single-step workflow: run the mock, parse its JSON, complete. */
function singleStepSpec(): WorkflowSpec {
  return {
    version: '1', name: 'single-step', entry_step: 'solo',
    inputs: { objective: { type: 'string', required: true } },
    agents: { solo: { agent: 'mock' } }, // node_id omitted → local mock backend
    output_schemas: { solo_out: { fields: { status: { type: 'enum', required: true, enum: ['done'] }, summary: { type: 'string', required: true } } } },
    limits: { max_tasks: 3, max_runtime_seconds: 60, max_step_attempts: 1, max_failures: 1 },
    steps: [{ id: 'solo', type: 'agent_task', agent_role: 'solo', prompt_template: 'Do: {{ inputs.objective }}', output_schema: 'solo_out' }],
    edges: [{ from: 'solo', to: '$complete', kind: 'normal', condition: { path: 'output.status', op: 'eq', value: 'done' } }],
    completion_policy: {},
  }
}

test('a single-step workflow runs through a real durable Gateway + mock backend to completed, and recovery returns the same task', async () => {
  const root = mkdir('wf-gw-')
  process.env.VIBE_DIR = path.join(root, 'vibe'); fs.mkdirSync(process.env.VIBE_DIR, { recursive: true })
  process.env.VIBE_MOCK_OUTPUT = JSON.stringify({ status: 'done', summary: 'mock did it' })
  const dbPath = path.join(root, 'control.sqlite')

  let store: SqliteControlStore | undefined
  let gw: GatewayServer | undefined
  try {
    store = openControlStore({ path: dbPath })
    gw = await startAgentGateway({ host: '127.0.0.1', port: 0, apiToken: TOKEN, taskStore: store })
    const client = new GatewayClient(`http://127.0.0.1:${gw.port}`, TOKEN)
    const taskClient = new GatewayAgentTaskClient(client)
    const rt = new WorkflowRuntime({ store, taskClient, waitWindowMs: 1000 })

    const { workflow_id } = await rt.createWorkflow(singleStepSpec(), { objective: 'ship the thing' })
    await rt.startWorkflow(workflow_id)
    await rt.awaitWorkflow(workflow_id)

    const wf = (await store.getWorkflow(workflow_id))!
    assert.equal(wf.status, 'completed', 'workflow completes via the real Gateway')
    assert.equal(wf.total_tasks, 1)

    const steps = await store.listStepExecutions(workflow_id)
    assert.equal(steps.length, 1)
    const soloTaskId = steps[0].task_id!
    assert.ok(soloTaskId, 'the step bound a durable Gateway task')
    // the runtime sent the step_execution_id as the Gateway idempotency_key
    assert.equal(store.getTaskByIdempotencyKey(steps[0].step_execution_id)?.task_id, soloTaskId)
    // the durable Gateway task consumed complete canonical history → validated output routed to $complete
    assert.deepEqual(steps[0].output, { status: 'done', summary: 'mock did it' })
    const snap = (await store.getWorkflowSnapshot(workflow_id))!
    assert.equal((snap.context as any).prior_task_ids?.includes(soloTaskId), true)

    // restart/recovery: a fresh runtime recovers — the workflow is terminal, the
    // task identity is unchanged, and nothing is re-run.
    const rt2 = new WorkflowRuntime({ store, taskClient })
    await rt2.recoverWorkflows()
    const wf2 = (await store.getWorkflow(workflow_id))!
    assert.equal(wf2.status, 'completed'); assert.equal(wf2.total_tasks, 1)
    assert.equal((await store.listStepExecutions(workflow_id))[0].task_id, soloTaskId)
  } finally {
    delete process.env.VIBE_MOCK_OUTPUT
    if (gw) { try { await gw.close() } catch { /* */ } }
    if (store) { try { store.closeSync() } catch { /* */ } }
  }
})
