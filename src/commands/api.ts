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
import { loadProfile, resolveClientDefaults } from '../lib/node-config.js'
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
    .option('--db-path <path>', 'durable control-store SQLite path (default: <vibe_dir>/control.sqlite). Persists task identity + event history and recovers non-terminal tasks on restart')
    .option('--allow-bind', 'permit a non-loopback bind — exposes the write-capable API on the network (discouraged)')
    .option('--relay <url>', 'relay ws URL — enables REMOTE agent execution on online nodes (else connect-profile relay_url)')
    .option('--relay-token-file <path>', 'relay auth token file for remote execution (else connect-profile token_file / VIBE_RELAY_TOKEN)')
    .option('--relay-token <token>', 'relay auth token (DEPRECATED: visible in process args; prefer --relay-token-file or VIBE_RELAY_TOKEN)')
    .option('--quiet', 'suppress the human info lines (errors still print)')
    .action(async (opts: { host: string; port: string; tokenFile?: string; dbPath?: string; allowBind?: boolean; relay?: string; relayTokenFile?: string; relayToken?: string; quiet?: boolean }) => {
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

      // Optional relay for REMOTE execution: relay URL + auth token from flags,
      // env, or the connect profile. The relay token is DISTINCT from the API
      // bearer token and is never printed. No relay => local/mock-only (as before).
      const defaults = resolveClientDefaults(
        { relay: opts.relay, token: opts.relayToken, tokenFile: opts.relayTokenFile },
        loadProfile(),
        { VIBE_DIR: process.env.VIBE_DIR, VIBE_RELAY_TOKEN: process.env.VIBE_RELAY_TOKEN },
      )
      let relayUrl = defaults.relay
      let relayToken: string | undefined
      if (relayUrl) {
        const { resolveRelayToken, warnIfTokenArg } = await import('../relay/token.js')
        warnIfTokenArg({ tokenFile: defaults.tokenFile, token: opts.relayToken })
        try {
          relayToken = resolveRelayToken({ tokenFile: defaults.tokenFile, token: opts.relayToken })
        } catch (err) {
          // Explicit --relay demands a token; an IMPLICIT (profile) relay degrades
          // to local-only rather than blocking a local mock gateway.
          if (opts.relay) fail('relay_token_required', `--relay set but no relay auth token: ${(err as Error).message}`)
          if (!opts.quiet) process.stderr.write(`warning: a connect-profile relay was found but no relay token resolved — remote execution disabled (local mock only)\n`)
          relayUrl = undefined
        }
      }

      // Durable control store (task persistence + restart recovery). Defaults
      // under the Vibe dir; on any open/migrate failure (missing/corrupt/too-new/
      // insecure/symlinked DB) fail startup CLEARLY — never silently run
      // memory-only. The --db-path is a filesystem path, never a token/secret.
      const dbPath = opts.dbPath ?? path.join(vibeDir(), 'control.sqlite')
      let store: import('../control/sqlite-store.js').SqliteControlStore
      try {
        const { openControlStore } = await import('../control/sqlite-store.js')
        store = openControlStore({ path: dbPath }) // opens + migrates before we accept requests
        await store.healthCheck()
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'control_store_failed'
        fail(code, `could not open the durable control store at ${dbPath}: ${(err as Error).message}`)
      }

      // The WorkflowRuntime's task client targets THIS gateway over loopback, so it
      // is built AFTER listen and injected via a lazy accessor (undefined until then).
      let workflowRuntime: import('../workflow/runtime.js').WorkflowRuntime | undefined
      let workflowCompiler: import('../workflow/compiler/compiler.js').WorkflowCompiler | undefined
      let workflowBuilder: import('../workflow/builder/service.js').WorkflowBuilderService | undefined
      let server
      try {
        server = await startAgentGateway({ host, port, apiToken: tf.token, relay: relayUrl, relayToken, taskStore: store, controlStore: store, getWorkflowRuntime: () => workflowRuntime, getWorkflowCompiler: () => workflowCompiler, getWorkflowBuilder: () => workflowBuilder })
      } catch (err) {
        try { store.closeSync() } catch { /* ignore */ }
        fail('serve_failed', `could not start the gateway: ${(err as Error).message}`)
      }

      const base = `http://${host}:${server.port}`

      // Wire the durable Workflow Runtime to the SAME control store, driving Agent
      // Tasks through the colocated Gateway task API over loopback with the existing
      // API bearer token (never printed; no second listener; no relay token). Recover
      // running workflows in the background — recovery schedules bounded pumps and
      // returns immediately (it never blocks startup on an unavailable node).
      try {
        const { GatewayClient } = await import('../mcp/gateway-client.js')
        const { GatewayAgentTaskClient } = await import('../workflow/task-client.js')
        const { WorkflowRuntime } = await import('../workflow/runtime.js')
        const taskClient = new GatewayAgentTaskClient(new GatewayClient(base, tf.token))
        // A workspace-bound workflow needs the Node workspace-lease authority, reached
        // over the relay. Only construct the lease client when a relay + token are
        // configured; without it, a workspace-bound workflow FAILS CLOSED at start
        // (workspace_lease_unsupported) rather than running unleased.
        let leaseClient: import('../workflow/workspace-lease-client.js').WorkspaceLeaseClient | undefined
        if (relayUrl && relayToken) {
          const { RelayWorkspaceLeaseClient } = await import('../workflow/workspace-lease-client.js')
          leaseClient = new RelayWorkspaceLeaseClient(relayUrl, relayToken)
        }
        workflowRuntime = new WorkflowRuntime({ store, taskClient, leaseClient })
        await workflowRuntime.recoverWorkflows()
        // The natural-language Workflow Compiler runs its model through the SAME durable
        // Agent Task path (over loopback) and consumes a safe inventory snapshot of the
        // gateway's agents/nodes. Compile creates an immutable draft; approve materializes
        // a ready workflow (never started).
        const { WorkflowCompiler } = await import('../workflow/compiler/compiler.js')
        const { AgentTaskCompilerModelClient } = await import('../workflow/compiler/model-client.js')
        const { GatewayInventoryProvider } = await import('../workflow/compiler/inventory-gateway.js')
        const inventory = new GatewayInventoryProvider({
          localAgents: ['mock'],
          ...(relayUrl && relayToken ? { fetchNodes: async () => { const { fetchRemoteNodes } = await import('../relay/client.js'); return (await fetchRemoteNodes(relayUrl!, relayToken!)).map((n) => ({ node_id: n.node_id, status: n.status, agents: n.agents, capabilities: n.capabilities })) } } : {}),
        })
        workflowCompiler = new WorkflowCompiler({ store, model: new AgentTaskCompilerModelClient(taskClient), inventory })
        // The Conversational Workflow Builder persists sessions/messages and drives the
        // SAME compiler over the SAME control store (no second spec format, no bypass).
        const { WorkflowBuilderService } = await import('../workflow/builder/service.js')
        workflowBuilder = new WorkflowBuilderService(store, workflowCompiler)
      } catch (err) {
        if (!opts.quiet) process.stderr.write(`warning: workflow runtime/compiler init hit an error (workflow routes remain available): ${(err as Error).message}\n`)
      }
      if (!opts.quiet) {
        if (!isLoopbackHost(host)) {
          process.stderr.write(`warning: the Agent Task API is WRITE-CAPABLE and now bound to ${host} (LAN/VPN). The bearer token is the only gate — keep it secret; do NOT expose this port to the public internet.\n`)
        }
        process.stdout.write(`vibe api: serving the Agent Task API on ${base}\n`)
        process.stdout.write(`  auth: send  Authorization: Bearer <token>  on every request\n`)
        process.stdout.write(`  API token file: ${tf.path} (mode 0600, ${tf.created ? 'created' : 'reused'}) — keep it secret; the token itself is never printed\n`)
        process.stdout.write(`  durable store: ${dbPath} (tasks + event history persisted; non-terminal tasks recovered on restart)\n`)
        process.stdout.write(`  workflows: durable Workflow Runtime enabled — POST /v1/workflows to create, /start to run (running workflows recovered on restart)\n`)
        process.stdout.write(`  workflow UI: open  ${base}/ui?token=<api token>  to compile + preview a workflow draft (loopback)\n`)
        if (relayUrl) {
          process.stdout.write(`  remote execution: ENABLED via relay ${relayUrl} — target a node with node_id (agents: GET /v1/agents)\n`)
        } else {
          process.stdout.write(`  remote execution: disabled (local mock only) — pass --relay / run 'vibe connect' to enable\n`)
        }
        process.stdout.write(`  Ctrl-C to stop.\n`)
      }

      // Ordered shutdown: (1)+(2)+(3) abort workflow waits/pumps/backoff and shut
      // down the runtime FIRST (its task client calls the gateway over loopback, so
      // the gateway must still be up); then (4) close the Gateway (task pumps + SSE);
      // then (5) close the ControlStore cleanly.
      const shutdown = (): void => {
        void (async () => {
          try { await workflowRuntime?.shutdown() } catch { /* ignore */ }
          try { await server.close() } catch { /* ignore */ }
          try { store.closeSync() } catch { /* ignore */ }
          process.exit(0)
        })()
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
}
