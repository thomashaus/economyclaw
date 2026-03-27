const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8113;
const SERVICE_NAME = 'trade-approval';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Approval Queue ──────────────────────────────────────────────────────────

let approvalQueue = [];   // pending trade proposals
let decisionLog = [];     // all approve/reject/expire decisions
let stats = {
  submitted: 0,
  approved: 0,
  rejected: 0,
  expired: 0,
  auto_rejected: 0
};

// ─── Helper Functions ────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function generateApprovalId() {
  return 'TA-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
}

function getActiveMode() {
  return config.approval_modes[config.active_mode];
}

async function checkRisk(proposal) {
  try {
    const res = await fetch(config.risk_management_url + '/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
      signal: AbortSignal.timeout(5000)
    });
    return await res.json();
  } catch (err) {
    return {
      approved: false,
      decision: 'REJECTED',
      violations: ['Risk management service unavailable: ' + err.message],
      warnings: []
    };
  }
}

async function sendToExecution(approvedTrade) {
  try {
    const res = await fetch(config.trade_execution_url + '/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(approvedTrade),
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) return await res.json();
    return { error: 'Execution returned ' + res.status };
  } catch (err) {
    return { error: 'Execution service unavailable: ' + err.message };
  }
}

function logDecision(entry, decision, reason, details) {
  const record = {
    approval_id: entry.id,
    signal_id: entry.signal_id,
    symbol: entry.symbol,
    direction: entry.direction,
    decision,
    reason,
    details: details || {},
    timestamp: now()
  };
  decisionLog.push(record);
  if (decisionLog.length > 200) decisionLog = decisionLog.slice(-200);
  console.log('[trade-approval] ' + decision + ': ' + entry.symbol + ' ' + entry.direction + ' — ' + reason);
  return record;
}

// ─── A+ Setup Checklist Scoring ──────────────────────────────────────────────

