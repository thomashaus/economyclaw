#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# EconomyClaw — Deploy Real Service Logic to EC-Prime
# Replaces stub index.js files for: Trust Scoring, IAM, Trade Desk
# Also deploys business-definition.json and config.json for each
# ═══════════════════════════════════════════════════════════════════════════
#
# USAGE (run on EC-Prime):
#   1. Copy this entire 04-Service-Code directory to EC-Prime
#   2. cd into the 04-Service-Code directory
#   3. chmod +x deploy-to-ec-prime.sh
#   4. ./deploy-to-ec-prime.sh
#
# WHAT IT DOES:
#   - Backs up existing stub files
#   - Copies new index.js, business-definition.json, config.json to each service dir
#   - Creates audit log files for the new services
#   - Restarts the affected services via PM2
#   - Runs health checks to verify deployment
# ═══════════════════════════════════════════════════════════════════════════

set -e

ECONOMY_DIR="$HOME/economy"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "═══════════════════════════════════════════════════════"
echo "  EconomyClaw — Service Deployment"
echo "  Timestamp: $TIMESTAMP"
echo "═══════════════════════════════════════════════════════"
echo ""

# Pre-flight checks
if [ ! -d "$ECONOMY_DIR" ]; then
  echo "ERROR: Economy directory not found at $ECONOMY_DIR"
  exit 1
fi

if ! command -v pm2 &> /dev/null; then
  echo "ERROR: PM2 not found. Is it installed?"
  exit 1
fi

# ─── Deploy Trust Scoring ───────────────────────────────────────────────────

echo "▶ Deploying Trust Scoring (port 8030)..."
TARGET="$ECONOMY_DIR/regulatory/trust-scoring"

if [ ! -d "$TARGET" ]; then
  echo "  ERROR: Target directory not found: $TARGET"
  exit 1
fi

# Backup existing files
if [ -f "$TARGET/index.js" ]; then
  cp "$TARGET/index.js" "$TARGET/index.js.stub-backup-$TIMESTAMP"
  echo "  ✓ Backed up existing index.js"
fi

# Copy new files
cp "$SCRIPT_DIR/trust-scoring/index.js" "$TARGET/index.js"
cp "$SCRIPT_DIR/trust-scoring/config.json" "$TARGET/config.json"
cp "$SCRIPT_DIR/trust-scoring/business-definition.json" "$TARGET/business-definition.json"
echo "  ✓ Deployed index.js, config.json, business-definition.json"

# ─── Deploy IAM ─────────────────────────────────────────────────────────────

echo "▶ Deploying IAM (port 8020)..."
TARGET="$ECONOMY_DIR/utilities/iam"

if [ ! -d "$TARGET" ]; then
  echo "  ERROR: Target directory not found: $TARGET"
  exit 1
fi

if [ -f "$TARGET/index.js" ]; then
  cp "$TARGET/index.js" "$TARGET/index.js.stub-backup-$TIMESTAMP"
  echo "  ✓ Backed up existing index.js"
fi

cp "$SCRIPT_DIR/iam/index.js" "$TARGET/index.js"
cp "$SCRIPT_DIR/iam/config.json" "$TARGET/config.json"
cp "$SCRIPT_DIR/iam/business-definition.json" "$TARGET/business-definition.json"
echo "  ✓ Deployed index.js, config.json, business-definition.json"

# ─── Deploy Trade Desk ──────────────────────────────────────────────────────

echo "▶ Deploying Trade Desk (port 8003)..."
TARGET="$ECONOMY_DIR/chamber/trade-desk"

if [ ! -d "$TARGET" ]; then
  echo "  ERROR: Target directory not found: $TARGET"
  exit 1
fi

if [ -f "$TARGET/index.js" ]; then
  cp "$TARGET/index.js" "$TARGET/index.js.stub-backup-$TIMESTAMP"
  echo "  ✓ Backed up existing index.js"
fi

