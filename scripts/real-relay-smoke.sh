#!/usr/bin/env bash
# Real-relay transport smoke — minimal live verification of the core Vibe run
# contract (start → status → stream → stop) over a REAL relay, MOCK agent only.
#
#   local CLI  ──▶  real relay  ──▶  node daemon (this box)  ──▶  mock run
#
# This is the manual counterpart to the fully-automated, fake-relay smoke in
# test/relay-transport-smoke.test.ts (PR #20). It is intentionally NOT wired
# into the test suite: a real relay needs a real token, which never belongs in
# CI. Run it by hand when you want to confirm the live transport.
#
# ─ Safety model (read before running) ───────────────────────────────────────
#  * MOCK ONLY. This script only ever issues `--agent mock`. It never uses
#    `--agent auto` and never invokes a real claude/codex/opencode.
#  * MOCK-ONLY ADVERTISE (PR #23). This script sets VIBE_NODE_ADVERTISE_AGENTS=mock,
#    so the daemon publishes EXACTLY `["mock"]` to the relay (resolveAdvertisedAgents
#    in src/agent-registry.ts) — a production orchestrator/Symphony cannot dispatch
#    a real claude-code job to this node because it never advertises that capability.
#    The script verifies the advertised set is `["mock"]` right after registration
#    and aborts otherwise.
#  * DISPATCH-PAUSE GATE (defense-in-depth). Even with the mock-only valve, this
#    script still refuses to run unless you assert production dispatch is paused:
#        I_CONFIRM_DISPATCH_PAUSED=1
#  * ISOLATION. The daemon runs against a throwaway VIBE_DIR and a throwaway
#    node-id, so it does not disturb this machine's real ~/.vibe or the
#    persistent node identity (e.g. node_f7cedd3b6590aff9). Nothing is paired or
#    written under the real ~/.vibe.
#  * TOKEN HYGIENE. The token is read from --token-file (preferred) or the
#    VIBE_RELAY_TOKEN env. It is NEVER passed as `--token <value>` (which would
#    leak it into process args), never echoed, and never written to a log.
#
# ─ Usage ────────────────────────────────────────────────────────────────────
#   I_CONFIRM_DISPATCH_PAUSED=1 \
#   RELAY_URL=wss://vibe-relay.dynastylab.ai \
#   VIBE_RELAY_TOKEN_FILE=/path/to/0600-token-file \
#     bash scripts/real-relay-smoke.sh
#
#   # or supply the token via env instead of a file:
#   I_CONFIRM_DISPATCH_PAUSED=1 RELAY_URL=... VIBE_RELAY_TOKEN=... \
#     bash scripts/real-relay-smoke.sh
#
#   # optional: how long to wait for the relay to mark the node offline/absent
#   # after the daemon stops (default 90s, ≈6× the relay's 15s default stale window):
#   SMOKE_OFFLINE_TIMEOUT_SEC=120 ... bash scripts/real-relay-smoke.sh
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
say()  { printf "%b\n" "$1"; }
fail() { printf "%b\n" "${RED}✗ $1${NC}" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/dist/src/index.js"
[ -f "$CLI" ] || fail "CLI not built: $CLI (run: npm run build && chmod +x dist/src/index.js)"

RELAY_URL="${RELAY_URL:-wss://vibe-relay.dynastylab.ai}"
NODE_ID="smoke-$(date +%s)-$$"           # throwaway node-id; never the persistent one
WORKSPACE_KEY="real-relay-smoke-$$"

# ── 1. Safety gate ───────────────────────────────────────────────────────────
if [ "${I_CONFIRM_DISPATCH_PAUSED:-}" != "1" ]; then
  say "${YELLOW}Refusing to bring a node online on a real relay.${NC}"
  say "This node advertises ${CYAN}mock${NC} only (VIBE_NODE_ADVERTISE_AGENTS), but as a"
  say "defense-in-depth gate we still require you to confirm production dispatch is paused"
  say "before any node goes online on the real relay. Re-run only when dispatch is paused:"
  say "    ${DIM}I_CONFIRM_DISPATCH_PAUSED=1 RELAY_URL=$RELAY_URL VIBE_RELAY_TOKEN_FILE=... bash scripts/real-relay-smoke.sh${NC}"
  exit 2
fi

# ── 2. Resolve a token file WITHOUT putting the token in argv ─────────────────
# Precedence: VIBE_RELAY_TOKEN_FILE (used directly) > VIBE_RELAY_TOKEN (copied
# into a private 0600 temp file). We always hand the CLI/daemon a --token-file.
TMP_TOKEN_FILE=""
if [ -n "${VIBE_RELAY_TOKEN_FILE:-}" ]; then
  [ -f "$VIBE_RELAY_TOKEN_FILE" ] || fail "VIBE_RELAY_TOKEN_FILE not found: $VIBE_RELAY_TOKEN_FILE"
  TOKEN_FILE="$VIBE_RELAY_TOKEN_FILE"
elif [ -n "${VIBE_RELAY_TOKEN:-}" ]; then
  TMP_TOKEN_FILE="$(mktemp)"; chmod 600 "$TMP_TOKEN_FILE"
  printf '%s' "$VIBE_RELAY_TOKEN" > "$TMP_TOKEN_FILE"
  TOKEN_FILE="$TMP_TOKEN_FILE"
else
  fail "no token: set VIBE_RELAY_TOKEN_FILE=<0600 path> or VIBE_RELAY_TOKEN=<value> (never --token)"
fi

# ── 3. Isolated, throwaway state ─────────────────────────────────────────────
VIBE_DIR="$(mktemp -d -t vibe-real-smoke-XXXXXX)"
export VIBE_DIR
# Mock-only advertise valve (PR #23): the daemon publishes EXACTLY ["mock"] to the
# relay, so no real claude-code job can ever be dispatched to this throwaway node.
export VIBE_NODE_ADVERTISE_AGENTS=mock
say "${CYAN}relay${NC}     $RELAY_URL"
say "${CYAN}node-id${NC}   $NODE_ID  ${DIM}(throwaway)${NC}"
say "${CYAN}advertise${NC} $VIBE_NODE_ADVERTISE_AGENTS  ${DIM}(mock-only — never claude-code)${NC}"
say "${CYAN}VIBE_DIR${NC}  $VIBE_DIR  ${DIM}(throwaway — real ~/.vibe untouched)${NC}"

DAEMON_PID=""
cleanup() {
  set +e
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null; sleep 1; kill -KILL "$DAEMON_PID" 2>/dev/null
  fi
  [ -n "$TMP_TOKEN_FILE" ] && rm -f "$TMP_TOKEN_FILE"
  rm -rf "$VIBE_DIR"
  # Verify no lingering daemon for this throwaway node-id.
  if pgrep -f "node daemon .*$NODE_ID" >/dev/null 2>&1; then
    say "${RED}! lingering daemon process for $NODE_ID — investigate${NC}"
  else
    say "${GREEN}✓ no lingering processes${NC}"
  fi
}
trap cleanup EXIT

# ── 4. Bring the node online (token via --token-file, never argv) ────────────
say "\n${DIM}starting node daemon…${NC}"
node "$CLI" node daemon --local --relay "$RELAY_URL" --token-file "$TOKEN_FILE" --node-id "$NODE_ID" \
  > "$VIBE_DIR/daemon.out" 2>&1 &
DAEMON_PID=$!

# Wait for registration via the secure path.
registered=0
for _ in $(seq 1 20); do
  sleep 1
  if node "$CLI" node list --remote --relay "$RELAY_URL" --token-file "$TOKEN_FILE" --json 2>/dev/null \
       | grep -q "\"$NODE_ID\""; then registered=1; break; fi
done
[ "$registered" = "1" ] || { say "${DIM}daemon output:${NC}"; sed -E 's/(token[^ ]*)[[:alnum:]_.-]+/\1[REDACTED]/Ig' "$VIBE_DIR/daemon.out"; fail "node did not register within 20s"; }
say "${GREEN}✓ 1. node registered and visible in \`node list --remote\`${NC}"

# ── 4b. Verify the node advertises EXACTLY ["mock"] (PR #23 mock-only valve) ──
# If this node ever advertised claude-code, an active production dispatcher could
# assign it a real paid job — so abort hard unless the advertised set is mock-only.
ADV_AGENTS="$(node "$CLI" node list --remote --relay "$RELAY_URL" --token-file "$TOKEN_FILE" --json 2>/dev/null \
  | node -pe 'const ns=JSON.parse(require("fs").readFileSync(0));const me=(ns||[]).find(n=>n.node_id===process.argv[1]);JSON.stringify(me?me.agents:null)' "$NODE_ID")"
[ "$ADV_AGENTS" = '["mock"]' ] || fail "node advertises ${ADV_AGENTS}, expected [\"mock\"] — aborting before any run"
say "${GREEN}✓ 1b. node advertises exactly ${ADV_AGENTS}  ${DIM}(mock-only valve confirmed)${NC}"

# ── 5. start ─────────────────────────────────────────────────────────────────
START_JSON="$(node "$CLI" run start --node "$NODE_ID" --agent mock --workspace-key "$WORKSPACE_KEY" \
  --relay "$RELAY_URL" --token-file "$TOKEN_FILE" --json)"
RUN_ID="$(printf '%s' "$START_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0)).run_id')"
[ -n "$RUN_ID" ] || fail "run start did not return a run_id"
say "${GREEN}✓ 2. remote mock run started${NC}  run_id=$RUN_ID"

