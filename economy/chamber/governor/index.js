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

// ─── Work Packages Store ────────────────────────────────────────────────────

let workPackages = {};    // { id: { ... } }
let requirements = {};    // { sector: { ... business-requirements.json } }
let questions = [];       // clarifying questions for human
let questionIdCounter = 1;

const WORK_FILE = path.join(__dirname, 'work-packages.json');
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// Load persisted state
try {
  if (fs.existsSync(WORK_FILE)) {
    const data = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8'));
    workPackages = data.workPackages || {};
    requirements = data.requirements || {};
    console.log(`[Governor] Loaded ${Object.keys(workPackages).length} work packages`);
  }
} catch (err) {
  console.log(`[Governor] No persisted work packages: ${err.message}`);
}

try {
  if (fs.existsSync(QUESTIONS_FILE)) {
    const data = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
    questions = data.questions || [];
    questionIdCounter = data.nextId || 1;
  }
} catch (err) {}

function persistWork() {
  try {
    fs.writeFileSync(WORK_FILE, JSON.stringify({ workPackages, requirements, savedAt: now() }, null, 2));
  } catch (err) {
    console.error(`[Governor] Work persist failed: ${err.message}`);
  }
}

function persistQuestions() {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify({ questions, nextId: questionIdCounter, savedAt: now() }, null, 2));
  } catch (err) {
    console.error(`[Governor] Questions persist failed: ${err.message}`);
  }
}

setInterval(persistWork, 15000);
setInterval(persistQuestions, 15000);

// ─── Helper Functions ──────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function generateWorkId(capId) {
  return `WP-${capId}-${Date.now().toString(36)}`;
}

// ─── Requirements Submittal ────────────────────────────────────────────────

function decomposeRequirements(sector, reqs) {
  const packages = [];

  if (!reqs.capabilities_needed || !Array.isArray(reqs.capabilities_needed)) {
    return packages;
  }

  for (const cap of reqs.capabilities_needed) {
    const wpId = generateWorkId(cap.id);

    const wp = {
      id: wpId,
      capability_id: cap.id,
      name: cap.name,
      description: cap.description,
      current_state: cap.current_state,
      desired_state: cap.desired_state,
      priority: cap.priority,
      blocks: cap.blocks,
      sector: sector,
      status: 'pending_decomposition',
      assigned_services: [],
      phases: [],
      progress_pct: 0,
      submitted_at: now(),
      updated_at: now(),
      questions: [],
      deliverables: [],
      notes: []
    };

    packages.push(wp);
    workPackages[wpId] = wp;
  }

  return packages;
}

// ─── Trade Desk Integration ────────────────────────────────────────────────

async function routeToTradeDesk(workPackage) {
  try {
    const res = await fetch('http://localhost:8003/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability: 'gap_analysis',
        priority: workPackage.priority === 'critical' ? 'high' : 'normal',
        payload: {
          work_package_id: workPackage.id,
          capability_id: workPackage.capability_id,
          name: workPackage.name,
          description: workPackage.description,
          desired_state: workPackage.desired_state
        },
        requester: 'governor',
        description: `Decompose and build: ${workPackage.name}`
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const result = await res.json();
      workPackage.trade_desk_request_id = result.request_id;
      workPackage.status = 'routed';
      workPackage.updated_at = now();
      return result;
    }
  } catch (err) {
    console.log(`[Governor] Trade Desk routing failed for ${workPackage.id}: ${err.message}`);
  }
  return null;
}

