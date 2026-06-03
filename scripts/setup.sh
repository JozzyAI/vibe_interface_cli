#!/usr/bin/env bash
# Vibe Node Setup
# Run from the vibe-interface-cli repo root:
#   bash scripts/setup.sh

set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

CONFIG_DIR="$HOME/.config/vibe-symphony"
CONFIG_FILE="$CONFIG_DIR/env"
VIBE_DIR="$HOME/.vibe"
IDENTITY_FILE="$VIBE_DIR/identity.json"

print_step() { echo -e "\n${BOLD}$1${NC}"; }
ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
fail() { echo -e "\n  ${RED}✗${NC}  $1\n"; exit 1; }

prompt_plain() {
  local -n _ref=$1
  local label="$2" default="${3:-}"
  if [[ -n "$default" ]]; then
    echo -ne "  ${CYAN}?${NC} $label [${DIM}$default${NC}]: "
  else
    echo -ne "  ${CYAN}?${NC} $label: "
  fi
  read -r _ref
  [[ -z "$_ref" && -n "$default" ]] && _ref="$default"
}

prompt_secret() {
  local -n _ref=$1
  local label="$2" has_existing="${3:-false}"
  if [[ "$has_existing" == "true" ]]; then
    echo -ne "  ${CYAN}?${NC} $label [${DIM}already set — press Enter to keep${NC}]: "
  else
    echo -ne "  ${CYAN}?${NC} $label: "
  fi
  read -rs _ref; echo
}

# ── Header ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Vibe Node Setup${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ── Step 1: Install vibe CLI ───────────────────────────────────────────────
print_step "1/5  Install vibe CLI"

if command -v vibe &>/dev/null; then
  VIBE_VER=$(vibe --version 2>/dev/null || echo "?")
  ok "vibe already installed  (v$VIBE_VER)"
else
  [[ ! -f "package.json" ]] && fail "Run this script from the vibe-interface-cli repo root."
  echo "  Building and linking from repo..."
  npm install --silent
  npm run build --silent
  npm link --silent
  ok "vibe installed  (v$(vibe --version))"
fi

# ── Step 2: Collect config ────────────────────────────────────────────────
print_step "2/5  Configuration"

# Load existing values so we can use them as defaults
_existing_relay="" _existing_token="" _existing_linear=""
if [[ -f "$CONFIG_FILE" ]]; then
  _existing_relay=$(grep  'VIBE_RELAY_URL='  "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  _existing_token=$(grep  'VIBE_RELAY_TOKEN=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  _existing_linear=$(grep 'LINEAR_API_KEY='  "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  warn "Found existing config at $CONFIG_FILE"
fi

RELAY_URL="" RELAY_TOKEN="" LINEAR_KEY=""

prompt_plain  RELAY_URL   "Relay WebSocket URL" "${_existing_relay:-wss://vibe-relay.dynastylab.ai}"
[[ -z "$RELAY_URL" ]] && fail "Relay URL is required."

prompt_secret RELAY_TOKEN "Relay token" "$([[ -n "$_existing_token" ]] && echo true || echo false)"
if [[ -z "$RELAY_TOKEN" ]]; then
  [[ -n "$_existing_token" ]] && RELAY_TOKEN="$_existing_token" || fail "Relay token is required."
fi

prompt_secret LINEAR_KEY  "Linear API key (optional — Enter to skip)" "$([[ -n "$_existing_linear" ]] && echo true || echo false)"
if [[ -z "$LINEAR_KEY" && -n "$_existing_linear" ]]; then
  LINEAR_KEY="$_existing_linear"
fi

# ── Step 3: Save config ───────────────────────────────────────────────────
print_step "3/5  Saving config"

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
{
  echo "export VIBE_RELAY_URL=$RELAY_URL"
  echo "export VIBE_RELAY_TOKEN=$RELAY_TOKEN"
  [[ -n "$LINEAR_KEY" ]] && echo "export LINEAR_API_KEY=$LINEAR_KEY"
} > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
ok "Saved to $CONFIG_FILE"

# ── Step 4: Identity + pairing ────────────────────────────────────────────
print_step "4/5  Node identity + relay pairing"

mkdir -p "$VIBE_DIR"

if [[ -f "$IDENTITY_FILE" ]]; then
  if command -v jq &>/dev/null; then
    NODE_ID=$(jq -r '.id' "$IDENTITY_FILE")
  else
    NODE_ID=$(grep -o '"id":"[^"]*"' "$IDENTITY_FILE" | cut -d'"' -f4)
  fi
  ok "Identity exists  (node_id=$NODE_ID)"
else
  echo "  Creating identity..."
  IDENTITY_JSON=$(vibe node identity 2>/dev/null)
  if command -v jq &>/dev/null; then
    NODE_ID=$(echo "$IDENTITY_JSON" | jq -r '.id')
  else
    NODE_ID=$(echo "$IDENTITY_JSON" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
  fi
  ok "Created identity  (node_id=$NODE_ID)"
fi

echo "  Pairing with relay..."
PAIR_OUT=$(vibe node pair --relay "$RELAY_URL" --token "$RELAY_TOKEN" 2>&1) || \
  fail "Pairing failed:\n$PAIR_OUT"
ok "Paired with relay"

# ── Step 5: Daemon ────────────────────────────────────────────────────────
print_step "5/5  Node daemon"

echo ""
echo -e "  Node ID:  ${BOLD}$NODE_ID${NC}"
echo -e "  Relay:    $RELAY_URL"
echo ""
echo -ne "  Start daemon now in background? [Y/n]: "
read -r START_NOW
START_NOW="${START_NOW:-y}"

if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
  LOG_FILE="$VIBE_DIR/daemon.log"

  # Kill any existing daemon for this relay
  pkill -f "vibe node daemon" 2>/dev/null || true

  nohup vibe node daemon --local \
    --relay "$RELAY_URL" \
    --token "$RELAY_TOKEN" \
    >> "$LOG_FILE" 2>&1 &
  DAEMON_PID=$!

  sleep 1
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    # Check for rejection in log
    if grep -q "registration REJECTED\|REJECTED" "$LOG_FILE" 2>/dev/null; then
      warn "Daemon started but registration was rejected — check $LOG_FILE"
    elif grep -q "registered ✓" "$LOG_FILE" 2>/dev/null; then
      ok "Daemon running  (PID $DAEMON_PID)  —  registered ✓"
    else
      ok "Daemon running  (PID $DAEMON_PID)  —  logs at $LOG_FILE"
    fi
  else
    warn "Daemon exited immediately — check $LOG_FILE"
    tail -5 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
  fi
else
  echo ""
  echo "  Run manually:"
  echo -e "  ${DIM}source $CONFIG_FILE${NC}"
  echo -e "  ${DIM}vibe node daemon --local --relay \$VIBE_RELAY_URL --token \$VIBE_RELAY_TOKEN${NC}"
fi

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Setup complete${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Verify connection:"
echo -e "  ${DIM}vibe node list --remote --relay \$VIBE_RELAY_URL --token \$VIBE_RELAY_TOKEN${NC}"
echo ""
echo "  Your node_id for WORKFLOW.md:"
echo -e "  ${BOLD}$NODE_ID${NC}"
echo ""
