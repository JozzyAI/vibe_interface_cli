/**
 * Inventory contract — the SAFE snapshot of available Agents, Nodes, and
 * capabilities the compiler may assign. The compiler NEVER queries the relay/Node
 * directly; it receives an injected {@link InventoryProvider} snapshot, and trusted
 * validation checks every generated assignment against it.
 */

/** One assignable (agent, node) pair. `node_id` absent → a local/in-process agent. */
export interface InventoryAgent {
  agent: string
  node_id?: string
  /** Permission modes this placement can actually enforce (e.g. 'default'). */
  permission_modes: string[]
  /** Whether a contained workspace is supported at this placement. */
  workspace_supported: boolean
  /** Bounded capability tags (e.g. 'run', 'workspace_lease_v1'). */
  capabilities: string[]
}

export interface Inventory {
  agents: InventoryAgent[]
  observed_at: string
}

export interface InventoryProvider {
  /** A bounded, safe snapshot of assignable agents/nodes (no tokens/keys/paths). */
  snapshot(): Promise<Inventory>
}

/** Find the inventory entry supporting an (agent, node_id) placement, or null. */
export function findPlacement(inv: Inventory, agent: string, nodeId: string | undefined): InventoryAgent | null {
  return inv.agents.find((a) => a.agent === agent && (a.node_id ?? null) === (nodeId ?? null)) ?? null
}
