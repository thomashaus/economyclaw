const express = require('express');
const fs = require('fs');
const path = require('path');
const { startWorker, addWorkerEndpoints } = require('../../services/worker');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8002;
const SERVICE_NAME = 'treasury';
const SECTOR = 'chamber';

const state = {
  started: new Date().toISOString(),
  maturity: 'observe',
  requests_handled: 0
};

// ── Health Check ──
app.get('/health', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    sector: SECTOR,
    status: 'healthy',
    uptime: process.uptime(),
    maturity: state.maturity,
    requests_handled: state.requests_handled,
    timestamp: new Date().toISOString()
  });
});

// ── Service Info ──
app.get('/info', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    sector: SECTOR,
    port: PORT,
    role: 'Token clearing, rate normalization, atomic budget enforcement',
    maturity: state.maturity,
    started: state.started
  });
});

// ── Worker Endpoints ──
addWorkerEndpoints(app, SERVICE_NAME);

// ── Work Package Handler ──
async function handleWork(workItem, tools) {
  const { capability, payload, description } = workItem;
  console.log(`[${SERVICE_NAME}] Handling work: ${capability} — ${description}`);

  const response = await tools.callLLM({
    system: `You are the Treasury service in the EconomyClaw Supply Economy. Your domain is token clearing, rate normalization, budget enforcement, and cost tracking for all LLM interactions across the economy.

You handle:
- Token clearing: recording every LLM call's token count and cost from OpenRouter
- Rate normalization: converting different model costs to a common unit for comparison
- Budget enforcement: atomic per-request and per-service budget limits
- Cost reporting: providing cost data to Governor for State of the State reports
- Budget alerts: flagging services approaching their budget ceilings
- Per Promise Theory P27, the Treasury promises transparency — every token spent is accounted for, every cost is traceable

Be specific and actionable. Produce concrete deliverables.`,
    prompt: `Work package assigned to you:
- Capability: ${capability}
- Description: ${description || 'No description'}
- Payload: ${JSON.stringify(payload || {}, null, 2)}

Analyze this work package. What concrete steps should Treasury take? What tracking, enforcement, or reporting will you produce? What do you need from other services?`,
    maxTokens: 1024
  });

  state.requests_handled++;

  if (payload?.work_package_id) {
    await tools.updateWorkPackageProgress(payload.work_package_id, {
      status: 'in_progress', progress_pct: 25, assigned_services: [SERVICE_NAME],
      notes: [`Initial assessment complete. Plan: ${response.content.substring(0, 200)}...`]
    });
  }

  return {
    assessment: response.content, model_used: response.model,
    tokens_used: response.tokens, cost: response.cost, produced_by: SERVICE_NAME
  };
}

// ─── Trading P&L Ledger ──────────────────────────────────────────────────────
// Treasury tracks trading revenue/loss as a sector-level income line.
// This lets the supply economy understand how the trading sector is performing
// and allocate resources (e.g., reduce LLM spend during drawdown periods).

const tradingLedger = [];  // append-only event log
let tradingBalance = {
  total_pnl: 0,
  open_positions: 0,
  realized_today: 0,
  last_reset: new Date().toISOString()
};

app.post('/trading/event', (req, res) => {
  const { event, order_id, symbol, direction, pnl, fill_price, exit_price, timestamp } = req.body;

  tradingLedger.push(req.body);
  if (tradingLedger.length > 1000) tradingLedger.splice(0, tradingLedger.length - 1000);

  if (event === 'trade_opened') {
    tradingBalance.open_positions++;
  } else if (event === 'trade_closed') {
    const p = parseFloat(pnl) || 0;
    tradingBalance.total_pnl = parseFloat((tradingBalance.total_pnl + p).toFixed(2));
    tradingBalance.realized_today = parseFloat((tradingBalance.realized_today + p).toFixed(2));
    tradingBalance.open_positions = Math.max(0, tradingBalance.open_positions - 1);
  }

  state.requests_handled++;
  console.log('[treasury] trading/' + event + ' ' + (symbol || '') + (pnl !== undefined ? ' P&L: $' + pnl : ''));
  res.json({ received: true, event });
});

app.get('/trading/pnl', (req, res) => {
  res.json({
    balance: tradingBalance,
    recent_ledger: tradingLedger.slice(-20),
    total_entries: tradingLedger.length
  });
});

// ── Self-register ──
async function selfRegister() {
  try {
    await fetch('http://localhost:8099/services/' + SERVICE_NAME + '/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online' })
    });
    console.log('[' + SERVICE_NAME + '] Registered with Service Registry');
  } catch (err) {
    console.log('[' + SERVICE_NAME + '] Registry not available yet — will retry');
  }
}

app.listen(PORT, () => {
  console.log('[' + SERVICE_NAME + '] Running on port ' + PORT + ' | Sector: ' + SECTOR);
  setTimeout(selfRegister, 2000);
  startWorker({ serviceName: SERVICE_NAME, port: PORT, handler: handleWork });
});