async function getHeatseekerData(signalId) {
  if (!signalId) return null;
  try {
    var res = await fetch(config.heatseeker_url + '/signals/' + signalId, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return await res.json();
  } catch (err) {}
  return null;
}

async function getRollingLevels() {
  try {
    var res = await fetch(config.heatseeker_url + '/rolling-levels', {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return await res.json();
  } catch (err) {}
  return null;
}

function scoreSetupChecklist(proposal, heatseekerSignal) {
  // A+ Setup Checklist:
  // 1. Hourly chart shows double bottom/top or key S&R level
  // 2. 3-minute chart confirms with double bottom/top pattern
  // 3. Heatseeker signal has A or A+ grade with confluence
  // 4. VIX at key level supporting directional bias
  // 5. Trinity alignment across SPX/SPY/QQQ

  var checklist = [];
  var passed = 0;
  var total = 5;

  // 1. Hourly S&R — check if proposal includes hourly_confirmation
  var hourlyCheck = {
    item: 'Hourly double bottom/top or key S&R level',
    passed: false,
    detail: 'Not provided'
  };
  if (proposal.hourly_confirmation) {
    hourlyCheck.passed = true;
    hourlyCheck.detail = proposal.hourly_confirmation;
    passed++;
  }
  checklist.push(hourlyCheck);

  // 2. 3-minute confirmation
  var threeMinCheck = {
    item: '3-minute chart double bottom/top confirmation',
    passed: false,
    detail: 'Not provided'
  };
  if (proposal.three_min_confirmation) {
    threeMinCheck.passed = true;
    threeMinCheck.detail = proposal.three_min_confirmation;
    passed++;
  }
  checklist.push(threeMinCheck);

  // 3. Heatseeker grade A or A+
  var hsGradeCheck = {
    item: 'Heatseeker signal grade A or A+',
    passed: false,
    detail: 'Grade: ' + (proposal.map_grade || 'unknown')
  };
  if (proposal.map_grade === 'A+' || proposal.map_grade === 'A') {
    hsGradeCheck.passed = true;
    passed++;
  }
  // Also check if heatseeker signal has confluence
  if (heatseekerSignal && heatseekerSignal.pattern_validation) {
    var pv = heatseekerSignal.pattern_validation;
    if (pv.valid && pv.confirmations && pv.confirmations.length > 0) {
      hsGradeCheck.detail += ' + ' + pv.confirmations.length + ' confluence confirmations';
    }
  }
  checklist.push(hsGradeCheck);

  // 4. VIX at key level
  var vixCheck = {
    item: 'VIX at key level supporting bias',
    passed: false,
    detail: 'No VIX data'
  };
  if (heatseekerSignal && heatseekerSignal.vix_assessment) {
    var vix = heatseekerSignal.vix_assessment;
    vixCheck.detail = 'VIX regime: ' + vix.regime;
    // VIX supports bias if: bullish + (high_dropping or low_dropping), bearish + (low_rising)
    if (vix.regime !== 'Rainbow Road' && vix.regime !== 'unknown') {
      vixCheck.passed = true;
      passed++;
    }
    if (vix.regime === 'Rainbow Road') {
      vixCheck.detail += ' — UNRELIABLE. GEX levels cannot be trusted.';
    }
  } else if (proposal.vix_confirmed) {
    vixCheck.passed = true;
    vixCheck.detail = proposal.vix_confirmed;
    passed++;
  }
  checklist.push(vixCheck);

  // 5. Trinity alignment
  var trinityCheck = {
    item: 'Trinity alignment across SPX/SPY/QQQ',
    passed: false,
    detail: 'No Trinity data'
  };
  if (heatseekerSignal && heatseekerSignal.trinity_assessment) {
    var tri = heatseekerSignal.trinity_assessment;
    trinityCheck.detail = 'Direction: ' + (tri.dominant_direction || 'unknown') + ', ratio: ' + (tri.ratio || '?');
    if (tri.dominant_direction === proposal.direction && tri.ratio >= 1.2) {
      trinityCheck.passed = true;
      passed++;
    } else if (tri.dominant_direction !== proposal.direction) {
      trinityCheck.detail += ' — OPPOSING trade direction!';
    }
  } else if (proposal.trinity_confirmed) {
    trinityCheck.passed = true;
    trinityCheck.detail = proposal.trinity_confirmed;
    passed++;
  }
  checklist.push(trinityCheck);

  // Determine tier
  var tier = 'C';
  var tierLabel = 'C Setup (Lotto)';
  var maxRiskPct = 0.01;

  if (passed >= 5) {
    tier = 'A+';
    tierLabel = 'A+ Setup — Full Checklist';
    maxRiskPct = 0.05;
  } else if (passed >= 3) {
    tier = 'B';
    tierLabel = 'B Setup — Good but incomplete checklist (' + passed + '/5)';
    maxRiskPct = 0.025;
  }

  return {
    tier: tier,
    tier_label: tierLabel,
    max_risk_pct: maxRiskPct,
    passed: passed,
    total: total,
    score_pct: Math.round((passed / total) * 100),
    checklist: checklist,
    recommendation: tier === 'A+'
      ? 'Full size. All 5 checklist items confirmed.'
      : tier === 'B'
        ? 'Half size. Missing ' + (total - passed) + ' checklist item(s).'
        : 'Lotto size only. Low conviction — ' + passed + '/5 items.'
  };
}

// ─── Guardrail Check ─────────────────────────────────────────────────────────

function checkGuardrails(proposal) {
  const g = config.guardrails;
  const rejections = [];

  // Map grade check
  if (proposal.map_grade) {
    const grades = ['A+', 'B', 'C', 'F'];
    const gradeIdx = grades.indexOf(proposal.map_grade);
    const rejectIdx = grades.indexOf(g.reject_below_map_grade);
    if (gradeIdx > rejectIdx) {
      rejections.push('Map grade ' + proposal.map_grade + ' below guardrail minimum ' + g.reject_below_map_grade);
    }
  }

  // R:R check
  if (proposal.entry_price && proposal.stop_price && proposal.target_price) {
    const risk = Math.abs(proposal.entry_price - proposal.stop_price);
    const reward = Math.abs(proposal.target_price - proposal.entry_price);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < g.reject_below_rr) {
      rejections.push('R:R ' + rr.toFixed(2) + ':1 below guardrail minimum ' + g.reject_below_rr + ':1');
    }
  }

  // Confidence check
  if (proposal.confidence !== undefined && proposal.confidence < g.reject_below_confidence) {
    rejections.push('Confidence ' + proposal.confidence + ' below guardrail minimum ' + g.reject_below_confidence);
  }

  return rejections;
}

// ─── Submit Trade for Approval ───────────────────────────────────────────────

async function submitTrade(proposal) {
  const mode = getActiveMode();
  stats.submitted++;

  const entry = {
    id: generateApprovalId(),
    signal_id: proposal.signal_id || null,
    symbol: (proposal.symbol || '').toUpperCase(),
    direction: proposal.direction,
    contracts: proposal.contracts || 1,
    entry_price: proposal.entry_price,
    stop_price: proposal.stop_price,
    target_price: proposal.target_price,
    source: proposal.source || 'unknown',
    map_grade: proposal.map_grade || null,
    confidence: proposal.confidence || null,
    submitted_at: now(),
    status: 'pending',
    risk_check: null,
    guardrail_check: null,
    expires_at: mode.approval_timeout_minutes > 0
      ? new Date(Date.now() + mode.approval_timeout_minutes * 60000).toISOString()
      : null
  };

  // ── Observe-only mode: log and reject ──
  if (config.active_mode === 'observe_only') {
    entry.status = 'observed';
    logDecision(entry, 'OBSERVED', 'Observe-only mode active. No trades executed.');
    decisionLog.push(entry);
    return {
      approval_id: entry.id,
      status: 'observed',
      message: 'Logged for observation. No execution in observe-only mode.'
    };
  }

  // ── Guardrail check (instant reject) ──
  const guardrailViolations = checkGuardrails(proposal);
  entry.guardrail_check = {
    passed: guardrailViolations.length === 0,
    violations: guardrailViolations
  };

  if (guardrailViolations.length > 0) {
    entry.status = 'auto_rejected';
    stats.auto_rejected++;
    stats.rejected++;
    logDecision(entry, 'AUTO_REJECTED', 'Guardrail violation', { violations: guardrailViolations });
    return {
      approval_id: entry.id,
      status: 'auto_rejected',
      reason: 'Guardrail violation',
      violations: guardrailViolations
    };
  }

  // ── Risk management check ──
  const riskResult = await checkRisk(proposal);
  entry.risk_check = riskResult;

  if (!riskResult.approved && mode.auto_reject_on_risk_fail) {
    entry.status = 'risk_rejected';
    stats.auto_rejected++;
    stats.rejected++;
    logDecision(entry, 'RISK_REJECTED', 'Risk management rejected', {
      violations: riskResult.violations,
      warnings: riskResult.warnings
    });
    return {
      approval_id: entry.id,
      status: 'risk_rejected',
      reason: 'Risk management check failed',
      violations: riskResult.violations,
      warnings: riskResult.warnings || [],
      risk_summary: riskResult.risk_summary
    };
  }

  // ── A+ Checklist Scoring ──
  var heatseekerSignal = await getHeatseekerData(proposal.signal_id);
  var checklistResult = scoreSetupChecklist(proposal, heatseekerSignal);
  entry.checklist_score = checklistResult;
  entry.sizing_tier = checklistResult.tier;
  entry.max_risk_pct = checklistResult.max_risk_pct;

  // ── Full auto mode: approve and send to execution ──
  if (mode.auto_approve && riskResult.approved) {
    entry.status = 'auto_approved';
    stats.approved++;
    logDecision(entry, 'AUTO_APPROVED', 'Full auto mode — risk check passed');

    const execResult = await sendToExecution(entry);
    entry.execution_result = execResult;

    return {
      approval_id: entry.id,
      status: 'auto_approved',
      message: 'Automatically approved and sent to execution',
      sizing_tier: checklistResult.tier,
      sizing_recommendation: checklistResult.recommendation,
      checklist_score: checklistResult.score_pct + '% (' + checklistResult.passed + '/' + checklistResult.total + ')',
      execution_result: execResult,
      risk_summary: riskResult.risk_summary
    };
  }

  // ── Semi-auto: queue for human approval ──
  if (approvalQueue.length >= config.queue_settings.max_pending) {
    entry.status = 'queue_full';
    logDecision(entry, 'QUEUE_FULL', 'Approval queue at capacity (' + config.queue_settings.max_pending + ')');
    return {
      approval_id: entry.id,
      status: 'queue_full',
      message: 'Approval queue is full. Clear pending items first.'
    };
  }

  entry.status = 'pending_approval';
  approvalQueue.push(entry);
  logDecision(entry, 'QUEUED', 'Awaiting human approval', {
    risk_warnings: riskResult.warnings,
    expires_at: entry.expires_at
  });

  return {
    approval_id: entry.id,
    status: 'pending_approval',
    message: 'Trade queued for human approval',
    sizing_tier: checklistResult.tier,
    sizing_recommendation: checklistResult.recommendation,
    checklist_score: checklistResult.score_pct + '% (' + checklistResult.passed + '/' + checklistResult.total + ')',
    expires_at: entry.expires_at,
    risk_summary: riskResult.risk_summary,
    risk_warnings: riskResult.warnings || []
  };
}

// ─── Expiry Cleanup ──────────────────────────────────────────────────────────

function cleanupExpired() {
  const expiredIds = [];
  approvalQueue = approvalQueue.filter(entry => {
    if (entry.expires_at && new Date() > new Date(entry.expires_at)) {
      entry.status = 'expired';
      stats.expired++;
      logDecision(entry, 'EXPIRED', 'Approval timeout reached');
      expiredIds.push(entry.id);
      return false;
    }
    return true;
  });
  if (expiredIds.length > 0) {
    console.log('[trade-approval] Expired ' + expiredIds.length + ' pending approvals');
  }
}

setInterval(cleanupExpired, config.queue_settings.cleanup_interval_seconds * 1000);

// ─── API Endpoints ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    status: 'healthy',
    timestamp: now(),
    active_mode: config.active_mode,
    mode_label: getActiveMode().label,
    pending_approvals: approvalQueue.length,
    stats
  });
});

