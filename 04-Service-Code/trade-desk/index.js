const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8003;
const SERVICE_NAME = 'trade-desk';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Request Queue (in-memory, persisted to file) ──────────────────────────

let requests = {};     // { requestId: { ...request details } }
let completedCount = 0;
let failedCount = 0;
let escalatedCount = 0;

const QUEUE_FILE = path.join(__dirname, config.persistence.file);
try {
  if (fs.existsSync(QUEUE_FILE)) {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    requests = data.requests || {};
    completedCount = data.completedCount || 0;
    failedCount = data.failedCount || 0;
    escalatedCount = data.escalatedCount || 0;
    console.log(`[trade-desk] Loaded ${Object.keys(requests).length} requests from disk`);
  }
} catch (err) {
  console.error(`[trade-desk] Failed to load persisted queue: ${err.message}`);
}

// ─── Helper Functions ──────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function generateId() {
  return `TD-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function logEvent(requestId, event, details = {}) {
  if (requests[requestId]) {
    requests[requestId].events.push({ timestamp: now(), event, ...details });
  }
  // Append to audit file
  try {
    const auditFile = path.join(__dirname, '..', '..', 'services', 'audit', 'trade-desk.log');
    fs.appendFileSync(auditFile, JSON.stringify({ timestamp: now(), requestId, event, ...details }) + '\n');
  } catch (err) {
    // Non-fatal
  }
}

async function checkTrustScore(serviceName) {
  try {
    const res = await fetch(`${config.trust_scoring_url}/scores/${serviceName}`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return { score: 1.0, quarantined: false }; // Default if trust scoring unavailable
    const data = await res.json();
    return { score: data.score, quarantined: data.quarantined };
  } catch (err) {
    // Trust scoring unavailable — allow but log
    console.log(`[trade-desk] Trust scoring unavailable for ${serviceName}: ${err.message}`);
    return { score: 1.0, quarantined: false };
  }
}

async function resolveService(capability) {
  // First check static capability map
  const mapped = config.capability_map[capability];
  if (mapped) {
    return mapped;
  }

  // If not in static map, try to find via registry
  try {
    const res = await fetch(`${config.registry_url}/services`, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const services = await res.json();
      // Try to find a service whose name contains the capability keyword
      for (const [name, info] of Object.entries(services)) {
        if (name.includes(capability) || capability.includes(name)) {
          return { service: name, port: info.port };
        }
      }
    }
  } catch (err) {
    // Registry unavailable
  }

  return null;
}

async function escalateToGovernor(requestId, reason) {
  const req = requests[requestId];
  if (!req) return;

  req.status = 'escalated';
  req.escalated_at = now();
  req.escalation_reason = reason;
  escalatedCount++;

  logEvent(requestId, 'escalated', { reason });

  try {
    await fetch(`${config.governor_url}/observe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'trade_desk_escalation',
        severity: 'warning',
        message: `Trade Desk escalation: ${reason}`,
        details: {
          request_id: requestId,
          capability: req.capability,
          requester: req.requester,
          retry_count: req.retry_count,
          original_submitted: req.submitted_at
        }
      })
    });
    console.log(`[trade-desk] Escalated ${requestId} to Governor: ${reason}`);
  } catch (err) {
    console.error(`[trade-desk] Failed to escalate to Governor: ${err.message}`);
  }
}

async function attemptAssignment(requestId) {
  const req = requests[requestId];
  if (!req || req.status === 'completed' || req.status === 'escalated' || req.status === 'cancelled') return;

  const target = await resolveService(req.capability);

  if (!target) {
    req.retry_count++;
    logEvent(requestId, 'no_service_found', { capability: req.capability });

    if (req.retry_count >= config.routing.max_retries) {
      await escalateToGovernor(requestId, `No service found for capability: ${req.capability} after ${req.retry_count} attempts`);
      return;
    }

    // Schedule retry with backoff
    const delay = config.routing.retry_delay_ms * Math.pow(config.routing.backoff_multiplier, req.retry_count - 1);
    setTimeout(() => attemptAssignment(requestId), delay);
    return;
  }

  // Check trust score — don't assign to quarantined services
  const trust = await checkTrustScore(target.service);
  if (trust.quarantined) {
    req.retry_count++;
    logEvent(requestId, 'service_quarantined', { service: target.service, score: trust.score });

    if (req.retry_count >= config.routing.max_retries) {
      await escalateToGovernor(requestId, `Target service ${target.service} is quarantined (score: ${trust.score})`);
      return;
    }

    const delay = config.routing.retry_delay_ms * Math.pow(config.routing.backoff_multiplier, req.retry_count - 1);
    setTimeout(() => attemptAssignment(requestId), delay);
    return;
  }

  if (trust.score < config.routing.min_trust_score_for_assignment) {
    logEvent(requestId, 'low_trust_warning', { service: target.service, score: trust.score });
    // Still assign, but log the risk
  }

  // Assign the work
  req.status = 'assigned';
  req.assigned_to = target.service;
  req.assigned_port = target.port;
  req.assigned_at = now();
  req.trust_score_at_assignment = trust.score;

  logEvent(requestId, 'assigned', {
    service: target.service,
    port: target.port,
    trust_score: trust.score
  });

  console.log(`[trade-desk] ${requestId} assigned to ${target.service} (trust: ${trust.score})`);

  // In Phase 0.5, we don't actually dispatch the HTTP call to the target service —
  // the requesting party uses the assignment info to call the service directly.
  // Phase 1 will add proxy dispatch where Trade Desk makes the call and returns results.
}

