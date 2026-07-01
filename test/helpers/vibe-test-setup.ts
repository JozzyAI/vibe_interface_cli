/**
 * Global test-run setup, loaded once per test worker via `node --test --import`
 * (see the "test" script in package.json).
 *
 * It isolates VIBE_PROFILE for EVERY suite so no test ever reads the developer's
 * real `~/.config/vibe/profile.json`. That matters because a real profile with a
 * `relay_url` (e.g. written by `vibe connect`) makes the profile-aware run
 * commands (`run status/stream/stop`, `run web`, and a bare `vibe node daemon`)
 * take the REMOTE path — which, on a local-run test, either fails
 * (`run_not_found`) or HANGS waiting on the relay.
 *
 * A never-existing path ⇒ the CLI's `loadProfile()` returns null ⇒ local
 * behaviour everywhere. Suites that deliberately exercise profile behaviour
 * (e.g. run-profile) still set their own VIBE_PROFILE per spawn, overriding this
 * default; and if the runner is invoked with VIBE_PROFILE already set, we leave
 * it untouched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!process.env.VIBE_PROFILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-test-noprofile-'))
  process.env.VIBE_PROFILE = path.join(dir, 'no-profile.json') // never created
}