app.get('/info', (req, res) => {
  res.json({
    name: SERVICE_NAME,
    sector: 'trading',
    port: PORT,
    version: config.version,
    maturity: 'observe',
    description: 'Human-in-the-loop trade approval. Semi-auto default: signals queue for approval. Guardrails auto-reject bad setups. Risk check before queuing.',
    active_mode: config.active_mode,
    endpoints: [
      'GET /health',
      'GET /info',
      'POST /submit — submit trade signal for approval',
      'GET /queue — current approval queue',
      'POST /approve/:id — approve a pending trade',
      'POST /reject/:id — reject a pending trade',
      'GET /decisions — decision history',
      'GET /stats — approval statistics',
      'POST /mode — change approval mode (semi_auto, full_auto, observe_only)',
      'POST /clear-queue — clear all pending approvals',
      'POST /checklist — score a setup against the A+ checklist (pre-check before submitting)'
    ]
  });
});

// Submit trade for approval
app.post('/submit', async (req, res) => {
  // order_type is required — prevents defaulting to wrong entry type
  // stop_buy  = reclaim entry (long after sweep below support) ← Heatseeker primary
  // stop_sell = rejection entry (short after sweep above resistance) ← Heatseeker primary
  // limit     = fade directly into GEX wall (must be explicit)
  // market    = discouraged on prop accounts (slippage kills R:R)
  const VALID_ORDER_TYPES = ['stop_buy', 'stop_sell', 'limit', 'market', 'stop_limit'];
  if (!req.body.order_type) {
    return res.status(400).json({
      error: 'order_type is required. Do not rely on defaults.',
      valid_types: VALID_ORDER_TYPES,
      guidance: {
        stop_buy:  'Long entry on reclaim after liquidity sweep below support (Heatseeker primary)',
        stop_sell: 'Short entry on rejection after grab above resistance (Heatseeker primary)',
        limit:     'Fade directly into a GEX wall — must be explicitly chosen',
        market:    'Discouraged on prop accounts — slippage kills R:R'
      }
    });
  }
  if (!VALID_ORDER_TYPES.includes(req.body.order_type)) {
    return res.status(400).json({
      error: `Unknown order_type: ${req.body.order_type}`,
      valid_types: VALID_ORDER_TYPES
    });
  }

  const result = await submitTrade(req.body);
  const statusCode = result.status === 'pending_approval' ? 202
    : result.status === 'auto_approved' ? 201
    : result.status === 'observed' ? 200
    : 403;
  res.status(statusCode).json(result);
});

