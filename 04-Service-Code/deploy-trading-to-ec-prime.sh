#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# EconomyClaw — Deploy Trading Services to EC-Prime
# Deploys: market-data, heatseeker, risk-management, trade-approval, trade-execution
# ═══════════════════════════════════════════════════════════════════════════
#
# USAGE (run on EC-Prime):
#   1. git pull origin main  (from ~/economy or wherever repo is cloned)
#   2. cd into the 04-Service-Code directory
#   3. chmod +x deploy-trading-to-ec-prime.sh
#   4. ./deploy-trading-to-ec-prime.sh
#
# WHAT IT DOES:
#   - Creates trading service directories under ~/economy/trading/
#   - Copies index.js and config.json for each trading service
#   - Adds trading services to PM2 ecosystem
#   - Runs health checks to verify deployment
# ═══════════════════════════════════════════════════════════════════════════

set -e

ECONOMY_DIR="$HOME/economy"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "═══════════════════════════════════════════════════════"
echo "  EconomyClaw — Trading Services Deployment"
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

# ─── Create Trading Directory Structure ────────────────────────────────────

echo "▶ Creating trading service directories..."
TRADING_DIR="$ECONOMY_DIR/trading"
mkdir -p "$TRADING_DIR/market-data"
mkdir -p "$TRADING_DIR/heatseeker"
mkdir -p "$TRADING_DIR/risk-management"
mkdir -p "$TRADING_DIR/trade-approval"
mkdir -p "$TRADING_DIR/trade-execution"
echo "  ✓ Trading directories created at $TRADING_DIR"

# ─── Deploy Market Data ────────────────────────────────────────────────────

echo ""
echo "▶ Deploying Market Data (port 8110)..."
TARGET="$TRADING_DIR/market-data"

if [ -f "$TARGET/index.js" ]; then
  cp "$TARGET/index.js" "$TARGET/index.js.backup-$TIMESTAMP"
  echo "  ✓ Backed up existing index.js"
fi

cp "$SCRIPT_DIR/market-data/index.js" "$TARGET/index.js"
cp "$SCRIPT_DIR/market-data/config.json" "$TARGET/config.json"
echo "  ✓ Deployed index.js, config.json"

# ─── Deploy Heatseeker ────────────────────────────────────────────────────

echo "▶ Deploying Heatseeker (port 8111)..."
TARGET="$TRADING_DIR/heatseeker"

if [ -f "$TARGET/index.js" ]; then
  cp "$TARGET/index.js" "$TARGET/index.js.backup-$TIMESTAMP"
  echo "  ✓ Backed up existing index.js"
fi

cp "$SCRIPT_DIR/heatseeker/index.js" "$TARGET/index.js"
cp "$SCRIPT_DIR/heatseeker/config.json" "$TARGET/config.json"
echo "  ✓ Deployed index.js, config.json"

# ─── Deploy Risk Management ───────────────────────────────────────────────

echo "▶ Deploying Risk Management (port 8112)..."
TARGET="$TRADING_DIR/risk-management"

if [ -f "$TARGET/index.js" ]; then
  cp "$TARGET/index.js" "$TARGET/index.js.backup-$TIMESTAMP"
  echo "  ✓ Backed up existing index.js"
fi

cp "$SCRIPT_DIR/risk-management/index.js" "$TARGET/index.js"
cp "$SCRIPT_DIR/risk-management/config.json" "$TARGET/config.json"
echo "  ✓ Deployed index.js, config.json"

# ─── Deploy Trade Approval ────────────────────────────────────────────────

echo "▶ Deploying Trade Approval (port 8113)..."
TARGET="$TRADING_DIR/trade-approval"

if [ -f "$TARGET/index.js" ]; then
  cp "$TARGET/index.js" "$TARGET/index.js.backup-$TIMESTAMP"
  echo "  ✓ Backed up existing index.js"
fi

cp "$SCRIPT_DIR/trade-approval/index.js" "$TARGET/index.js"
cp "$SCRIPT_DIR/trade-approval/config.json" "$TARGET/config.json"
echo "  ✓ Deployed index.js, config.json"

# ─── Deploy Trade Execution ───────────────────────────────────────────────

echo "▶ Deploying Trade Execution (port 8114)..."
TARGET="$TRADING_DIR/trade-execution"

