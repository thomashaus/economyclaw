# Monday Morning Trading Runbook
**EconomyClaw — TopstepX Live Trading Activation**
*Last updated: 2026-03-27*

---

## Pre-Market Checklist (Complete Before 8:00 AM CT)

### 1. Pull Latest Code to EC-Prime
```bash
ssh ec-prime
cd ~/OpenClaw
git pull
pm2 restart trade-execution treasury perf-observability
pm2 status
```
All 17 services must show `online`. If any show `errored`, check `pm2 logs <service> --lines 20`.

---

### 2. Wire ProjectX Credentials (One-Time — Do This Sunday Night or First Thing Monday)

Get your API key from the TopstepX dashboard, then:

```bash
# Step 1: Configure credentials in the running trade-execution service
curl -s -X POST http://192.168.68.76:8114/configure-projectx \
  -H "Content-Type: application/json" \
  -d '{ "firm": "topstepx", "api_key": "YOUR_API_KEY_HERE", "username": "YOUR_TOPSTEP_USERNAME" }'

# Step 2: Flip adapter from simulated → live
curl -s -X POST http://192.168.68.76:8114/adapter \
  -H "Content-Type: application/json" \
  -d '{ "adapter": "projectx" }'

# Confirm adapter is live
curl -s http://192.168.68.76:8114/health | python3 -m json.tool
# Should show: "adapter": "projectx"
```

> **Note:** Credentials are in-process only (not written to disk). If trade-execution restarts, you must re-run `configure-projectx`. To persist credentials, set the env var `TOPSTEPX_API_KEY` on EC-Prime and update the startup script.

---

### 3. Confirm All Trading Services Are Healthy
```bash
for port in 8110 8111 8112 8113 8114; do
  echo "Port $port:" && curl -s http://192.168.68.76:$port/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('  status:', d.get('status'), '| adapter:', d.get('adapter','N/A'))"
done
```

Expected output:
- 8110 market-data: `status: healthy`
- 8111 heatseeker: `status: healthy`
- 8112 risk-management: `status: healthy`
- 8113 trade-approval: `status: healthy`
- 8114 trade-execution: `status: healthy | adapter: projectx`

---

### 4. Check Risk Management State Is Clean
```bash
curl -s http://192.168.68.76:8112/state | python3 -m json.tool
```
Verify: `daily_pnl: 0`, `open_positions: []`, `cooldown_until: null`

If daily P&L shows non-zero from a previous session, reset it:
```bash
curl -s -X POST http://192.168.68.76:8112/reset-daily \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

### 5. Open Heatseeker and Load Today's Map
1. Open Heatseeker in your browser
2. Navigate to the Heatseeker skill (or the `heatseeker-map-review` Cowork skill) for map analysis
3. Note the key levels: major GEX walls, Vol Trigger, largest positive/negative nodes

---

### 6. Submit Heatseeker Analysis to the Pipeline
After reviewing the map, POST your analysis:
```bash
curl -s -X POST http://192.168.68.76:8111/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "ticker": "SPX",
    "gex_sign": "+",
    "vex_sign": "+",
    "net_gex": 2.1,
    "net_vex": 0.8,
    "vol_trigger": 5850,
    "major_positive_nodes": [5900, 5925],
    "major_negative_nodes": [5800],
    "call_wall": 5900,
    "put_wall": 5800,
    "vix_level": 18.5,
    "vix_direction": "falling",
    "notes": "Positive GEX regime. Pinning likely near 5900 call wall."
  }'
```

This gives you the Heatseeker signal to trade against.

---

## Trade Submission (Semi-Auto Mode)

### Step 1 — Identify the Setup
Per Heatseeker sweep-and-reclaim methodology:
- **Long (stop_buy)**: Price sweeps below a positive GEX node, then reclaims it → place stop_buy ABOVE the sweep level
- **Short (stop_sell)**: Price sweeps above a negative node or call wall, then rejects → place stop_sell BELOW the sweep level
- **Fade (limit)**: Price approaches a large positive GEX wall with full King alignment → limit entry at the wall

### Step 2 — Submit the Trade Proposal
```bash
curl -s -X POST http://192.168.68.76:8113/submit \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "MES",
    "direction": "long",
    "contracts": 1,
    "entry_price": 5853.50,
    "stop_price": 5851.50,
    "target_price": 5859.50,
    "order_type": "stop_buy",
    "setup_notes": "Sweep below 5852 positive node, reclaiming. VIX falling, dual+ alignment.",
    "signal_source": "heatseeker",
    "map_grade": "A+"
  }'
