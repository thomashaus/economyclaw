const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8030;
const SERVICE_NAME = 'trust-scoring';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Trust Score Database (in-memory, persisted to file) ───────────────────

let scores = {};       // { serviceName: { score, penalties[], peerAssessments[], lastUpdated } }
let auditLog = [];     // append-only event log (last 500 entries)

// Load persisted scores on startup
const SCORES_FILE = path.join(__dirname, config.persistence.file);
try {
  if (fs.existsSync(SCORES_FILE)) {
    const data = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
    scores = data.scores || {};
    auditLog = data.auditLog || [];
    console.log(`[trust-scoring] Loaded ${Object.keys(scores).length} service scores from disk`);
  }
} catch (err) {
  console.error(`[trust-scoring] Failed to load persisted scores: ${err.message}`);
}

// ─── Helper Functions ──────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function clamp(val) {
  return Math.max(config.scoring.min_score,
    Math.min(config.scoring.max_score,
      parseFloat(val.toFixed(config.scoring.decimal_precision))));
}

function ensureService(name) {
  if (!scores[name]) {
    scores[name] = {
      score: config.scoring.initial_score,
      penalties: [],
      peerAssessments: [],
      consecutiveHealthFailures: 0,
      quarantined: false,
      lastUpdated: now(),
      createdAt: now()
    };
    logAudit('service_initialized', name, { initial_score: config.scoring.initial_score });
  }
  return scores[name];
}

function logAudit(event, service, details = {}) {
  const entry = {
    timestamp: now(),
    event,
    service,
    ...details
  };
  auditLog.push(entry);
  // Keep last 500 entries in memory
  if (auditLog.length > 500) {
    auditLog = auditLog.slice(-500);
  }
  // Also append to audit log file
  try {
    const auditFile = path.join(__dirname, '..', '..', 'services', 'audit', 'trust-scoring.log');
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Audit file write failure is not fatal
  }
}

function computeEffectiveScore(name) {
  const svc = scores[name];
  if (!svc) return null;

  let effective = svc.score;

  // Blend in peer assessments if enough exist
  if (config.peer_assessment.enabled && svc.peerAssessments.length >= config.peer_assessment.min_assessments_for_weight) {
    const cutoff = Date.now() - (config.peer_assessment.max_age_hours * 3600000);
    const recentPeers = svc.peerAssessments.filter(p => new Date(p.timestamp).getTime() > cutoff);

    if (recentPeers.length >= config.peer_assessment.min_assessments_for_weight) {
      const peerAvg = recentPeers.reduce((sum, p) => sum + p.rating, 0) / recentPeers.length;
      const w = config.peer_assessment.weight;
      effective = (effective * (1 - w)) + (peerAvg * w);
    }
  }

  return clamp(effective);
}

function checkQuarantine(name) {
  const svc = scores[name];
  if (!svc) return;

  const effective = computeEffectiveScore(name);
  const wasQuarantined = svc.quarantined;

  if (effective <= config.scoring.quarantine_threshold && !svc.quarantined) {
    svc.quarantined = true;
    logAudit('quarantine_activated', name, { score: effective, threshold: config.scoring.quarantine_threshold });
    console.log(`[trust-scoring] QUARANTINE: ${name} score ${effective} below threshold ${config.scoring.quarantine_threshold}`);
  }
  // Note: quarantine is NOT auto-lifted. Requires explicit restoration with evidence.
}

// ─── Persistence ───────────────────────────────────────────────────────────

function persistScores() {
  try {
    fs.writeFileSync(SCORES_FILE, JSON.stringify({ scores, auditLog, savedAt: now() }, null, 2));
  } catch (err) {
    console.error(`[trust-scoring] Persist failed: ${err.message}`);
  }
}

setInterval(persistScores, config.persistence.save_interval_ms);

// ─── Health Polling ────────────────────────────────────────────────────────

