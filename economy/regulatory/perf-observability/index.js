const express = require('express');
const fs = require('fs');
const path = require('path');
const { startWorker, addWorkerEndpoints } = require('../../services/worker');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8032;
const SERVICE_NAME = 'perf-observability';
const SECTOR = 'regulatory';

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
    role: 'Performance monitoring, health dashboards, alerting',
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
    system: `You are the Performance & Observability service in the EconomyClaw Supply Economy. Your domain is monitoring, metrics, health dashboards, alerting, and SLA tracking across all economy services.

You handle:
- Performance monitoring: response times, throughput, error rates for all services
- Health dashboards: aggregating /health endpoints into a unified view
- Alerting: detecting anomalies, degradation, and SLA breaches
- Capacity planning: tracking resource usage on the Mac Mini M4 (EC-Prime)
- Cost observability: tracking LLM token spend across services via Treasury data
- Per Promise Theory P42, you observe promises kept vs. broken — you never punish, you report to Trust Scoring with evidence

You are the economy's eyes and ears. Be specific and actionable.`,
    prompt: `Work package assigned to you:
- Capability: ${capability}
- Description: ${description || 'No description'}
- Payload: ${JSON.stringify(payload || {}, null, 2)}

Analyze this work package. What monitoring, dashboards, or alerts should be implemented? What metrics matter? What do you need from other services?`,
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

// ─── Trading Telemetry ───────────────────────────────────────────────────────
// Receives trade events from trade-execution. Tracks live trading performance
// metrics so the supply economy has observability into the trading sector.

const tradingEvents = [];  // rolling log — last 500 events
let tradingStats = {
  total_trades_opened: 0,
  total_trades_closed: 0,
  total_pnl: 0,
  wins: 0,
  losses: 0,
  gross_wins: 0,
  gross_losses: 0,
  last_updated: null
};

app.post('/trading/event', (req, res) => {
  const { event, order_id, symbol, direction, pnl, close_reason, timestamp } = req.body;

  tradingEvents.push(req.body);
  if (tradingEvents.length > 500) tradingEvents.splice(0, tradingEvents.length - 500);

  if (event === 'trade_opened') {
    tradingStats.total_trades_opened++;
  } else if (event === 'trade_closed') {
    tradingStats.total_trades_closed++;
    const p = parseFloat(pnl) || 0;
    tradingStats.total_pnl = parseFloat((tradingStats.total_pnl + p).toFixed(2));
    if (p > 0) { tradingStats.wins++; tradingStats.gross_wins += p; }
    else        { tradingStats.losses++; tradingStats.gross_losses += Math.abs(p); }
    tradingStats.last_updated = timestamp || new Date().toISOString();
  }

  state.requests_handled++;
  console.log('[perf-observability] trading/' + event + ' ' + (symbol || '') + ' ' +
    (direction || '') + (pnl !== undefined ? ' P&L: $' + pnl : ''));
  res.json({ received: true, event });
});

app.get('/trading/stats', (req, res) => {
  const winRate = tradingStats.wins + tradingStats.losses > 0
    ? parseFloat((tradingStats.wins / (tradingStats.wins + tradingStats.losses) * 100).toFixed(1))
    : null;
  const profitFactor = tradingStats.gross_losses > 0
    ? parseFloat((tradingStats.gross_wins / tradingStats.gross_losses).toFixed(2))
    : null;

  res.json({
    stats: { ...tradingStats, win_rate_pct: winRate, profit_factor: profitFactor },
    recent_events: tradingEvents.slice(-20)
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