```

Save the `id` from the response — you need it to approve.

### Step 3 — Review the Proposal
```bash
curl -s http://192.168.68.76:8113/queue
```
Check: A+ checklist score ≥ 4/5, risk check `approved: true`, no violations.

### Step 4 — Approve the Trade
```bash
curl -s -X POST http://192.168.68.76:8113/approve/TA-XXXXX \
  -H "Content-Type: application/json" \
  -d '{}'
```

The trade routes automatically to trade-execution → ProjectX → TopstepX.

### Step 5 — Confirm Execution
```bash
curl -s http://192.168.68.76:8114/orders/open
```
For a stop_buy: status will be `pending_trigger` until price hits your entry.
For a filled order: status will be `filled` with bracket orders working.

---

## During the Trade

### Check P&L
```bash
curl -s http://192.168.68.76:8112/state | python3 -c "import sys,json; d=json.load(sys.stdin); print('P&L: $' + str(d['daily_pnl']), '| Open:', len(d['open_positions']))"
```

### Check Trading Stats (Supply Economy)
```bash
curl -s http://192.168.68.76:8032/trading/stats | python3 -m json.tool
```

### Emergency Flatten (Kill Switch)
To manually close all open positions immediately:
```bash
# Get open order IDs
curl -s http://192.168.68.76:8114/orders/open | python3 -c "import sys,json; [print(o['id']) for o in json.load(sys.stdin)['orders']]"

# Close each one
curl -s -X POST http://192.168.68.76:8114/orders/ORD-XXXXX/close \
  -H "Content-Type: application/json" \
  -d '{ "reason": "kill_switch" }'
```

---

## Prop Firm Rules — Hard Limits (TopstepX 50K Combine)

| Rule | Limit | Hard Stop in System |
|------|-------|---------------------|
| Trailing Drawdown | $2,000 | $1,800 (100pt buffer) |
| Daily Loss Limit | $1,000 | $900 (auto-block) |
| Profit Target | $3,000 | N/A |
| Max Contracts (mini) | 3 ES | Validated on submit |
| Consistency Rule | No single day > 30% of total profit | Tracked in risk-management |
| Flatten By | 3:45 PM CT | Enforced by risk-management |
| News Blackout | ±2 min of high-impact events | Enforced by risk-management |

---

## End of Day

```bash
# Check final P&L
curl -s http://192.168.68.76:8112/state | python3 -m json.tool

# Check treasury ledger
curl -s http://192.168.68.76:8002/trading/pnl | python3 -m json.tool

# Confirm no open positions remain before 3:45 CT
curl -s http://192.168.68.76:8114/orders/open
```

Risk management auto-resets at midnight CT. No manual reset needed.

---

## v2 Onboarding Queue (Later This Week)

Once TopstepX live trading is confirmed working:

1. **TFD 100K** — `POST /configure-projectx { firm: "tfd_100k", api_key: "...", username: "..." }`
2. **FuturesElite 100K** — Same. Note: scalping DISABLED — verify min hold time first.
3. **Bulenox 100K** — Same. Note: scaling tiers (3→5→8→12 contracts based on daily profit).
4. **DayTraders 150K** — DO NOT activate until automation policy confirmed in writing.
   - Message to send: *"I run a proprietary algo via ProjectX API. Is fully automated trading permitted on S2F accounts?"*

Multi-account fan-out (one signal → all firms) can be enabled via `multi_account.enabled: true` in config when ready.

---

*For architecture decisions and change log: see `01-Conceptual-Architecture/decisions/decision-tracker.md`*
