import { resolveConfig } from './config.js'
import type { VibeNode, VibeError } from './types.js'

function getLocalNode(): VibeNode {
  const config = resolveConfig()
  const now = new Date().toISOString()
  return {
    node_id: 'local',
    name: 'Local Machine',
    status: 'online',
    transport: 'local',
    capabilities: ['run', 'stream', 'stop', 'workspace'],
    agents: ['mock', 'claude-code'],
    active_runs: 0,
    max_runs: 4,
    workspace_roots: [config.workspace_root],
    created_at: now,
    updated_at: now,
  }
}

export function listNodes(): VibeNode[] {
  return [getLocalNode()]
}

export function getNode(nodeId: string): VibeNode | undefined {
  if (nodeId === 'local') return getLocalNode()
  return undefined
}

/** Resolve a node selector ('auto' | 'local' | explicit id) to a VibeNode or structured error. */
export function resolveNode(selector: string): VibeNode | VibeError {
  const effectiveId = selector === 'auto' ? 'local' : selector
  const node = getNode(effectiveId)
  if (!node) {
    return {
      error: true,
      code: 'node_not_found',
      message: `Node not found: ${selector}`,
      ts: new Date().toISOString(),
    }
  }
  return node
}
