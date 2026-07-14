/**
 * `vibe mcp serve` — a stdio MCP server that exposes the Vibe Agent Gateway as MCP
 * tools. It is a PURE CLIENT of the gateway's HTTP API: no relay, no relay token,
 * no task-execution logic, no Gateway-core change.
 *
 * The API Bearer token is read from the gateway's 0600 token file and used only in
 * the Authorization header — it is never accepted as a CLI argument, never printed,
 * and never placed in tool schemas/results/logs. stdout is reserved for MCP protocol
 * messages; all human/diagnostic output goes to stderr.
 */
import { Command } from 'commander'
import path from 'path'
import { vibeDir } from '../config.js'
import { readPackageVersion } from '../lib/pkg-version.js'
import { GatewayClient, readGatewayToken, isLoopbackGatewayUrl } from '../mcp/gateway-client.js'
import { runStdioMcpServer } from '../mcp/server.js'

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787'

function fail(code: string, message: string): never {
  // stderr only — stdout is reserved for MCP protocol messages.
  process.stderr.write(`error: ${code}: ${message}\n`)
  process.exit(1)
}

export function registerMcpCommand(program: Command): void {
  const mcp = program.command('mcp').description('Model Context Protocol server exposing the Agent Gateway as tools')

  mcp
    .command('serve')
    .description('run a stdio MCP server that proxies the local Agent Gateway HTTP API')
    .option('--gateway-url <url>', `Agent Gateway base URL (loopback-only unless --allow-remote-gateway)`, DEFAULT_GATEWAY_URL)
    .option('--token-file <path>', 'path to the gateway API bearer-token file (default: <vibe_dir>/api-token)')
    .option('--allow-remote-gateway', 'permit a non-loopback --gateway-url (the Bearer token would traverse the network)')
    .action((opts: { gatewayUrl: string; tokenFile?: string; allowRemoteGateway?: boolean }) => {
      let base: URL
      try { base = new URL(opts.gatewayUrl) } catch { fail('invalid_gateway_url', `--gateway-url is not a valid URL: ${opts.gatewayUrl}`) }
      if (base!.protocol !== 'http:' && base!.protocol !== 'https:') fail('invalid_gateway_url', 'only http/https gateway URLs are supported')
      if (!isLoopbackGatewayUrl(opts.gatewayUrl) && !opts.allowRemoteGateway) {
        fail('gateway_bind_refused', `refusing a non-loopback gateway URL (${base!.hostname}) — the Bearer token would traverse the network. Re-run with --allow-remote-gateway if intended.`)
      }

      const tokenPath = opts.tokenFile ?? path.join(vibeDir(), 'api-token')
      const tok = readGatewayToken(tokenPath)
      if (!tok.ok) fail(tok.code, tok.message)

      const client = new GatewayClient(opts.gatewayUrl, tok.token)
      process.stderr.write(`vibe mcp: serving MCP over stdio -> Agent Gateway ${opts.gatewayUrl} (token from ${tokenPath}). Diagnostics on stderr; MCP protocol on stdout.\n`)
      runStdioMcpServer(client, readPackageVersion())
    })
}