cp "$SCRIPT_DIR/trade-desk/index.js" "$TARGET/index.js"
cp "$SCRIPT_DIR/trade-desk/config.json" "$TARGET/config.json"
cp "$SCRIPT_DIR/trade-desk/business-definition.json" "$TARGET/business-definition.json"
echo "  ✓ Deployed index.js, config.json, business-definition.json"

# ─── Create Audit Log Files ────────────────────────────────────────────────

echo ""
echo "▶ Ensuring audit log files exist..."
AUDIT_DIR="$ECONOMY_DIR/services/audit"
mkdir -p "$AUDIT_DIR"
touch "$AUDIT_DIR/trust-scoring.log"
touch "$AUDIT_DIR/iam.log"
touch "$AUDIT_DIR/trade-desk.log"
echo "  ✓ Audit logs ready"

# ─── Restart Services via PM2 ──────────────────────────────────────────────

echo ""
echo "▶ Restarting services via PM2..."
pm2 restart trust-scoring 2>/dev/null && echo "  ✓ trust-scoring restarted" || echo "  ⚠ trust-scoring not in PM2 (will start with ecosystem)"
pm2 restart iam 2>/dev/null && echo "  ✓ iam restarted" || echo "  ⚠ iam not in PM2 (will start with ecosystem)"
pm2 restart trade-desk 2>/dev/null && echo "  ✓ trade-desk restarted" || echo "  ⚠ trade-desk not in PM2 (will start with ecosystem)"

# Wait for services to initialize
echo ""
echo "▶ Waiting 5 seconds for services to start..."
sleep 5

# ─── Health Checks ──────────────────────────────────────────────────────────

echo ""
echo "▶ Running health checks..."
echo ""

check_health() {
  local name=$1
  local port=$2
  local response

  response=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port/health" 2>/dev/null)

  if [ "$response" = "200" ]; then
    echo "  ✅ $name (port $port): HEALTHY"
    # Show the actual health response
    curl -s "http://localhost:$port/health" 2>/dev/null | python3 -m json.tool 2>/dev/null | head -10 | sed 's/^/     /'
  else
    echo "  ❌ $name (port $port): HTTP $response"
  fi
  echo ""
}

check_health "Trust Scoring" 8030
check_health "IAM" 8020
check_health "Trade Desk" 8003

# ─── Verify Integration ────────────────────────────────────────────────────

echo "▶ Quick integration test..."
echo ""

# Test: IAM token issuance
echo "  Testing IAM token issuance..."
TOKEN_RESULT=$(curl -s -X POST http://localhost:8020/token/issue \
  -H "Content-Type: application/json" \
  -d '{"service": "test-deploy", "port": 9999}' 2>/dev/null)

if echo "$TOKEN_RESULT" | grep -q '"token"'; then
  echo "  ✅ IAM token issuance: working"
else
  echo "  ⚠ IAM token issuance: check manually"
fi

# Test: Trust Scoring summary
echo "  Testing Trust Scoring summary..."
SUMMARY_RESULT=$(curl -s http://localhost:8030/summary 2>/dev/null)

if echo "$SUMMARY_RESULT" | grep -q '"economy_average"'; then
  echo "  ✅ Trust Scoring summary: working"
else
  echo "  ⚠ Trust Scoring summary: check manually"
fi

# Test: Trade Desk capabilities
echo "  Testing Trade Desk info..."
TD_RESULT=$(curl -s http://localhost:8003/info 2>/dev/null)

if echo "$TD_RESULT" | grep -q '"capabilities_routable"'; then
  echo "  ✅ Trade Desk info: working"
else
  echo "  ⚠ Trade Desk info: check manually"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Deployment complete!"
echo ""
echo "  Next steps:"
echo "  1. Run 'pm2 save' to persist the new process list"
echo "  2. Test Governor's State of the State — it should now"
echo "     get real trust scores from Trust Scoring"
echo "  3. Try a Trade Desk work request:"
echo "     curl -X POST http://localhost:8003/request \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"capability\":\"trust_assessment\",\"requester\":\"governor\"}'"
echo "═══════════════════════════════════════════════════════"
