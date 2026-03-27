const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 8200;
const SERVICE_NAME = 'chief-of-staff';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

function now() {
  return new Date().toISOString();
}

// ─── Demand Registry ─────────────────────────────────────────────────────────
// Demand-side services (trading, and future outcomes) register here.
// The supply economy registry (port 8099) should have NO knowledge of demand services.

let demandRegistry = {};

// ─── Intake System ────────────────────────────────────────────────────────────
// DB submits plain-language requests here. CoS asks 6 BA framing questions,
// then auto-submits a structured requirements package to Governor once answered.
// DB never needs to talk to Governor directly.

let intakes = [];
let intakeIdCounter = 1;
const INTAKES_FILE = path.join(__dirname, 'intakes.json');

// Standard BA framing questions — asked for every intake
const FRAMING_QUESTIONS = [
  { id: 'fq1', question: 'What outcome are you trying to achieve? (Describe in plain language.)' },
  { id: 'fq2', question: 'Who is this for, and how will they use it?' },
  { id: 'fq3', question: "What does 'done' look like? How will you know it worked?" },
  { id: 'fq4', question: 'What constraints exist? (Timeline, budget, technical, or regulatory.)' },
  { id: 'fq5', question: 'Priority level — critical / high / medium / low?' },
  { id: 'fq6', question: 'Does this connect to any existing services, data, or ongoing work?' }
];

// Load persisted intakes
try {
  if (fs.existsSync(INTAKES_FILE)) {
    const data = JSON.parse(fs.readFileSync(INTAKES_FILE, 'utf8'));
    intakes = data.intakes || [];
    intakeIdCounter = data.nextId || 1;
    console.log(`[${SERVICE_NAME}] Loaded ${intakes.length} intakes`);
  }
} catch (err) {}

function persistIntakes() {
  try {
    fs.writeFileSync(INTAKES_FILE, JSON.stringify({ intakes, nextId: intakeIdCounter, savedAt: now() }, null, 2));
  } catch (err) {
    console.error(`[${SERVICE_NAME}] Intakes persist failed: ${err.message}`);
  }
}

setInterval(persistIntakes, 15000);

function framingComplete(intake) {
  return FRAMING_QUESTIONS.every(fq => intake.framing_answers[fq.id]);
}

function normalizePriority(p) {
  if (!p) return 'medium';
  const lower = p.toLowerCase();
  if (lower.includes('critical')) return 'critical';
  if (lower.includes('high')) return 'high';
  if (lower.includes('low')) return 'low';
  return 'medium';
}

function deriveName(request) {
  return request.trim().replace(/[^a-zA-Z0-9\s\-]/g, '').substring(0, 60).trim();
}

function buildRequirements(intake) {
  const fa = intake.framing_answers;
  const capId = `CAP-INT-${intake.id}`;

  return {
    capabilities_needed: [
      {
        id: capId,
        name: deriveName(intake.request),
        description: `${intake.request}\n\nOutcome: ${fa.fq1 || ''}\nStakeholders: ${fa.fq2 || ''}`,
        current_state: fa.fq6
          ? `Connects to existing work: ${fa.fq6}`
          : 'No current capability — new request from DB',
        desired_state: fa.fq3 || fa.fq1 || intake.request,
        priority: normalizePriority(fa.fq5),
        blocks: 'mvp',
        constraints: fa.fq4 || null,
        stakeholders: fa.fq2 || null,
        submitted_by: 'chief-of-staff:intake'
      }
    ]
  };
}

