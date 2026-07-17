/**
 * Node/Harness-owned **verifier profile registry**.
 *
 * A workflow step selects a verifier by an OPAQUE profile ID (e.g. `node-test`).
 * The exact executable + argv for each profile live HERE, on the Node — never in
 * the WorkflowSpec, the compiler, or any LLM/user text. This removes the arbitrary
 * process-execution surface: a spec can only name an advertised profile; it can
 * never inject an interpreter, arguments, or a command.
 *
 * Adding a profile is a reviewed code change, not a runtime/spec input.
 */

export interface VerifierProfile {
  id: string
  /** The FIXED command the Node runs for this profile. Never derived from input. */
  argv: readonly string[]
  description: string
}

/** The built-in, Node-owned profiles. Argv is a constant; the ID is the only thing
 *  a spec may reference. */
const PROFILES: Record<string, VerifierProfile> = {
  'node-test': { id: 'node-test', argv: ['node', '--test'], description: "Node.js built-in test runner (`node --test`)" },
}

/** All advertised profile IDs (safe to expose in the compiler inventory). */
export const VERIFIER_PROFILE_IDS: readonly string[] = Object.freeze(Object.keys(PROFILES))

/** Resolve a profile ID to its Node-owned command. Unknown ID → null (caller must
 *  fail closed). The returned argv is a fresh copy so callers cannot mutate policy. */
export function resolveVerifierProfile(id: unknown): VerifierProfile | null {
  if (typeof id !== 'string') return null
  const p = PROFILES[id]
  return p ? { id: p.id, argv: [...p.argv], description: p.description } : null
}

export function isKnownVerifierProfile(id: unknown): boolean {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, id)
}
