/**
 * `vibe api serve` — the local Agent Task Gateway (mock/local only in this
 * layer). Uses a DEDICATED API bearer token (never the relay/terminal token),
 * loopback-only by default, and serves the canonical Task REST + SSE API.
 *
 * The token lives ONLY in a 0600 token file (default `<vibe_dir>/api-token`,
 * overridable with --token-file). It is created once (atomic, exclusive) and
 * reused on later starts; the token itself is NEVER printed — only the file path.
 */
import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import { loadProfile } from '../lib/node-config.js'
import { vibeDir } from '../config.js'
import { generateAccessToken } from '../lib/run-web.js'
import { isLoopbackHost } from '../lib/terminal-web.js'
import { startAgentGateway, DEFAULT_API_PORT } from '../lib/agent-gateway.js'

function fail(code: string, message: string): never {
  process.stdout.write(JSON.stringify({ error: true, code, message, ts: new Date().toISOString() }) + '\n')
  process.stderr.write(`error: ${code}: ${message}\n`)
  process.exit(1)
}

export type TokenFileResult =
  | { ok: true; token: string; path: string; created: boolean }
  | { ok: false; code: string; message: string }

/**
 * Resolve the API bearer token from a 0600 token file, creating it once if
 * missing. Pure enough to unit-test: returns a Result and NEVER calls
 * process.exit (the command maps failures to `fail`). Security properties:
 *   - atomic EXCLUSIVE create (flag 'wx') — no overwrite, no create-time symlink
 *     follow, no partial-write race between concurrent starts;
 *   - an existing path must be a regular file (not a symlink) and, where POSIX
 *     permissions apply, must not be group/world-accessible;
 *   - contents must be a non-empty, well-formed token;
 *   - the token is never included in any error message.
 */
export function resolveApiTokenFile(tokenPath: string): TokenFileResult {
  const abs = path.resolve(tokenPath)
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }) }
  catch (err) { return { ok: false, code: 'token_dir_failed', message: `could not create token directory: ${(err as Error).message}` } }

  const fresh = generateAccessToken()
  try {
    // O_CREAT|O_EXCL|O_WRONLY: fails EEXIST if the path exists (incl. a symlink),
    // so creation never follows a symlink and never overwrites.
    fs.writeFileSync(abs, fresh + '\n', { flag: 'wx', mode: 0o600 })
    return { ok: true, token: fresh, path: abs, created: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { ok: false, code: 'token_file_write_failed', message: `could not write token file: ${(err as Error).message}` }
    }
    // Exists — validate and reuse (never overwrite).
  }

  let st: fs.Stats
  try { st = fs.lstatSync(abs) }
  catch (err) { return { ok: false, code: 'token_file_stat_failed', message: `could not stat token file: ${(err as Error).message}` } }
  if (st.isSymbolicLink()) return { ok: false, code: 'token_file_symlink', message: `refusing to use token file ${abs}: it is a symbolic link` }
  if (!st.isFile()) return { ok: false, code: 'token_file_not_regular', message: `refusing to use token file ${abs}: not a regular file` }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    return { ok: false, code: 'token_file_insecure_perms', message: `refusing to use token file ${abs}: it is group/world-accessible (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${abs}` }
  }
  let raw: string
  try { raw = fs.readFileSync(abs, 'utf8') }
  catch (err) { return { ok: false, code: 'token_file_read_failed', message: `could not read token file: ${(err as Error).message}` } }
  const token = raw.trim()
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) return { ok: false, code: 'token_file_invalid', message: `token file ${abs} is empty or malformed` }
  return { ok: true, token, path: abs, created: false }
}

export function registerApiCommand(program: Command): void {
  const api = program.command('api').description('local Agent Task Gateway (canonical REST + SSE task API)')

  // Local runs read state from the connect profile's vibe_dir, like `vibe run`.
  api.hook('preAction', () => {
    if (!process.env.VIBE_DIR) {
      const vibeDirPath = loadProfile()?.vibe_dir
      if (vibeDirPath) process.env.VIBE_DIR = vibeDirPath
    }
  })

  api
    .command('serve')
    .description('serve the local Agent Task API (mock agent only; remote nodes deferred)')
    .option('--host <host>', 'bind host (default 127.0.0.1; non-loopback requires --allow-bind)', '127.0.0.1')
    .option('--port <port>', `port to listen on (default ${DEFAULT_API_PORT})`, String(DEFAULT_API_PORT))
    .option('--token-file <path>', 'path to the 0600 API bearer-token file (default: <vibe_dir>/api-token; created once if missing, reused otherwise)')
    .option('--allow-bind', 'permit a non-loopback bind — exposes the write-capable API on the network (discouraged)')
    .option('--quiet', 'suppress the human info lines (errors still print)')
    .action(async (opts: { host: string; port: string; tokenFile?: string; allowBind?: boolean; quiet?: boolean }) => {
      const host = opts.host
      const port = Number.parseInt(opts.port, 10)
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('invalid_port', `--port must be 0-65535, got ${opts.port}`)

      if (!isLoopbackHost(host) && !opts.allowBind) {
        fail('bind_refused', `refusing to bind ${host}: the Agent Task API is write-capable and loopback-only by default. Re-run with --allow-bind to expose it on the network (discouraged).`)
      }

      // Dedicated API token file (default under the Vibe dir), created once at 0600.
      const tokenPath = opts.tokenFile ?? path.join(vibeDir(), 'api-token')
      const tf = resolveApiTokenFile(tokenPath)
      if (!tf.ok) fail(tf.code, tf.message)

      let server
      try {
        server = await startAgentGateway({ host, port, apiToken: tf.token })
      } catch (err) {
        fail('serve_failed', `could not start the gateway: ${(err as Error).message}`)
      }

      const base = `http://${host}:${server.port}`
      if (!opts.quiet) {
        if (!isLoopbackHost(host)) {
          process.stderr.write(`warning: the Agent Task API is WRITE-CAPABLE and now bound to ${host} (LAN/VPN). The bearer token is the only gate — keep it secret; do NOT expose this port to the public internet.\n`)
        }
        process.stdout.write(`vibe api: serving the Agent Task API on ${base}\n`)
        process.stdout.write(`  auth: send  Authorization: Bearer <token>  on every request\n`)
        process.stdout.write(`  API token file: ${tf.path} (mode 0600, ${tf.created ? 'created' : 'reused'}) — keep it secret; the token itself is never printed\n`)
        process.stdout.write(`  local mock agent only (remote Claude/Codex execution is deferred). Ctrl-C to stop.\n`)
      }

      const shutdown = (): void => { void server.close().then(() => process.exit(0)) }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
}
