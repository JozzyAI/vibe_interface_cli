/**
 * Shared test helper: run the CLI against FAKE agent fixtures only — never the
 * real (paid) claude / codex / opencode CLIs, and never the real ~/.vibe.
 *
 * Any test that exercises a real backend (`--agent claude-code|codex`) must
 * build its child-process env through `fakeAgentEnv()` (or at least put
 * FIXTURES first on PATH and set VIBE_DIR), so that:
 *   - PATH is fixtures-first: spawning `claude` / `codex` resolves to the fake
 *     script in test/fixtures/, shadowing any real binary that happens to be
 *     installed on the developer's / CI machine.
 *   - VIBE_DIR points at a throwaway temp dir, so run records never land in the
 *     real ~/.vibe.
 *
 * The guard suite in no-real-agents.test.ts asserts these invariants hold.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { after } from 'node:test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fixtures live in the source tree at test/fixtures (they are not copied into
// dist). This helper compiles to dist/test/helpers/, so walk up three levels to
// the repo root, then into test/fixtures.
export const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures')

/**
 * Paid-agent CLI names that have a fake fixture and must always resolve INTO
 * FIXTURES (never to a real install) when running on a fixtures-first PATH.
 * `opencode` is intentionally absent: it has no adapter that spawns a binary
 * (`run start --agent opencode` fails fast before any spawn), so there is
 * nothing to fake.
 */
export const FAKED_AGENT_BINARIES = ['claude', 'codex'] as const

/** Create a throwaway VIBE_DIR and schedule its removal after the suite. */
export function freshVibeDir(prefix = 'vibe-agenttest-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fixtures-first PATH so fake `claude` / `codex` shadow any real install. */
export function fixturesFirstPath(basePath = process.env.PATH ?? ''): string {
  return FIXTURES + path.delimiter + basePath
}

/**
 * Env for spawning the CLI with fake agents on a fixtures-first PATH and an
 * isolated VIBE_DIR. Pass `extra` to add knobs (e.g. FAKE_CLAUDE_EXIT_CODE) or
 * to override PATH / VIBE_DIR for negative tests.
 *
 * Note: each call allocates its own temp VIBE_DIR. For a suite that wants a
 * single shared dir, call `freshVibeDir()` once at module load and pass it in
 * via `extra: { VIBE_DIR }`.
 */
export function fakeAgentEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: fixturesFirstPath(),
    VIBE_DIR: freshVibeDir(),
    ...extra,
  }
}
