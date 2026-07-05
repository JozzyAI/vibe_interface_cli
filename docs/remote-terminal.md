# Remote terminal (phone / LAN / VPN → node tmux)

Drive a tmux session on a remote Vibe node — a shell, or an interactive **Claude
Code** session — from a browser (including your phone), over your LAN or VPN.

```
phone / VPN  ->  Mac terminal gateway  ->  relay  ->  WSL node daemon  ->  tmux  ->  shell / Claude Code
```

- The **gateway** (`vibe terminal serve`) runs on a machine that owns a
  browser-reachable IP (e.g. the Mac at `192.168.1.89`).
- The **relay** routes `terminal_*` messages between the gateway and the node.
- The **node daemon** attaches to an *existing* tmux session on its own box
  (`send-keys` in, `capture-pane` out). It never creates or kills the session.

> Requires a relay and node running terminal-capable builds. The URL is
> **write-capable** — treat it as a secret (see [Security](#security)).

## Quick start

The node must already have the tmux session you want to attach to:

```bash
# on the node box
tmux new -d -s remote-claude 'bash'
```

Then serve it from the gateway machine. Relay URL and token-file come from your
**connect profile** (written by `vibe connect`), so you don't repeat them:

```bash
vibe terminal serve \
  --node node_f7cedd3b6590aff9 \
  --session remote-claude \
  --host 192.168.1.89 \
  --port 8790 \
  --allow-control-bind \
  --url-file ~/.cache/vibe/terminal-url
```

Open the URL from the file on your phone (same Wi-Fi / VPN):

```bash
cat ~/.cache/vibe/terminal-url
```

In the browser you can type into the session — e.g. `claude` to start Claude
Code and drive it interactively.

### Relay / token resolution

Precedence is **explicit flag > env > profile**, matching `vibe run
status/doctor`:

- `--relay` → else `VIBE_RELAY_TOKEN`/env → else profile `relay_url`.
- `--token-file` → else `VIBE_RELAY_TOKEN` env → else profile `token_file`.
- If no relay resolves, the command fails with `relay_required` and a hint to run
  `vibe connect` or pass `--relay`.

## Session lifecycle (create / list / stop)

You can create the session from the client, list what Vibe created, and stop it —
without shelling into the node box.

**Create-if-missing** — `serve --create` makes the session (a **login shell**) if
it doesn't exist, then attaches:

```bash
vibe terminal serve --node <id> --session remote-claude --create \
  --host 192.168.1.89 --port 8790 --allow-control-bind --url-file ~/.cache/vibe/terminal-url
```

> **The node must opt in.** Creating a session spawns a shell on the node, so the
> node operator must start the daemon with **`--allow-terminal-create`** (or
> `VIBE_TERMINAL_ALLOW_CREATE=1`). Default is **OFF** — otherwise `--create`
> fails with `terminal_create_disabled`. Attach/list/stop don't need it.

**List / stop** (relay + token from the profile, like `serve`):

```bash
vibe terminal list --node <id>                       # Vibe-owned sessions only
vibe terminal stop --node <id> --session remote-claude
```

**Ownership & safety:**
- Only sessions Vibe **created** are marked owned (a tmux `@vibe_owned` option).
- `list` shows **only** owned sessions; `stop` kills **only** owned sessions and
  **refuses** anything else (`terminal_not_owned`) — so `vibe-node` and your own
  tmux sessions can never be killed by Vibe. Vibe never runs `tmux kill-server`.
- `serve --create` on a session that already exists just **attaches** — it does
  not take ownership, so `stop` won't kill it.
- Session names are validated (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) and every tmux
  call uses an args array — no shell interpolation, no injection.
- **No arbitrary command:** created sessions run a login shell only. `--command`
  (e.g. one-tap `claude`) is deferred.

## Safe URL handling

The control URL contains the write-capable token. Keep it out of your terminal
scrollback and shell history:

- `--url-file <path>` — writes the full tokenized URL to a `0600` file (parent
  directories are created). stdout only prints `URL written to <path>` — the
  token is **not** printed.
- `--print-url-only` — prints just the bare URL (for scripting; this *does*
  include the token, by design).
- `--quiet` — suppresses the human info/warning lines (errors still print).
- `--json` — machine-readable; with `--url-file` it emits `url_file` instead of
  the tokenized `url`.

## Security

- **Write-capable.** Anyone with the URL can type into the session (and any
  Claude running in it). The control token is the only gate — **keep it secret**.
- **Loopback by default.** A non-loopback bind (LAN/VPN) requires
  `--allow-control-bind` and prints a warning.
- **LAN / VPN only.** Do **not** port-forward or otherwise expose the gateway
  port (e.g. `8790`) to the public internet. Reach it over your home LAN or a
  VPN back to that LAN.
- Nothing sensitive is logged: relay token, control token, and typed keystrokes
  are never written to logs — the token appears only in the intended URL output
  (or `--url-file`).

## Cleanup

- **Stop the gateway** with `Ctrl-C` (foreground) or, if backgrounded:
  ```bash
  pkill -f "terminal serve"
  ```
- Stopping the gateway **does not** kill the remote tmux session or anything
  running in it (Claude keeps going). To end the session itself, do it on the
  node explicitly:
  ```bash
  tmux kill-session -t remote-claude   # on the node box
  ```