async function pollServiceHealth() {
  try {
    const registryRes = await fetch(`${config.registry_url}/services`);
    if (!registryRes.ok) return;
    const registry = await registryRes.json();

    for (const [name, info] of Object.entries(registry.services || registry)) {
      if (name === SERVICE_NAME) continue; // don't poll self

      try {
        const healthRes = await fetch(`http://localhost:${info.port}/health`, {
          signal: AbortSignal.timeout(config.health_polling.timeout_ms)
        });

        const svc = ensureService(name);

        if (healthRes.ok) {
          svc.consecutiveHealthFailures = 0;
        } else {
          svc.consecutiveHealthFailures++;
          if (svc.consecutiveHealthFailures >= config.health_polling.consecutive_failures_penalty) {
            applyPenaltyInternal(name, 'health_check_failure',
              config.health_polling.failure_penalty,
              `${svc.consecutiveHealthFailures} consecutive health check failures`);
            svc.consecutiveHealthFailures = 0; // reset after penalty
          }
        }
      } catch (err) {
        const svc = ensureService(name);
        svc.consecutiveHealthFailures++;
        if (svc.consecutiveHealthFailures >= config.health_polling.consecutive_failures_penalty) {
          applyPenaltyInternal(name, 'health_check_unreachable',
            config.health_polling.failure_penalty,
            `${svc.consecutiveHealthFailures} consecutive failures: ${err.message}`);
          svc.consecutiveHealthFailures = 0;
        }
      }
    }
  } catch (err) {
    // Registry unreachable — skip this cycle
  }
}

function applyPenaltyInternal(serviceName, event, amount, evidence) {
  const svc = ensureService(serviceName);
  const oldScore = svc.score;
  svc.score = clamp(svc.score + amount); // amount is negative
  svc.lastUpdated = now();

  const penalty = {
    timestamp: now(),
    event,
    amount,
    evidence,
    scoreBefore: oldScore,
    scoreAfter: svc.score
  };
  svc.penalties.push(penalty);

  // Keep last 100 penalties per service
  if (svc.penalties.length > 100) {
    svc.penalties = svc.penalties.slice(-100);
  }

  logAudit('penalty_applied', serviceName, { event, amount, evidence, oldScore, newScore: svc.score });
  checkQuarantine(serviceName);
}

if (config.health_polling.enabled) {
  setInterval(pollServiceHealth, config.health_polling.interval_ms);
}

// ─── API Endpoints ─────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    status: 'healthy',
    timestamp: now(),
    tracked_services: Object.keys(scores).length,
    quarantined_services: Object.values(scores).filter(s => s.quarantined).length
  });
});

// Service info
app.get('/info', (req, res) => {
  res.json({
    name: SERVICE_NAME,
    sector: 'regulatory',
    port: PORT,
    version: config.version,
    maturity: 'observe',
    description: 'Evidence-based trust scoring for all economy services. Penalty-based, not self-reported.',
    endpoints: [
      'GET /health',
      'GET /info',
      'GET /scores — all service scores',
      'GET /scores/:service — single service score',
      'GET /scores/:service/history — penalty history for a service',
      'POST /penalty — apply a penalty (requires evidence)',
      'POST /peer-assess — submit a peer assessment',
      'POST /restore — restore score (requires evidence of fix)',
      'GET /summary — economy-wide trust summary (for Governor)',
      'GET /audit — recent audit log entries'
    ]
  });
});

// All scores (public — returns effective scores only, no penalty details)
app.get('/scores', (req, res) => {
  const result = {};
  for (const [name, svc] of Object.entries(scores)) {
    result[name] = {
      score: computeEffectiveScore(name),
      quarantined: svc.quarantined,
      penalty_count: svc.penalties.length,
      peer_assessment_count: svc.peerAssessments.length,
      last_updated: svc.lastUpdated
    };
  }
  res.json({ scores: result, timestamp: now() });
});

