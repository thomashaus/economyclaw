const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 8200;
const SERVICE_NAME = 'chief-of-staff';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Demand Registry ─────────────────────────────────────────────────────────
// Demand-side services (trading, and future outcomes) register here.
// This is the analog of economy/services/registry-server.js for the supply side.
// The supply economy registry (port 8099) should have NO knowledge of demand services.

let demandRegistry = {};  // { serviceName: { name, status, sector, outcome, port, last_seen } }

function now() {
  return new Date().toISOString();
}

// ─── Health & Info ────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const services = Object.values(demandRegistry);
  const online = services.filter(s => s.status === 'online').length;
  res.json({
    service: SERVICE_NAME,
    status: 'healthy',
    uptime: process.uptime(),
    demand_services_online: online,
    demand_services_total: services.length,
    timestamp: now()
  });
});

app.get('/info', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    port: PORT,
    role: config.role,
    outcomes: Object.entries(config.demand_outcomes).map(([key, val]) => ({
      id: key,
      label: val.label,
      status: val.status,
      service_count: val.services.length
    }))
  });
});

// ─── Demand Registry Endpoints ────────────────────────────────────────────────

// Demand services POST here to announce themselves (same contract as supply registry)
app.post('/services/:name/status', (req, res) => {
  const { name } = req.params;
  const { status, sector, port, outcome } = req.body;

  demandRegistry[name] = {
    name,
    status: status || 'online',
    sector: sector || 'unknown',
    outcome: outcome || inferOutcome(name),
    port: port || null,
    last_seen: now()
  };

  console.log(`[${SERVICE_NAME}] Registered: ${name} (${demandRegistry[name].outcome}) — ${demandRegistry[name].status}`);
  res.json({ registered: true, name, status: demandRegistry[name].status });
});

app.get('/services', (req, res) => {
  const services = Object.values(demandRegistry);
  const byOutcome = {};
  for (const svc of services) {
    if (!byOutcome[svc.outcome]) byOutcome[svc.outcome] = [];
    byOutcome[svc.outcome].push(svc);
  }
  res.json({
    services,
    by_outcome: byOutcome,
    online: services.filter(s => s.status === 'online').length,
    total: services.length,
    timestamp: now()
  });
});

function inferOutcome(serviceName) {
  const tradingServices = ['market-data', 'heatseeker', 'risk-management', 'trade-approval', 'trade-execution'];
  if (tradingServices.includes(serviceName)) return 'trading';
  return 'unknown';
}

// ─── Trading Summary ──────────────────────────────────────────────────────────
// Aggregates health from all 5 trading services + P&L from treasury + stats from perf-observability.
// This is what the CoS dashboard renders for the trading outcome.

app.get('/trading/summary', async (req, res) => {
  const tradingServices = config.demand_outcomes.trading.services;

  // Health check all trading services in parallel
  const healthResults = await Promise.allSettled(
    tradingServices.map(async svc => {
      const r = await fetch(`http://localhost:${svc.port}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return { name: svc.name, port: svc.port, ...(await r.json()) };
    })
  );

  const services = healthResults.map((result, i) => ({
    name: tradingServices[i].name,
    port: tradingServices[i].port,
    online: result.status === 'fulfilled',
    data: result.status === 'fulfilled' ? result.value : { error: result.reason?.message }
  }));

  // P&L ledger from treasury
  let pnl = null;
  try {
    const r = await fetch(`${config.supply_economy.treasury_url}/trading/pnl`, {
      signal: AbortSignal.timeout(2000)
    });
    const data = await r.json();
    pnl = data.balance || null;
  } catch (err) {
    pnl = { error: 'Treasury unavailable' };
  }

  // Performance stats from perf-observability
  let performance = null;
  try {
    const r = await fetch(`${config.supply_economy.perf_observability_url}/trading/stats`, {
      signal: AbortSignal.timeout(2000)
    });
    const data = await r.json();
    performance = data.stats || null;
  } catch (err) {
    performance = { error: 'Perf-observability unavailable' };
  }

  res.json({
    outcome: 'trading',
    services_online: services.filter(s => s.online).length,
    services_total: services.length,
    services,
    pnl,
    performance,
    timestamp: now()
  });
});

// ─── Demand Dashboard ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.redirect('/dashboard.html');
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] Running on port ${PORT} | Demand Economy Orchestrator`);
  console.log(`[${SERVICE_NAME}] Dashboard: http://localhost:${PORT}/dashboard.html`);
});