// View approval queue
app.get('/queue', (req, res) => {
  res.json({
    queue: approvalQueue,
    count: approvalQueue.length,
    mode: config.active_mode,
    timestamp: now()
  });
});

// Approve a pending trade
app.post('/approve/:id', async (req, res) => {
  const entry = approvalQueue.find(e => e.id === req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'Approval not found or already processed: ' + req.params.id });
  }

  entry.status = 'approved';
  entry.approved_at = now();
  entry.approved_by = req.body.approved_by || 'human';
  entry.approval_notes = req.body.notes || '';
  stats.approved++;

  // Remove from queue
  approvalQueue = approvalQueue.filter(e => e.id !== req.params.id);
  logDecision(entry, 'APPROVED', 'Human approved', { notes: entry.approval_notes });

  // Send to execution
  const execResult = await sendToExecution(entry);
  entry.execution_result = execResult;

  res.json({
    approval_id: entry.id,
    status: 'approved',
    symbol: entry.symbol,
    direction: entry.direction,
    contracts: entry.contracts,
    execution_result: execResult
  });
});

// Reject a pending trade
app.post('/reject/:id', (req, res) => {
  const entry = approvalQueue.find(e => e.id === req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'Approval not found or already processed: ' + req.params.id });
  }

  entry.status = 'rejected';
  entry.rejected_at = now();
  entry.rejected_by = req.body.rejected_by || 'human';
  entry.rejection_reason = req.body.reason || 'manual rejection';
  stats.rejected++;

  // Remove from queue
  approvalQueue = approvalQueue.filter(e => e.id !== req.params.id);
  logDecision(entry, 'REJECTED', entry.rejection_reason);

  res.json({
    approval_id: entry.id,
    status: 'rejected',
    reason: entry.rejection_reason
  });
});