// ── Health Check ──
app.get('/health', (req, res) => {
  state.last_health_check = new Date().toISOString();
  const activeWork = Object.values(workPackages).filter(wp => !['completed', 'cancelled'].includes(wp.status));
  const pendingQuestions = questions.filter(q => q.status === 'pending');
  res.json({
    service: SERVICE_NAME,
    sector: SECTOR,
    status: 'healthy',
    uptime: process.uptime(),
    maturity: state.maturity,
    trust_score: state.trust_score,
    active_work_packages: activeWork.length,
    pending_questions: pendingQuestions.length,
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
    started: state.started,
    endpoints: [
      'GET /health',
      'GET /info',
      'GET /state-of-the-state — economy health report',
      'POST /observe — record an observation',
      'POST /circuit-breaker — activate a circuit breaker',
      'POST /submit-requirements — submit business requirements for decomposition',
      'GET /work-packages — all work packages with status',
      'GET /work-packages/:id — single work package detail',
      'POST /work-packages/:id/update — update work package status/progress',
      'POST /work-packages/:id/note — add a note to a work package',
      'GET /dashboard — full dashboard data for UI rendering',
      'POST /questions — supply economy asks human a question',
      'GET /questions — all questions (pending and answered)',
      'POST /questions/:id/answer — human answers a question',
      'GET /questions/pending — unanswered questions only'
    ]
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

  const online = Object.values(healthChecks).filter(h => h.status !== 'offline').length;
  const total = Object.keys(healthChecks).length;

  report.items['economy_health'] = {
    services_online: `${online}/${total}`,
    details: healthChecks
  };

  // 3. Work Package Summary
  const wpSummary = {
    total: Object.keys(workPackages).length,
    by_status: {},
    by_priority: {},
    pending_questions: questions.filter(q => q.status === 'pending').length
  };
  for (const wp of Object.values(workPackages)) {
    wpSummary.by_status[wp.status] = (wpSummary.by_status[wp.status] || 0) + 1;
    wpSummary.by_priority[wp.priority] = (wpSummary.by_priority[wp.priority] || 0) + 1;
  }
  report.items['work_packages'] = wpSummary;

  // 4. Observations
  report.items['observations'] = state.observations.slice(-10);

  // 5. Circuit Breaker Status
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
  if (state.observations.length > 100) {
    state.observations = state.observations.slice(-100);
  }

  try {
    const logLine = JSON.stringify(observation) + '\n';
    fs.appendFileSync(
      path.join(__dirname, '../../services/audit/economy.log'),
      logLine
    );
  } catch (err) {}

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

  try {
    fs.appendFileSync(
      path.join(__dirname, '../../services/audit/economy.log'),
      JSON.stringify(event) + '\n'
    );
  } catch (err) {}

  res.json({
    activated: true,
    maturity_note: `Governor at ${state.maturity} maturity — logging only, no automated response`,
    event
  });
});

// ─── SUBMITTAL MECHANISM ────────────────────────────────────────────────────

app.post('/submit-requirements', async (req, res) => {
  const { sector, requirements_file } = req.body;

  // Accept either inline requirements or a file path
  let reqs;
  if (req.body.requirements) {
    reqs = req.body.requirements;
  } else if (requirements_file) {
    try {
      reqs = JSON.parse(fs.readFileSync(requirements_file, 'utf8'));
    } catch (err) {
      return res.status(400).json({ error: `Cannot read requirements file: ${err.message}` });
    }
  } else {
    return res.status(400).json({
      error: 'Provide either inline "requirements" object or "requirements_file" path',
      required: 'sector (string)',
      example: {
        sector: 'trading',
        requirements_file: '/path/to/business-requirements.json'
      }
    });
  }

  if (!sector) {
    return res.status(400).json({ error: 'sector is required (e.g., "trading")' });
  }

  // Store the requirements
  requirements[sector] = {
    submitted_at: now(),
    data: reqs
  };

  // Decompose into work packages
  const packages = decomposeRequirements(sector, reqs);

  state.observations.push({
    timestamp: now(),
    source: 'governor',
    type: 'requirements_submitted',
    detail: `${sector} sector submitted ${packages.length} capabilities for decomposition`,
    severity: 'info'
  });

  // Route each work package through Trade Desk
  const routingResults = [];
  for (const wp of packages) {
    const result = await routeToTradeDesk(wp);
    routingResults.push({
      work_package_id: wp.id,
      capability: wp.name,
      priority: wp.priority,
      trade_desk_result: result ? 'routed' : 'routing_failed'
    });
  }

  persistWork();

  res.status(201).json({
    sector,
    work_packages_created: packages.length,
    routing_results: routingResults,
    message: `${packages.length} capabilities decomposed into work packages and routed to Trade Desk`,
    next_step: 'Supply services will pick up work packages. Check GET /work-packages for status. Check GET /questions/pending for clarification requests.'
  });
});

// ─── WORK PACKAGES ─────────────────────────────────────────────────────────

app.get('/work-packages', (req, res) => {
  const statusFilter = req.query.status;
  const sectorFilter = req.query.sector;
  const priorityFilter = req.query.priority;

  let filtered = Object.values(workPackages);
  if (statusFilter) filtered = filtered.filter(wp => wp.status === statusFilter);
  if (sectorFilter) filtered = filtered.filter(wp => wp.sector === sectorFilter);
  if (priorityFilter) filtered = filtered.filter(wp => wp.priority === priorityFilter);

  // Sort by priority (critical > high > medium > low) then by submitted
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  filtered.sort((a, b) => {
    const pDiff = (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99);
    if (pDiff !== 0) return pDiff;
    return new Date(a.submitted_at) - new Date(b.submitted_at);
  });

  res.json({
    work_packages: filtered,
    total: Object.keys(workPackages).length,
    filtered: filtered.length,
    timestamp: now()
  });
});

app.get('/work-packages/:id', (req, res) => {
  const wp = workPackages[req.params.id];
  if (!wp) return res.status(404).json({ error: 'Work package not found: ' + req.params.id });
  res.json(wp);
});

app.post('/work-packages/:id/update', (req, res) => {
  const wp = workPackages[req.params.id];
  if (!wp) return res.status(404).json({ error: 'Work package not found: ' + req.params.id });

  const { status, progress_pct, assigned_services, phases, deliverables } = req.body;

  if (status) wp.status = status;
  if (progress_pct !== undefined) wp.progress_pct = progress_pct;
  if (assigned_services) wp.assigned_services = assigned_services;
  if (phases) wp.phases = phases;
  if (deliverables) wp.deliverables = deliverables;
  wp.updated_at = now();

  persistWork();

  res.json({ work_package_id: wp.id, status: wp.status, progress_pct: wp.progress_pct, updated_at: wp.updated_at });
});

app.post('/work-packages/:id/note', (req, res) => {
  const wp = workPackages[req.params.id];
  if (!wp) return res.status(404).json({ error: 'Work package not found: ' + req.params.id });

  const note = {
    timestamp: now(),
    author: req.body.author || 'unknown',
    content: req.body.content || ''
  };

  wp.notes.push(note);
  wp.updated_at = now();
  persistWork();

  res.json({ work_package_id: wp.id, note_added: true, total_notes: wp.notes.length });
});

// ─── QUESTIONS (Supply Economy ↔ Human Interface) ──────────────────────────

app.post('/questions', (req, res) => {
  const { work_package_id, asked_by, question, context, options } = req.body;

  if (!question || !asked_by) {
    return res.status(400).json({
      error: 'Required: question, asked_by. Optional: work_package_id, context, options (array)',
      example: {
        work_package_id: 'WP-CAP-002-abc123',
        asked_by: 'entrepreneurial',
        question: 'For chart structure detection, should we prioritize hourly timeframe or 3-minute first?',
        context: 'Building CAP-002. Hourly requires less data storage but 3-min gives better entry timing.',
        options: ['Hourly first', '3-minute first', 'Both simultaneously']
      }
    });
  }

  const q = {
    id: `Q-${questionIdCounter++}`,
    work_package_id: work_package_id || null,
    asked_by,
    question,
    context: context || null,
    options: options || null,
    status: 'pending',
    asked_at: now(),
    answer: null,
    answered_at: null,
    answered_by: null
  };

  questions.push(q);

  // Tag the work package if linked
  if (work_package_id && workPackages[work_package_id]) {
    workPackages[work_package_id].questions.push(q.id);
  }

  persistQuestions();

  console.log(`[Governor] New question ${q.id} from ${asked_by}: ${question}`);

  res.status(201).json({
    question_id: q.id,
    status: 'pending',
    message: 'Question queued for human review. Check GET /questions/' + q.id + ' for answer.'
  });
});

app.get('/questions', (req, res) => {
  const statusFilter = req.query.status;
  let filtered = questions;
  if (statusFilter) filtered = questions.filter(q => q.status === statusFilter);

  res.json({
    questions: filtered,
    total: questions.length,
    pending: questions.filter(q => q.status === 'pending').length,
    answered: questions.filter(q => q.status === 'answered').length
  });
});

app.get('/questions/pending', (req, res) => {
  const pending = questions.filter(q => q.status === 'pending');
  res.json({
    questions: pending,
    count: pending.length,
    message: pending.length > 0
      ? `${pending.length} question(s) waiting for your input.`
      : 'No pending questions. Supply economy has what it needs for now.'
  });
});

app.get('/questions/:id', (req, res) => {
  const q = questions.find(q => q.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found: ' + req.params.id });
  res.json(q);
});

app.post('/questions/:id/answer', (req, res) => {
  const q = questions.find(q => q.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found: ' + req.params.id });

  if (q.status === 'answered') {
    return res.status(409).json({ error: 'Question already answered', previous_answer: q.answer });
  }

  q.answer = req.body.answer;
  q.answered_at = now();
  q.answered_by = req.body.answered_by || 'human:DB';
  q.status = 'answered';

  persistQuestions();

  console.log(`[Governor] Question ${q.id} answered by ${q.answered_by}`);

  res.json({
    question_id: q.id,
    status: 'answered',
    answer: q.answer,
    message: 'Answer recorded. The supply service that asked will pick this up on their next check.'
  });
});

// ─── DASHBOARD ──────────────────────────────────────────────────────────────

app.get('/dashboard', async (req, res) => {
  // 1. Service health
  const registry = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../services/registry.json'), 'utf8'
  ));

  const services = {};
  for (const [name, svc] of Object.entries(registry.services)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://${svc.host}:${svc.port}/health`, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data = await response.json();
      services[name] = { status: 'online', port: svc.port, sector: svc.sector, ...data };
    } catch (err) {
      services[name] = { status: 'offline', port: svc.port, sector: svc.sector };
    }
  }

  const onlineCount = Object.values(services).filter(s => s.status === 'online').length;
  const totalCount = Object.keys(services).length;

  // 2. Work package summary
  const allWp = Object.values(workPackages);
  const wpByStatus = {};
  const wpByPriority = {};
  for (const wp of allWp) {
    wpByStatus[wp.status] = (wpByStatus[wp.status] || 0) + 1;
    wpByPriority[wp.priority] = (wpByPriority[wp.priority] || 0) + 1;
  }

  const overallProgress = allWp.length > 0
    ? Math.round(allWp.reduce((sum, wp) => sum + wp.progress_pct, 0) / allWp.length)
    : 0;

  // 3. MVP vs Final readiness
  const mvpCaps = allWp.filter(wp => wp.blocks === 'mvp');
  const finalCaps = allWp.filter(wp => wp.blocks === 'final');
  const mvpProgress = mvpCaps.length > 0
    ? Math.round(mvpCaps.reduce((sum, wp) => sum + wp.progress_pct, 0) / mvpCaps.length)
    : 0;
  const finalProgress = finalCaps.length > 0
    ? Math.round(finalCaps.reduce((sum, wp) => sum + wp.progress_pct, 0) / finalCaps.length)
    : 0;

  // 4. Pending questions
  const pendingQ = questions.filter(q => q.status === 'pending');

  // 5. Recent activity
  const recentObs = state.observations.slice(-5);

  res.json({
    timestamp: now(),
    economy: {
      services_online: `${onlineCount}/${totalCount}`,
      services
    },
    work: {
      total_packages: allWp.length,
      by_status: wpByStatus,
      by_priority: wpByPriority,
      overall_progress_pct: overallProgress,
      mvp_progress_pct: mvpProgress,
      final_progress_pct: finalProgress,
      packages: allWp.map(wp => ({
        id: wp.id,
        capability_id: wp.capability_id,
        name: wp.name,
        priority: wp.priority,
        status: wp.status,
        progress_pct: wp.progress_pct,
        assigned_services: wp.assigned_services,
        blocks: wp.blocks,
        updated_at: wp.updated_at
      }))
    },
    questions: {
      pending_count: pendingQ.length,
      pending: pendingQ.map(q => ({
        id: q.id,
        asked_by: q.asked_by,
        question: q.question,
        options: q.options,
        asked_at: q.asked_at
      }))
    },
    recent_activity: recentObs,
    governor: {
      trust_score: state.trust_score,
      maturity: state.maturity,
      uptime_seconds: Math.round(process.uptime())
    }
  });
});

// ─── DASHBOARD HTML ─────────────────────────────────────────────────────────

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ── Startup ──
process.on('SIGTERM', () => { persistWork(); persistQuestions(); process.exit(0); });
process.on('SIGINT', () => { persistWork(); persistQuestions(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`[Governor] Running on port ${PORT} | Maturity: ${state.maturity} | Mandate: ${config.mandate.scope}`);
  console.log(`[Governor] Work packages: ${Object.keys(workPackages).length} | Pending questions: ${questions.filter(q => q.status === 'pending').length}`);

  state.observations.push({
    timestamp: new Date().toISOString(),
    source: SERVICE_NAME,
    type: 'lifecycle',
    detail: 'Governor service started',
    severity: 'info'
  });
});
