/**
 * Production InventoryProvider: a SAFE snapshot of assignable agents/nodes built from
 * the gateway's local agents + (when a relay is configured) the online remote nodes.
 * It reads only advertised, bounded metadata — never tokens, keys, or paths — and it
 * does not let the compiler touch the relay/Node directly (this provider does, once,
 * to build the snapshot the compiler then consumes as data).
 */
import type { Inventory, InventoryAgent, InventoryProvider } from './inventory.js'
import { VERIFIER_PROFILE_IDS } from '../../runtime/verifier-profiles.js'
import { VERIFY_SANDBOX_CAPABILITY } from '../../runtime/sandbox.js'

export interface RemoteNodeInfo { node_id: string; status: string; agents?: string[]; capabilities?: string[] }
export interface GatewayInventoryOptions {
  localAgents: string[]
  fetchNodes?: () => Promise<RemoteNodeInfo[]>
}

export class GatewayInventoryProvider implements InventoryProvider {
  constructor(private readonly opts: GatewayInventoryOptions) {}
  async snapshot(): Promise<Inventory> {
    const agents: InventoryAgent[] = []
    for (const a of this.opts.localAgents) agents.push({ agent: a, permission_modes: ['default'], workspace_supported: false, capabilities: [] })
    if (this.opts.fetchNodes) {
      let nodes: RemoteNodeInfo[] = []
      try { nodes = await this.opts.fetchNodes() } catch { nodes = [] }
      for (const n of nodes) {
        if (n.status !== 'online') continue
        const caps = Array.isArray(n.capabilities) ? n.capabilities : []
        const wsSupported = caps.includes('workspace')
        // Advertise verifier profile IDs ONLY when the node advertises an enforcing
        // verifier sandbox. Never expose argv/commands — just the safe profile ids.
        const verifierProfiles = caps.includes(VERIFY_SANDBOX_CAPABILITY) ? [...VERIFIER_PROFILE_IDS] : []
        for (const a of Array.isArray(n.agents) ? n.agents : []) {
          agents.push({ agent: a, node_id: n.node_id, permission_modes: ['default'], workspace_supported: wsSupported, capabilities: caps, verifier_profiles: verifierProfiles })
        }
      }
    }
    return { agents, observed_at: new Date().toISOString() }
  }
}
