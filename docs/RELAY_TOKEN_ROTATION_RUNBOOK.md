# Relay token rotation & restart runbook

How to restart the relay or rotate its auth token **without locking the live
node out**. This runbook assumes the hardening in
`fix/relay-pairing-persistence-and-token-grace` is deployed:

- **Pairing persistence** — `relay dev --require-pairing` now persists paired
  node identities to a file (`--pairings-file`, `VIBE_RELAY_PAIRINGS_FILE`, or
  the default `~/.vibe/relay-pairings.json`). A relay restart no longer drops
  pairings, so the node re-registers automatically without `vibe node pair`.
- **Multi-token grace** — the relay accepts the *union* of `VIBE_RELAY_TOKEN`,
  `VIBE_RELAY_TOKEN_CURRENT`, `VIBE_RELAY_TOKEN_NEXT`, and the comma-separated
  `VIBE_RELAY_TOKENS`. During rotation, both the old and new token are valid, so
  each side can be updated independently.

> Token values must never be printed. The relay logs only `tokens: N accepted
> [REDACTED]` and the (non-secret) pairings file path.

## Topology (current deployment)

- Relay VM: GCE `vi-relay`, zone `us-central1-a`, project `dynastylab-pi`.
- Our node's relay: `vibe-relay.service` →
  `relay dev --host 127.0.0.1 --port 8788 --require-pairing`, token from
  `EnvironmentFile=/etc/vibe-relay.env` (`VIBE_RELAY_TOKEN`), `Restart=always`.
- Node side (WSL): `vibe node daemon --local --relay "$VIBE_RELAY_URL"`, token
  from `VIBE_RELAY_TOKEN` in `~/.config/vibe-symphony/env` (0600). **No `--token`
  in argv.**

---

## Part A — Deploy the hardening PR (one-time)

1. On the relay VM, fast-forward `/opt/vibe_interface_cli` to the merged commit
   and rebuild: `git fetch && git merge --ff-only origin/main && npm ci && npm run build`.
2. Configure pairing persistence in `/etc/vibe-relay.env` (alongside the
   existing `VIBE_RELAY_TOKEN`):

   ```ini
   VIBE_RELAY_PAIRINGS_FILE=/var/lib/vibe-relay/relay-pairings.json
   ```

   Ensure the directory exists and is owned by the relay service user
   (`jozzy_lzy_gmail_com`), mode `0700`. (If unset, the relay defaults to
   `~/.vibe/relay-pairings.json` under the service user, which also works.)
3. Restart once to pick up the new build + persistence:
   `sudo systemctl restart vibe-relay.service`.
4. **Verify the node reconnects WITHOUT `vibe node pair`:** the first restart
   after deploy has no persisted pairings yet, so re-pair the node ONE last time
   (`vibe node pair --relay "$VIBE_RELAY_URL"`), confirm `registered ✓`. From now
   on the pairing is on disk — restart again and confirm the node re-registers
   on its own (check relay `ss -ntp | grep :8788` shows the node, and the daemon
   log shows `registered ✓`).

## Part B — Rotate the token (zero-downtime)

Pre-req: Part A deployed, node online, mock canary green.

1. **Add the next token as a grace token on the relay.** Edit
   `/etc/vibe-relay.env`:

   ```ini
   VIBE_RELAY_TOKEN_CURRENT=<existing token>
   VIBE_RELAY_TOKEN_NEXT=<new token>
   ```

   (Either form works; `VIBE_RELAY_TOKENS=<old>,<new>` is equivalent.)
2. **Reload the relay** so it accepts both: `sudo systemctl restart
   vibe-relay.service`. Pairings persist (Part A), so the node stays registered;
   it is still authenticating with the *old* token, which is still accepted.
   Verify the node is connected.
3. **Update the node** to the new token: set `VIBE_RELAY_TOKEN=<new token>` in
   `~/.config/vibe-symphony/env` (keep mode 0600; preserve `VIBE_RELAY_URL`,
   `LINEAR_API_KEY`, `VIBE_ENABLE_CODEX`).
4. **Restart the node daemon** with the safe launch (no `--token` in argv):

   ```bash
   tmux kill-session -t vibe-daemon 2>/dev/null || true
   tmux new-session -d -s vibe-daemon \
     "set -a && source ~/.config/vibe-symphony/env && set +a && \
      exec node /path/to/dist/src/index.js node daemon --local --relay \"\$VIBE_RELAY_URL\" \
      2>&1 | tee -a /tmp/vibe-daemon-restart.log"
   ```

   Confirm `registered ✓` (now authenticating with the new token, also accepted)
   and that `/proc/<pid>/cmdline` contains no `--token`.
5. **Remove the old token from the relay.** Edit `/etc/vibe-relay.env` down to a
   single `VIBE_RELAY_TOKEN=<new token>` (drop `_CURRENT`/`_NEXT`/old list
   entries).
6. **Reload the relay** again: `sudo systemctl restart vibe-relay.service`.
   Pairings persist; the node (already on the new token) re-registers.
7. **Verify the old token is now rejected:** a connection with the old token
   must get HTTP 401 (e.g. a throwaway `vibe node list --remote --token <old>`
   exits non-zero). The node, on the new token, stays online.
8. **Mock canary:** `vibe run start --agent mock --workspace-key rotation-smoke`
   → expect `completed`, `switched=false`; then clean up the run/event/workspace
   artifacts.

## Rollback

- **During Part B, before step 5** (old token still in `_CURRENT`): if the node
  cannot reconnect on the new token, revert `~/.config/vibe-symphony/env` to the
  old `VIBE_RELAY_TOKEN`, restart the daemon — the relay still accepts the old
  token, so connectivity is restored. Investigate before retrying.
- **After step 6** (old token removed): rolling back means re-adding the old
  token as a grace token (`VIBE_RELAY_TOKEN_NEXT=<old>`) and reloading the relay,
  then pointing the node back. Because pairings persist, no re-pair is needed.
- **Pairings file loss/corruption:** the relay starts with zero pairings (it
  does not crash). Recover by running `vibe node pair --relay "$VIBE_RELAY_URL"`
  once; the file is rewritten atomically.

## Notes

- The pairings file contains only **public** identity material (public keys,
  node ids, fingerprints) — never a token or private key. Rotating the token
  does **not** invalidate it.
- A relay restart is effectively one-way for the in-memory process, but with
  persistence + grace it is no longer node-affecting: the node reconnects on its
  own and keeps a valid token throughout.