if [ -f "$TARGET/index.js" ]; then
  cp "$TARGET/index.js" "$TARGET/index.js.backup-$TIMESTAMP"
  echo "  ✓ Backed up existing index.js"
fi

cp "$SCRIPT_DIR/trade-execution/index.js" "$TARGET/index.js"
cp "$SCRIPT_DIR/trade-execution/config.json" "$TARGET/config.json"
echo "  ✓ Deployed index.js, config.json"

# ─── Update PM2 Ecosystem ────────────────────────────────────────────────

echo ""
echo "▶ Adding trading services to PM2..."

# Start each trading service (or restart if already exists)
SERVICES=("market-data:8110" "heatseeker:8111" "risk-management:8112" "trade-approval:8113" "trade-execution:8114")

for entry in "${SERVICES[@]}"; do
  IFS=':' read -r svc port <<< "$entry"

  # Check if already in PM2
  if pm2 describe "$svc" > /dev/null 2>&1; then
    pm2 restart "$svc" 2>/dev/null && echo "  ✓ $svc restarted" || echo "  ⚠ $svc restart failed"
  else
    pm2 start "$TRADING_DIR/$svc/index.js" \
      --name "$svc" \
      --cwd "$ECONOMY_DIR" \
      -e "$ECONOMY_DIR/services/logs/$svc-error.log" \
      -o "$ECONOMY_DIR/services/logs/$svc-out.log" \
      --merge-logs \
      --max-memory-restart 256M \
      -- --port "$port" \
      2>/dev/null && echo "  ✓ $svc started (port $port)" || echo "  ⚠ $svc start failed"
  fi
done

# Ensure log directory exists
mkdir -p "$ECONOMY_DIR/services/logs"

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
    curl -s "http://localhost:$port/health" 2>/dev/null | python3 -m json.tool 2>/dev/null | head -8 | sed 's/^/     /'
  else
    echo "  ❌ $name (port $port): HTTP $response"
  fi
  echo ""
}

check_health "Market Data" 8110
check_health "Heatseeker" 8111
check_health "Risk Management" 8112
check_health "Trade Approval" 8113
check_health "Trade Execution" 8114

# ─── Quick Integration Test ──────────────────────────────────────────────

echo "▶ Quick integration tests..."
echo ""

# Test: Market Data prices
echo "  Testing Market Data prices..."
PRICES=$(curl -s http://localhost:8110/prices 2>/dev/null)
if echo "$PRICES" | grep -q '"prices"'; then
  echo "  ✅ Market Data prices: working"
else
  echo "  ⚠ Market Data prices: check manually"
fi

# Test: Risk Management status
echo "  Testing Risk Management status..."
RISK=$(curl -s http://localhost:8112/status 2>/dev/null)
if echo "$RISK" | grep -q '"topstep_stage"'; then
  echo "  ✅ Risk Management status: working"
else
  echo "  ⚠ Risk Management status: check manually"
fi

# Test: Trade Approval queue
echo "  Testing Trade Approval queue..."
QUEUE=$(curl -s http://localhost:8113/queue 2>/dev/null)
if echo "$QUEUE" | grep -q '"queue"'; then
  echo "  ✅ Trade Approval queue: working"
else
  echo "  ⚠ Trade Approval queue: check manually"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Trading Services Deployment Complete!"
echo ""
echo "  Services deployed:"
echo "    • Market Data     — port 8110 (simulated data)"
echo "    • Heatseeker      — port 8111 (GEX/VEX + TA)"
echo "    • Risk Management — port 8112 (Topstep: combine)"
echo "    • Trade Approval  — port 8113 (semi-auto mode)"
echo "    • Trade Execution — port 8114 (simulated adapter)"
echo ""
echo "  Next steps:"
echo "  1. Run 'pm2 save' to persist the process list"
echo "  2. Verify all 17 services: pm2 status"
echo "  3. Test the full signal flow:"
echo "     # Submit a Heatseeker analysis:"
echo "     curl -X POST http://localhost:8111/analyze \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"symbol\":\"ES\",\"map_grade\":\"A+\",\"direction\":\"long\", \\"
echo "            \"entry_price\":5850,\"target_price\":5880,\"stop_price\":5840}'"
echo ""
echo "     # Check trade approval queue:"
echo "     curl http://localhost:8113/queue"
echo "═══════════════════════════════════════════════════════"