async function autoSubmitToGovernor(intake) {
  if (!framingComplete(intake)) return;
  if (intake.status !== 'framing') return;

  intake.status = 'submitting';
  const requirements = buildRequirements(intake);

  try {
    const res = await fetch(`${config.supply_economy.governor_url}/submit-requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sector: 'demand', requirements }),
      signal: AbortSignal.timeout(5000)
    });

    if (res.ok) {
      const result = await res.json();
      intake.status = 'submitted';
      intake.submitted_at = now();
      intake.governor_response = result;
      intake.governor_work_packages = result.routing_results?.map(r => r.work_package_id) || [];
      console.log(`[${SERVICE_NAME}] Intake ${intake.id} → Governor: ${result.work_packages_created} work package(s)`);
    } else {
      const errText = await res.text();
      intake.status = 'submit_failed';
      intake.submit_error = errText;
      console.log(`[${SERVICE_NAME}] Governor rejected intake ${intake.id}: ${errText}`);
    }
  } catch (err) {
    intake.status = 'submit_failed';
    intake.submit_error = err.message;
    console.log(`[${SERVICE_NAME}] Governor unreachable for intake ${intake.id}: ${err.message}`);
  }

  persistIntakes();
}

// ─── Health & Info ────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const services = Object.values(demandRegistry);
  const online = services.filter(s => s.status === 'online').length;
  const pendingIntakes = intakes.filter(i => i.status === 'framing').length;
  res.json({
    service: SERVICE_NAME,
    status: 'healthy',
    uptime: process.uptime(),
    demand_services_online: online,
    demand_services_total: services.length,
    pending_intakes: pendingIntakes,
    total_intakes: intakes.length,
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
    })),
    endpoints: [
      'GET  /health',
      'GET  /info',
      'POST /services/:name/status — demand service self-registration',
      'GET  /services — list demand services by outcome',
      'GET  /trading/summary — trading pipeline health + P&L',
      'POST /intake — submit a plain-language request to CoS',
      'GET  /intake — list all intake items',
      'GET  /intake/:id — single intake detail + framing status',
      'POST /intake/:id/frame — answer framing questions',
      'GET  /clarifications/pending — Governor questions surfaced through CoS',
      'POST /clarifications/:id/answer — answer a Governor question via CoS',
      'GET  /dashboard.html — demand economy dashboard'
    ]
  });
});

// ─── Demand Registry Endpoints ────────────────────────────────────────────────

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

// ─── Intake Endpoints ─────────────────────────────────────────────────────────

// POST /intake — DB submits a plain-language request
app.post('/intake', (req, res) => {
  const { request } = req.body;
  if (!request || typeof request !== 'string' || !request.trim()) {
    return res.status(400).json({
      error: 'Provide a "request" string describing what you want to achieve.',
      example: { request: 'I want the trading service to pull live GEX data from Skylit Harvester' }
    });
  }

  const intake = {
    id: `INT-${intakeIdCounter++}`,
    request: request.trim(),
    status: 'framing',
    framing_answers: {},
    unanswered: [...FRAMING_QUESTIONS],
    created_at: now(),
    submitted_at: null,
    governor_response: null,
    governor_work_packages: [],
    submit_error: null
  };

  intakes.push(intake);
  persistIntakes();

  console.log(`[${SERVICE_NAME}] New intake ${intake.id}: "${request.substring(0, 60)}"`);

  res.status(201).json({
    intake_id: intake.id,
    status: 'framing',
    request: intake.request,
    message: 'Request received. Please answer the framing questions so I can submit this properly to the Governor.',
    framing_questions: FRAMING_QUESTIONS,
    next_step: `POST /intake/${intake.id}/frame with { "answers": { "fq1": "...", "fq2": "...", "fq3": "...", "fq4": "...", "fq5": "...", "fq6": "..." } }`
  });
});

// POST /intake/:id/frame — answer framing questions (all at once or partial)
app.post('/intake/:id/frame', async (req, res) => {
  const intake = intakes.find(i => i.id === req.params.id);
  if (!intake) return res.status(404).json({ error: 'Intake not found: ' + req.params.id });

  if (['submitted', 'submitting'].includes(intake.status)) {
    return res.status(409).json({
      error: 'Already submitted to Governor',
      status: intake.status,
      governor_work_packages: intake.governor_work_packages
    });
  }

  const { answers } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({
      error: 'Provide { "answers": { "fq1": "...", ... } }',
      unanswered_questions: intake.unanswered
    });
  }

  // Merge answers
  for (const [key, val] of Object.entries(answers)) {
    if (val && typeof val === 'string' && val.trim()) {
      intake.framing_answers[key] = val.trim();
    }
  }

  // Recalculate unanswered
  intake.unanswered = FRAMING_QUESTIONS.filter(fq => !intake.framing_answers[fq.id]);
  persistIntakes();

  if (framingComplete(intake)) {
    // Fire async — don't block the HTTP response
    autoSubmitToGovernor(intake);
    res.json({
      intake_id: intake.id,
      status: 'submitting',
      message: 'All framing questions answered. Submitting to Governor now.',
      framing_answers: intake.framing_answers,
      note: 'Check GET /intake/:id for submission result.'
    });
  } else {
    res.json({
      intake_id: intake.id,
      status: 'framing',
      answered: Object.keys(intake.framing_answers).length,
      remaining: intake.unanswered.length,
      unanswered_questions: intake.unanswered,
      message: `${intake.unanswered.length} question(s) still need answers before I can submit to the Governor.`
    });
  }
});

// GET /intake — list all intakes
app.get('/intake', (req, res) => {
  const statusFilter = req.query.status;
  const filtered = statusFilter ? intakes.filter(i => i.status === statusFilter) : intakes;

  res.json({
    intakes: filtered.map(i => ({
      id: i.id,
      request: i.request.substring(0, 100),
      status: i.status,
      framing_pct: Math.round(Object.keys(i.framing_answers).length / FRAMING_QUESTIONS.length * 100),
      unanswered_count: i.unanswered.length,
      created_at: i.created_at,
      submitted_at: i.submitted_at,
      governor_work_packages: i.governor_work_packages
    })),
    total: intakes.length,
    pending_framing: intakes.filter(i => i.status === 'framing').length,
    submitted: intakes.filter(i => i.status === 'submitted').length,
    failed: intakes.filter(i => i.status === 'submit_failed').length,
    timestamp: now()
  });
});

// GET /intake/:id — single intake with full detail
app.get('/intake/:id', (req, res) => {
  const intake = intakes.find(i => i.id === req.params.id);
  if (!intake) return res.status(404).json({ error: 'Intake not found: ' + req.params.id });

  res.json({
    ...intake,
    framing_pct: Math.round(Object.keys(intake.framing_answers).length / FRAMING_QUESTIONS.length * 100),
    unanswered_questions: intake.unanswered,
    all_framing_questions: FRAMING_QUESTIONS
  });
});

// ─── Clarifications Proxy ─────────────────────────────────────────────────────
// Governor's questions surface here. DB answers through CoS — never touches Governor directly.

app.get('/clarifications/pending', async (req, res) => {
  try {
    const r = await fetch(`${config.supply_economy.governor_url}/questions/pending`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await r.json();
    res.json({
      source: 'governor',
      count: data.count || 0,
      questions: data.questions || [],
      message: data.count > 0
        ? `${data.count} question(s) from the Governor waiting for your input.`
        : 'No pending clarifications from the Governor.',
      answer_via: 'POST /clarifications/:id/answer with { "answer": "..." }'
    });
  } catch (err) {
    res.status(503).json({ error: 'Governor unavailable', detail: err.message });
  }
});

app.get('/clarifications', async (req, res) => {
  try {
    const r = await fetch(`${config.supply_economy.governor_url}/questions`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await r.json();
    res.json({ source: 'governor', ...data });
  } catch (err) {
    res.status(503).json({ error: 'Governor unavailable', detail: err.message });
  }
});

app.post('/clarifications/:id/answer', async (req, res) => {
  const { answer } = req.body;
  if (!answer) return res.status(400).json({ error: 'Provide { "answer": "..." }' });

  try {
    const r = await fetch(`${config.supply_economy.governor_url}/questions/${req.params.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, answered_by: 'human:DB:via-chief-of-staff' }),
      signal: AbortSignal.timeout(3000)
    });
    const data = await r.json();
    res.json({ proxied_to: 'governor', ...data });
  } catch (err) {
    res.status(503).json({ error: 'Governor unavailable', detail: err.message });
  }
});

// ─── Trading Summary ──────────────────────────────────────────────────────────

app.get('/trading/summary', async (req, res) => {
  const tradingServices = config.demand_outcomes.trading.services;

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

process.on('SIGTERM', () => { persistIntakes(); process.exit(0); });
process.on('SIGINT',  () => { persistIntakes(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] Running on port ${PORT} | Demand Economy Orchestrator`);
  console.log(`[${SERVICE_NAME}] Intakes: ${intakes.length} | Dashboard: http://localhost:${PORT}/dashboard.html`);
});