# ── 6. stream (resolves on completed; capped) ────────────────────────────────
say "${DIM}streaming events until completed…${NC}"
STREAM_OUT="$(timeout 30 node "$CLI" run stream "$RUN_ID" --relay "$RELAY_URL" --token-file "$TOKEN_FILE" || true)"
printf '%s\n' "$STREAM_OUT" | grep -q '"type":"log"' && say "${GREEN}✓ 3. stream delivered mock log events${NC}" \
  || say "${YELLOW}! stream produced no log events (check above)${NC}"

# ── 7. status (node-authoritative record) ────────────────────────────────────
STATUS_JSON="$(node "$CLI" run status "$RUN_ID" --json)"
STATUS="$(printf '%s' "$STATUS_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')"
say "${GREEN}✓ 4. run status (from node record): ${STATUS}${NC}"

# ── 8. stop (idempotent on a finished run; exercises the stop path) ──────────
STOP_JSON="$(node "$CLI" run stop "$RUN_ID" --relay "$RELAY_URL" --token-file "$TOKEN_FILE" 2>/dev/null || true)"
say "${GREEN}✓ 5. stop path exercised${NC}  ${DIM}$(printf '%s' "$STOP_JSON" | head -c 120)${NC}"

# ── 8b. Stop the daemon, then verify the node goes offline/absent on the relay ─
# Cleanup must be observable from the relay's side, not just locally. Stop the
# daemon here (so it stops heartbeating) and poll `node list --remote` with the
# SAME --token-file until the relay reports this node absent, or present but
# offline/stale. We do this in the main flow — BEFORE the EXIT trap — so the temp
# token file is still alive for the poll (it is removed only on exit; req 6/7).
say "\n${DIM}stopping daemon; waiting for relay to drop/offline the node…${NC}"
if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
  kill -TERM "$DAEMON_PID" 2>/dev/null
  for _ in $(seq 1 10); do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 1; done
  kill -KILL "$DAEMON_PID" 2>/dev/null || true
