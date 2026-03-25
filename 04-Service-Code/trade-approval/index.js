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
      'POST /clear-queue — clear all pending approvals'
    ]
  });
});

// Submit trade for approval
app.post('/submit', async (req, res) => {
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