// Single service score
app.get('/scores/:service', (req, res) => {
  const name = req.params.service;
  const svc = scores[name];
  if (!svc) {
    return res.status(404).json({ error: `No score record for service: ${name}` });
  }
  res.json({
    service: name,
    score: computeEffectiveScore(name),
    raw_score: svc.score,
    quarantined: svc.quarantined,
    penalty_count: svc.penalties.length,
    peer_assessment_count: svc.peerAssessments.length,
    last_updated: svc.lastUpdated,
    created_at: svc.createdAt
  });
});

// Penalty history for a specific service (restricted — only the service itself or Governor)
app.get('/scores/:service/history', (req, res) => {
  const name = req.params.service;
  const svc = scores[name];
  if (!svc) {
    return res.status(404).json({ error: `No score record for service: ${name}` });
  }
  // In Phase 0.5, we allow all callers (IAM enforcement comes later)
  // Decision #59: penalty details are NOT shared cross-service (only aggregate score)
  // For now, return history but flag this as a future IAM gate
  res.json({
    service: name,
    _iam_note: 'Phase 0.5: open access. Phase 1: restricted to self + governor.',
    penalties: svc.penalties.slice(-20), // last 20 penalties
    total_penalties: svc.penalties.length
  });
});

// Apply a penalty (from Governor, Observability, or system)
app.post('/penalty', (req, res) => {
  const { service, event, amount, evidence, reported_by } = req.body;

  if (!service || !event || !evidence) {
    return res.status(400).json({
      error: 'Required fields: service, event, evidence',
      example: {
        service: 'governor',
        event: 'missed_deadline',
        amount: -0.1,
        evidence: 'State of the State report was 48 hours late',
        reported_by: 'observability'
      }
    });
  }

  // Self-reporting is forbidden (Decision #59)
  if (reported_by === service) {
    logAudit('self_report_rejected', service, { event, reported_by });
    return res.status(403).json({
      error: 'Self-reported penalties are not accepted. Trust scoring is evidence-based, not self-reported.',
      decision: '#59'
    });
  }

  const penaltyAmount = amount || -0.1; // default penalty
  if (penaltyAmount >= 0) {
    return res.status(400).json({ error: 'Penalty amount must be negative' });
  }

  const svc = ensureService(service);
  const oldScore = svc.score;
  applyPenaltyInternal(service, event, penaltyAmount, evidence);

  res.json({
    service,
    event,
    penalty_applied: penaltyAmount,
    score_before: oldScore,
    score_after: svc.score,
    effective_score: computeEffectiveScore(service),
    quarantined: svc.quarantined,
    reported_by: reported_by || 'unknown'
  });
});

// Peer assessment (any service can rate another — Decision #80)
app.post('/peer-assess', (req, res) => {
  const { assessor, target, rating, reason } = req.body;

  if (!assessor || !target || rating === undefined) {
    return res.status(400).json({
      error: 'Required fields: assessor, target, rating (0.0-1.0)',
      example: {
        assessor: 'governor',
        target: 'treasury',
        rating: 0.9,
        reason: 'Consistent accurate token tracking this quarter'
      }
    });
  }

  if (assessor === target) {
    return res.status(403).json({ error: 'Services cannot assess themselves' });
  }

  if (rating < 0 || rating > 1) {
    return res.status(400).json({ error: 'Rating must be between 0.0 and 1.0' });
  }

  const svc = ensureService(target);
  const assessment = {
    assessor,
    rating: parseFloat(rating.toFixed(3)),
    reason: reason || '',
    timestamp: now()
  };

  svc.peerAssessments.push(assessment);

  // Keep last 50 peer assessments per service
  if (svc.peerAssessments.length > 50) {
    svc.peerAssessments = svc.peerAssessments.slice(-50);
  }

  svc.lastUpdated = now();
  logAudit('peer_assessment', target, { assessor, rating: assessment.rating, reason });

  checkQuarantine(target);

  res.json({
    target,
    assessor,
    rating: assessment.rating,
    effective_score: computeEffectiveScore(target),
    total_peer_assessments: svc.peerAssessments.length
  });
});