fi
DAEMON_PID=""   # reaped here; keep the EXIT trap from re-killing a dead pid

# Default ≈6× the relay's 15s default stale window; override w/ SMOKE_OFFLINE_TIMEOUT_SEC.
OFFLINE_TIMEOUT="${SMOKE_OFFLINE_TIMEOUT_SEC:-90}"
POLL_OUT=""
node_state="online"
deadline=$(( $(date +%s) + OFFLINE_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  NODE_JSON="$(node "$CLI" node list --remote --relay "$RELAY_URL" --token-file "$TOKEN_FILE" --json 2>/dev/null || echo '[]')"
  POLL_OUT="$POLL_OUT$NODE_JSON"   # folded into the token-leak scan below
  node_state="$(printf '%s' "$NODE_JSON" | node -pe 'const ns=JSON.parse(require("fs").readFileSync(0))||[];const me=(ns||[]).find(n=>n.node_id===process.argv[1]);me?(me.status||"present"):"absent"' "$NODE_ID" 2>/dev/null || echo "unknown")"
  case "$node_state" in absent|offline|stale) break ;; esac
  sleep 3
done
case "$node_state" in
  absent|offline|stale)
    say "${GREEN}✓ 6. throwaway node is '${node_state}' on the relay after cleanup${NC}" ;;
  *)
    fail "cleanup verification failed: node $NODE_ID still '${node_state}' after ${OFFLINE_TIMEOUT}s" ;;
esac

# ── 9. token-leak check across everything this run printed ───────────────────
SECRET="$(tr -d '\n' < "$TOKEN_FILE")"
if printf '%s' "$START_JSON$STREAM_OUT$STATUS_JSON$STOP_JSON$POLL_OUT" | grep -qF "$SECRET"; then
  fail "token leaked into command output"
else
  say "${GREEN}✓ 7. token absent from all command output${NC}"
fi

say "\n${GREEN}real-relay smoke complete — start/status/stream/stop + offline-after-cleanup verified over $RELAY_URL (mock only).${NC}"
