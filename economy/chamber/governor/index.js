const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8001;
const SERVICE_NAME = 'governor';
const SECTOR = 'chamber';

// Load business definition and config
const definition = JSON.parse(fs.readFileSync(path.join(__dirname, 'business-definition.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Service state
const state = {
  started: new Date().toISOString(),
  maturity: definition.operational_lifecycle.maturity,
  trust_score: config.trust_score.initial,
  observations: [],
  circuit_breakers: { ...config.circuit_breakers },
  last_health_check: null
};

// ── Health Check ──
app.get('/health', (req, res) => {
  state.last_health_check = new Date().toISOString();
  res.json({
    service: SERVICE_NAME,
    sector: SECTOR,
    status: 'healthy',
    uptime: process.uptime(),
    maturity: state.maturity,
    trust_score: state.trust_score,
    timestamp: state.last_health_check
  });
});

// ── Service Info ──
app.get('/info', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    sector: SECTOR,
    port: PORT,
    version: config.version,
    mandate: config.mandate,
    plus_promises: definition.promise_advertised.plus_promises,
    dependencies: definition.promise_advertised.dependencies,
    maturity: state.maturity,
    started: state.started
  });
});

// ── State of the State ──
app.get('/state-of-the-state', async (req, res) => {
  const report = {
    generated: new Date().toISOString(),
    format: 'McKinsey SCQA',
    items: {}
  };

  // 1. Governor Trust Score (always first)
  report.items['governor_trust_score'] = {
    score: state.trust_score,
    status: state.trust_score >= 0.8 ? 'healthy' : state.trust_score >= 0.6 ? 'warning' : 'critical',
    note: 'Self-reported pending Trust Scoring service assessment'
  };

  // 2. Economy Health Profile — poll all services
  const registry = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../services/registry.json'), 'utf8'
  ));

  const healthChecks = {};
  for (const [name, svc] of Object.entries(registry.services)) {
    if (name === SERVICE_NAME) continue;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`http://${svc.host}:${svc.port}/health`, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data = await response.json();
      healthChecks[name] = { status: 'online', ...data };
    } catch (err) {
      healthChecks[name] = { status: 'offline', error: err.message };
    }
  }

  const online = Object.values(healthChecks).filter(h => h.status === 'online').length;
  const total = Object.keys(healthChecks).length;

  report.items['economy_health'] = {
    services_online: `${online}/${total}`,
    details: healthChecks
  };

  // 3. Observations
  report.items['observations'] = state.observations.slice(-10);

  // 4. Circuit Breaker Status
  report.items['circuit_breakers'] = state.circuit_breakers;

  res.json(report);
});

// ── Observe (record an observation) ──
app.post('/observe', (req, res) => {
  const observation = {
    timestamp: new Date().toISOString(),
    source: req.body.source || 'unknown',
    type: req.body.type || 'general',
    detail: req.body.detail || '',
    severity: req.body.severity || 'info'
  };

  state.observations.push(observation);

  // Keep last 100 observations in memory
  if (state.observations.length > 100) {
    state.observations = state.observations.slice(-100);
  }

  // Append to audit log
  const logLine = JSON.stringify(observation) + '\n';
  fs.appendFileSync(
    path.join(__dirname, '../../services/audit/economy.log'),
    logLine
  );

  res.json({ acknowledged: true, observation });
});

// ── Circuit Breaker ──
app.post('/circuit-breaker', (req, res) => {
  const { trigger, detail } = req.body;

  if (!config.circuit_breakers[trigger]) {
    return res.status(400).json({ error: `Unknown circuit breaker: ${trigger}` });
  }

  const event = {
    timestamp: new Date().toISOString(),
    trigger,
    detail,
    action: 'CIRCUIT_BREAKER_ACTIVATED'
  };

  state.observations.push(event);

  // Log to audit
  fs.appendFileSync(
    path.join(__dirname, '../../services/audit/economy.log'),
    JSON.stringify(event) + '\n'
  );

  // In observe maturity, we alert but don't take automated action
  res.json({
    activated: true,
    maturity_note: `Governor at ${state.maturity} maturity — logging only, no automated response`,
    event
  });
});

// ── Startup ──
app.listen(PORT, () => {
  console.log(`[Governor] Running on port ${PORT} | Maturity: ${state.maturity} | Mandate: ${config.mandate.scope}`);

  // Self-register observation
  state.observations.push({
    timestamp: new Date().toISOString(),
    source: SERVICE_NAME,
    type: 'lifecycle',
    detail: 'Governor service started',
    severity: 'info'
  });
});
