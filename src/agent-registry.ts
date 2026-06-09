import { execSync } from 'child_process'

function binaryExists(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Returns the list of agent backends this node should advertise.
 * Always includes mock and claude-code.
 * Includes codex only when VIBE_ENABLE_CODEX=1 and the codex binary is in PATH.
 */
export function resolveAgents(): string[] {
  const agents: string[] = ['mock', 'claude-code']

  if (process.env.VIBE_ENABLE_CODEX === '1') {
    if (binaryExists('codex')) {
      agents.push('codex')
    } else {
      process.stderr.write(
        '[vibe-node] VIBE_ENABLE_CODEX=1 but codex binary not found in PATH — codex agent will NOT be advertised\n',
      )
    }
  }

  return agents
}