// Decision history
app.get('/decisions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ decisions: decisionLog.slice(-limit), total: decisionLog.length });
});

// Stats
app.get('/stats', (req, res) => {
  res.json({
    ...stats,
    approval_rate: stats.submitted > 0
      ? ((stats.approved / stats.submitted) * 100).toFixed(1) + '%'
      : '0%',
    auto_reject_rate: stats.submitted > 0
      ? ((stats.auto_rejected / stats.submitted) * 100).toFixed(1) + '%'
      : '0%',
    active_mode: config.active_mode,
    pending_count: approvalQueue.length,
    timestamp: now()
  });
});

// Change mode
app.post('/mode', (req, res) => {
  const { mode } = req.body;
  if (!config.approval_modes[mode]) {
    return res.status(400).json({
      error: 'Unknown mode. Available: ' + Object.keys(config.approval_modes).join(', ')
    });
  }
  const previous = config.active_mode;
  config.active_mode = mode;
  logDecision(
    { id: 'MODE', signal_id: null, symbol: '-', direction: '-' },
    'MODE_CHANGE',
    'Changed from ' + previous + ' to ' + mode
  );
  res.json({
    mode,
    label: config.approval_modes[mode].label,
    previous,
    timestamp: now()
  });
});

// Clear queue
app.post('/clear-queue', (req, res) => {
  const count = approvalQueue.length;
  approvalQueue.forEach(entry => {
    entry.status = 'cleared';
    stats.expired++;
    logDecision(entry, 'CLEARED', 'Queue cleared by admin');
  });
  approvalQueue = [];
  res.json({ cleared: count, timestamp: now() });
});

// ─── A+ Checklist Endpoint ─────────────────────────────────────────────────

app.post('/checklist', async (req, res) => {
  const proposal = req.body;
  if (!proposal.direction) {
    return res.status(400).json({
      error: 'Required: direction. Recommended: signal_id, map_grade, hourly_confirmation, three_min_confirmation, vix_confirmed, trinity_confirmed',
      example: {
        signal_id: 'HS-abc123',
        direction: 'long',
        map_grade: 'A+',
        hourly_confirmation: 'Double bottom at 5840 on hourly chart',
        three_min_confirmation: 'Double bottom confirmed on 3-min at 5841',
        vix_confirmed: 'VIX at 18.5 dropping — supportive for longs',
        trinity_confirmed: 'SPX/SPY/QQQ all pulling bullish, 2.3:1 ratio'
      }
    });
  }

  const heatseekerSignal = await getHeatseekerData(proposal.signal_id);
  const result = scoreSetupChecklist(proposal, heatseekerSignal);

  res.json({
    ...result,
    signal_id: proposal.signal_id || null,
    direction: proposal.direction,
    note: 'Use this to pre-check setup quality before submitting for approval. Pass all 5 items for A+ sizing.'
  });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function selfRegister() {
  try {
    await fetch(config.registry_url + '/services/' + SERVICE_NAME + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online', port: PORT })
    });
    console.log('[trade-approval] Registered with Service Registry');
  } catch (err) {
    console.log('[trade-approval] Registry not available: ' + err.message);
  }
}

app.listen(PORT, () => {
  console.log('[trade-approval] Running on port ' + PORT + ' (mode: ' + config.active_mode + ')');
  selfRegister();
});