// ─── Queue Maintenance ─────────────────────────────────────────────────────

function purgeOldRequests() {
  const cutoff = Date.now() - (config.routing.purge_completed_after_hours * 3600000);
  let purged = 0;

  for (const [id, req] of Object.entries(requests)) {
    if (['completed', 'cancelled', 'escalated'].includes(req.status)) {
      const completedTime = new Date(req.completed_at || req.escalated_at || req.cancelled_at || req.submitted_at).getTime();
      if (completedTime < cutoff) {
        delete requests[id];
        purged++;
      }
    }
  }

  if (purged > 0) {
    console.log(`[trade-desk] Purged ${purged} old requests`);
  }
}

// Check for stale requests that have been queued too long
function checkStaleRequests() {
  const maxAge = config.routing.max_queue_time_minutes * 60000;

  for (const [id, req] of Object.entries(requests)) {
    if (['submitted', 'assigned'].includes(req.status)) {
      const age = Date.now() - new Date(req.submitted_at).getTime();
      if (age > maxAge && req.status !== 'escalated') {
        escalateToGovernor(id, `Request stale: queued for ${Math.round(age / 60000)} minutes`);
      }
    }
  }
}

setInterval(purgeOldRequests, 3600000);    // hourly
setInterval(checkStaleRequests, 60000);     // every minute

// ─── Persistence ───────────────────────────────────────────────────────────

function persist() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify({
      requests, completedCount, failedCount, escalatedCount, savedAt: now()
    }, null, 2));
  } catch (err) {
    console.error(`[trade-desk] Persist failed: ${err.message}`);
  }
}

setInterval(persist, config.persistence.save_interval_ms);

// ─── API Endpoints ─────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  const active = Object.values(requests).filter(r => ['submitted', 'assigned'].includes(r.status));
  res.json({
    service: SERVICE_NAME,
    status: 'healthy',
    timestamp: now(),
    queue_depth: active.length,
    total_requests: Object.keys(requests).length,
    completed: completedCount,
    failed: failedCount,
    escalated: escalatedCount
  });
});

// Service info
app.get('/info', (req, res) => {
  res.json({
    name: SERVICE_NAME,
    sector: 'chamber',
    port: PORT,
    version: config.version,
    maturity: 'manual',
    description: 'Work routing hub. Matches demand-side requests to supply services. Retry-with-escalation.',
    capabilities_routable: Object.keys(config.capability_map),
    endpoints: [
      'GET /health',
      'GET /info',
      'POST /request — submit a work request',
      'GET /requests — list all requests (with optional status filter)',
      'GET /requests/:id — get request status',
      'POST /requests/:id/complete — mark request completed',
      'POST /requests/:id/fail — mark request failed (triggers retry)',
      'POST /requests/:id/cancel — cancel a request',
      'GET /stats — routing statistics'
    ]
  });
});

// Submit a work request
app.post('/request', async (req, res) => {
  const { capability, priority, payload, requester, description } = req.body;

  if (!capability || !requester) {
    return res.status(400).json({
      error: 'Required: capability, requester',
      example: {
        capability: 'trust_assessment',
        priority: 'normal',
        payload: { target_service: 'treasury' },
        requester: 'governor',
        description: 'Quarterly trust assessment for Treasury'
      },
      available_capabilities: Object.keys(config.capability_map)
    });
  }

  const id = generateId();
  requests[id] = {
    id,
    capability,
    priority: priority || 'normal',
    payload: payload || {},
    requester,
    description: description || '',
    status: 'submitted',
    submitted_at: now(),
    assigned_to: null,
    assigned_at: null,
    completed_at: null,
    retry_count: 0,
    events: [{ timestamp: now(), event: 'submitted' }]
  };

  console.log(`[trade-desk] New request ${id}: ${capability} from ${requester}`);

  // Begin assignment process
  attemptAssignment(id);

  res.status(201).json({
    request_id: id,
    status: 'submitted',
    capability,
    requester,
    message: 'Request queued for routing'
  });
});