// Restore a score (requires evidence of corrective action — never auto-restored)
app.post('/restore', (req, res) => {
  const { service, new_score, evidence, authorized_by } = req.body;

  if (!service || new_score === undefined || !evidence || !authorized_by) {
    return res.status(400).json({
      error: 'Required fields: service, new_score, evidence, authorized_by',
      example: {
        service: 'treasury',
        new_score: 0.85,
        evidence: 'Token tracking bug fixed in commit abc123, verified by 3 consecutive accurate reports',
        authorized_by: 'governor'
      }
    });
  }

  if (new_score < 0 || new_score > 1) {
    return res.status(400).json({ error: 'new_score must be between 0.0 and 1.0' });
  }

  const svc = ensureService(service);
  const oldScore = svc.score;

  // Score can only be restored, not inflated above previous high
  if (new_score > config.scoring.initial_score) {
    return res.status(400).json({ error: `Cannot set score above initial (${config.scoring.initial_score})` });
  }

  svc.score = clamp(new_score);
  svc.lastUpdated = now();

  // Lift quarantine if score is now above threshold
  if (svc.quarantined && svc.score > config.scoring.quarantine_threshold) {
    svc.quarantined = false;
    logAudit('quarantine_lifted', service, { score: svc.score, authorized_by });
  }

  logAudit('score_restored', service, {
    oldScore,
    newScore: svc.score,
    evidence,
    authorized_by
  });

  res.json({
    service,
    score_before: oldScore,
    score_after: svc.score,
    quarantined: svc.quarantined,
    evidence,
    authorized_by
  });
});

// Economy-wide trust summary (for Governor's State of the State)
app.get('/summary', (req, res) => {
  const serviceNames = Object.keys(scores);
  const effectiveScores = serviceNames.map(n => ({ name: n, score: computeEffectiveScore(n) }));
  const quarantined = effectiveScores.filter(s => scores[s.name].quarantined);
  const warning = effectiveScores.filter(s => s.score <= config.scoring.warning_threshold && !scores[s.name].quarantined);
  const healthy = effectiveScores.filter(s => s.score >= config.scoring.healthy_threshold);

  const avgScore = serviceNames.length > 0
    ? clamp(effectiveScores.reduce((sum, s) => sum + s.score, 0) / serviceNames.length)
    : 1.0;

  // Governor's score first (Decision #78)
  const governorScore = scores['governor'] ? computeEffectiveScore('governor') : null;

  res.json({
    timestamp: now(),
    governor_trust_score: governorScore,
    economy_average: avgScore,
    total_services: serviceNames.length,
    healthy_count: healthy.length,
    warning_count: warning.length,
    quarantined_count: quarantined.length,
    quarantined_services: quarantined.map(s => s.name),
    warning_services: warning.map(s => ({ name: s.name, score: s.score })),
    all_scores: effectiveScores.sort((a, b) => a.score - b.score)
  });
});

// Recent audit log
app.get('/audit', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    entries: auditLog.slice(-limit),
    total: auditLog.length
  });
});

// ─── Startup ───────────────────────────────────────────────────────────────

// Self-register with Service Registry
async function selfRegister() {
  try {
    await fetch(`${config.registry_url}/services/${SERVICE_NAME}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online', port: PORT })
    });
    console.log(`[trust-scoring] Registered with Service Registry`);
  } catch (err) {
    console.log(`[trust-scoring] Registry not available (will retry): ${err.message}`);
  }
}

// Graceful shutdown — persist scores
process.on('SIGTERM', () => {
  console.log('[trust-scoring] Shutting down — persisting scores...');
  persistScores();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[trust-scoring] Shutting down — persisting scores...');
  persistScores();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`[trust-scoring] Running on port ${PORT}`);
  selfRegister();
  // Run initial health poll after 5 seconds
  setTimeout(pollServiceHealth, 5000);
});
