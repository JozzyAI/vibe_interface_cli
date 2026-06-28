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
#  * DEDICATED REUSABLE IDENTITY. The relay runs with `--require-pairing`, which
#    rejects any node whose key-derived identity it has not paired. A throwaway
#    identity per run can therefore never register. This script instead uses one
#    persistent, dedicated smoke identity under its own VIBE_DIR
#    (default ~/.config/vibe/smoke-node, NEVER the real ~/.vibe). Its node_id is
#    the identity's own key-derived id (a node_<hash>) — it MUST be, because the
#    relay looks pairings up by node_id == identity.id. The friendly label
#    "smoke-wsl-lijoe" is carried as the display name (VIBE_NODE_DISPLAY_NAME).
#  * PAIR ONCE (operator step — this script never pairs). Before the first run,
#    pair the smoke identity with the relay ONCE (writes the relay's pairing
#    store). The identity is reused and stays paired thereafter:
#        VIBE_DIR=~/.config/vibe/smoke-node \
#          node dist/src/index.js node pair --relay "$RELAY_URL" --token-file <file>
#    If registration below fails as unpaired, the script prints this exact command.
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
#   # optional overrides:
#   SMOKE_VIBE_DIR=/path/to/smoke-node   # dedicated identity dir (default ~/.config/vibe/smoke-node)
#   SMOKE_DISPLAY_NAME=smoke-wsl-lijoe   # friendly label shown in `node list`
#   SMOKE_OFFLINE_TIMEOUT_SEC=120        # wait for relay to mark node offline/absent (default 90s)
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
say()  { printf "%b\n" "$1"; }
fail() { printf "%b\n" "${RED}✗ $1${NC}" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/dist/src/index.js"
[ -f "$CLI" ] || fail "CLI not built: $CLI (run: npm run build && chmod +x dist/src/index.js)"

RELAY_URL="${RELAY_URL:-wss://vibe-relay.dynastylab.ai}"
WORKSPACE_KEY="real-relay-smoke-$$"
SMOKE_VIBE_DIR="${SMOKE_VIBE_DIR:-$HOME/.config/vibe/smoke-node}"  # dedicated, reused, paired identity
SMOKE_DISPLAY_NAME="${SMOKE_DISPLAY_NAME:-smoke-wsl-lijoe}"        # friendly label in `node list`

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

# ── 3. Dedicated, reusable, paired identity (NOT throwaway) ───────────────────
# A persistent VIBE_DIR holds one stable identity.json (created 0600 on first run).
# Its key-derived id is the node_id we register and pair — reused across runs so a
# `--require-pairing` relay accepts it. This dir is separate from the real ~/.vibe.
mkdir -p "$SMOKE_VIBE_DIR"; chmod 700 "$SMOKE_VIBE_DIR" 2>/dev/null || true
VIBE_DIR="$SMOKE_VIBE_DIR"
export VIBE_DIR
# Friendly display name (bites only on first-ever identity creation; persisted after).
export VIBE_NODE_DISPLAY_NAME="$SMOKE_DISPLAY_NAME"
# Mock-only advertise valve (PR #23): the daemon publishes EXACTLY ["mock"] to the
# relay, so no real claude-code job can ever be dispatched to this node.
export VIBE_NODE_ADVERTISE_AGENTS=mock

# Derive the node_id from the identity — purely local (ensureIdentity, create-if-
# missing, 0600). No relay contact. The daemon registers as this same identity.id,
# so we DO NOT pass --node-id (an arbitrary id could never match the relay pairing,
# which is keyed by identity.id).
NODE_ID="$(node "$CLI" node identity --json 2>/dev/null \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')"
[ -n "$NODE_ID" ] || fail "could not derive node identity id from $VIBE_DIR"

say "${CYAN}relay${NC}     $RELAY_URL"
say "${CYAN}node-id${NC}   $NODE_ID  ${DIM}(stable identity.id — paired once)${NC}"
say "${CYAN}name${NC}      $SMOKE_DISPLAY_NAME  ${DIM}(display label)${NC}"
say "${CYAN}advertise${NC} $VIBE_NODE_ADVERTISE_AGENTS  ${DIM}(mock-only — never claude-code)${NC}"
say "${CYAN}VIBE_DIR${NC}  $VIBE_DIR  ${DIM}(dedicated — identity reused, real ~/.vibe untouched)${NC}"

DAEMON_PID=""
cleanup() {
  set +e
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null; sleep 1; kill -KILL "$DAEMON_PID" 2>/dev/null
  fi
  [ -n "$TMP_TOKEN_FILE" ] && rm -f "$TMP_TOKEN_FILE"
  # Prune ONLY transient run state. Preserve identity.json + paired_relays.json so
  # the dedicated identity (and its relay pairing) is reused on the next run; never
  # rm -rf the whole VIBE_DIR (that would drop the pairing and re-break registration).
  rm -rf "$VIBE_DIR/events" "$VIBE_DIR/runs" "$VIBE_DIR/handoff"
  # Verify no lingering daemon for this node-id.
  if pgrep -f "node daemon .*$NODE_ID" >/dev/null 2>&1; then
    say "${RED}! lingering daemon process for $NODE_ID — investigate${NC}"
  else
    say "${GREEN}✓ no lingering processes${NC}"
  fi
}
trap cleanup EXIT

# ── 4. Bring the node online (token via --token-file, never argv) ────────────
say "\n${DIM}starting node daemon…${NC}"
# No --node-id: the daemon registers as its own identity.id (== $NODE_ID), which is
# the only id the --require-pairing relay can match against its pairing store.
node "$CLI" node daemon --local --relay "$RELAY_URL" --token-file "$TOKEN_FILE" \
  > "$VIBE_DIR/daemon.out" 2>&1 &
DAEMON_PID=$!

# Wait for registration via the secure path.
registered=0
for _ in $(seq 1 20); do
  sleep 1
  if node "$CLI" node list --remote --relay "$RELAY_URL" --token-file "$TOKEN_FILE" --json 2>/dev/null \
       | grep -q "\"$NODE_ID\""; then registered=1; break; fi
done
if [ "$registered" != "1" ]; then
  say "${DIM}daemon output (token redacted):${NC}"
  sed -E 's/(token[^ ]*)[[:alnum:]_.-]+/\1[REDACTED]/Ig' "$VIBE_DIR/daemon.out" >&2
  # If the relay rejected registration for pairing, print the exact one-time step.
  if grep -qiE 'pair|"ok":false|require-pairing|unpaired' "$VIBE_DIR/daemon.out" 2>/dev/null; then
    say "\n${YELLOW}This smoke identity is not paired with $RELAY_URL.${NC}"
    say "Pair it ONCE (writes the relay's pairing store; this script never pairs):"
    say "    ${DIM}VIBE_DIR=$VIBE_DIR node $CLI node pair --relay $RELAY_URL --token-file <0600-token-file>${NC}"
    say "Then re-run this smoke — the identity (node_id=$NODE_ID) is reused and stays paired."
  fi
  fail "node did not register within 20s"
fi
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
    say "${GREEN}✓ 6. smoke node is '${node_state}' on the relay after cleanup${NC}" ;;
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