// List requests (with optional status filter)
app.get('/requests', (req, res) => {
  const statusFilter = req.query.status;
  const limit = parseInt(req.query.limit) || 50;

  let filtered = Object.values(requests);
  if (statusFilter) {
    filtered = filtered.filter(r => r.status === statusFilter);
  }

  // Sort by submitted_at descending
  filtered.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  filtered = filtered.slice(0, limit);

  // Return summary (not full events)
  const summaries = filtered.map(r => ({
    id: r.id,
    capability: r.capability,
    requester: r.requester,
    status: r.status,
    assigned_to: r.assigned_to,
    priority: r.priority,
    submitted_at: r.submitted_at,
    assigned_at: r.assigned_at,
    completed_at: r.completed_at
  }));

  res.json({ requests: summaries, total: Object.keys(requests).length, filtered: summaries.length });
});

// Get single request status
app.get('/requests/:id', (req, res) => {
  const request = requests[req.params.id];
  if (!request) {
    return res.status(404).json({ error: `Request not found: ${req.params.id}` });
  }
  res.json(request);
});

// Mark request completed
app.post('/requests/:id/complete', (req, res) => {
  const request = requests[req.params.id];
  if (!request) {
    return res.status(404).json({ error: `Request not found: ${req.params.id}` });
  }

  if (request.status === 'completed') {
    return res.status(409).json({ error: 'Request already completed' });
  }

  const { result, completed_by } = req.body;

  request.status = 'completed';
  request.completed_at = now();
  request.result = result || null;
  request.completed_by = completed_by || request.assigned_to;
  completedCount++;

  logEvent(req.params.id, 'completed', { completed_by: request.completed_by });
  console.log(`[trade-desk] ${req.params.id} completed by ${request.completed_by}`);

  res.json({
    request_id: req.params.id,
    status: 'completed',
    completed_at: request.completed_at,
    completed_by: request.completed_by
  });
});

// Mark request failed (triggers retry or escalation)
app.post('/requests/:id/fail', async (req, res) => {
  const request = requests[req.params.id];
  if (!request) {
    return res.status(404).json({ error: `Request not found: ${req.params.id}` });
  }

  const { reason, failed_by } = req.body;

  request.retry_count++;
  logEvent(req.params.id, 'failed', { reason, failed_by, retry_count: request.retry_count });

  if (request.retry_count >= config.routing.max_retries) {
    request.status = 'failed';
    request.failed_at = now();
    request.failure_reason = reason;
    failedCount++;

    await escalateToGovernor(req.params.id, `Request failed after ${request.retry_count} attempts: ${reason}`);

    res.json({
      request_id: req.params.id,
      status: 'escalated',
      retry_count: request.retry_count,
      message: 'Max retries exceeded — escalated to Governor'
    });
  } else {
    request.status = 'submitted'; // back in queue for reassignment
    request.assigned_to = null;
    request.assigned_at = null;

    // Retry with backoff
    const delay = config.routing.retry_delay_ms * Math.pow(config.routing.backoff_multiplier, request.retry_count - 1);
    setTimeout(() => attemptAssignment(req.params.id), delay);

    res.json({
      request_id: req.params.id,
      status: 'retrying',
      retry_count: request.retry_count,
      max_retries: config.routing.max_retries,
      next_retry_ms: delay
    });
  }
});

// Cancel a request
app.post('/requests/:id/cancel', (req, res) => {
  const request = requests[req.params.id];
  if (!request) {
    return res.status(404).json({ error: `Request not found: ${req.params.id}` });
  }

  if (request.status === 'completed') {
    return res.status(409).json({ error: 'Cannot cancel a completed request' });
  }

  request.status = 'cancelled';
  request.cancelled_at = now();
  request.cancel_reason = req.body.reason || 'cancelled by requester';
  logEvent(req.params.id, 'cancelled', { reason: request.cancel_reason });

  res.json({
    request_id: req.params.id,
    status: 'cancelled',
    cancelled_at: request.cancelled_at
  });
});

// Routing statistics
app.get('/stats', (req, res) => {
  const active = Object.values(requests).filter(r => ['submitted', 'assigned'].includes(r.status));
  const byCapability = {};
  for (const req of Object.values(requests)) {
    byCapability[req.capability] = (byCapability[req.capability] || 0) + 1;
  }

  res.json({
    timestamp: now(),
    total_requests: Object.keys(requests).length,
    active_queue: active.length,
    completed: completedCount,
    failed: failedCount,
    escalated: escalatedCount,
    by_capability: byCapability,
    available_capabilities: Object.keys(config.capability_map)
  });
});

// ─── Startup ───────────────────────────────────────────────────────────────

async function selfRegister() {
  try {
    await fetch(`${config.registry_url}/services/${SERVICE_NAME}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online', port: PORT })
    });
    console.log(`[trade-desk] Registered with Service Registry`);
  } catch (err) {
    console.log(`[trade-desk] Registry not available (will retry): ${err.message}`);
  }
}

process.on('SIGTERM', () => { persist(); process.exit(0); });
process.on('SIGINT', () => { persist(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`[trade-desk] Running on port ${PORT}`);
  selfRegister();
});
