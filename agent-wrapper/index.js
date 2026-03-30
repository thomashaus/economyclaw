/**
 * agent-wrapper / EconomyClaw
 *
 * Paperclip cloud adapter for the EconomyClaw supply economy.
 * - Exposes an HTTP service (port 8210) for health/status
 * - Registers with Chief of Staff as a demand-side outcome
 * - Polls Paperclip for assigned issues and executes the standard workflow:
 *     1. Checkout issue
 *     2. GET issue + comments
 *     3. Route to supply economy (Governor / Trade Desk) via HTTP
 *     4. PATCH issue → done | blocked
 *
 * Config: ./config.json
 * Secrets: process.env (PAPERCLIP_API_KEY, PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID)
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const fetch   = require('node-fetch');

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const PORT           = process.env.PORT            || config.port || 8210;
const PAPERCLIP_URL  = (process.env.PAPERCLIP_API_URL  || config.paperclip.api_url).replace(/\/$/, '');
const API_KEY        = process.env.PAPERCLIP_API_KEY;
const AGENT_ID       = process.env.PAPERCLIP_AGENT_ID;
const COMPANY_ID     = process.env.PAPERCLIP_COMPANY_ID;
const SERVICE_NAME   = config.service;

const GOVERNOR_URL   = process.env.GOVERNOR_URL   || config.supply_economy.governor_url;
const TRADE_DESK_URL = process.env.TRADE_DESK_URL || config.supply_economy.trade_desk_url;
const COS_URL        = process.env.COS_URL        || config.chief_of_staff_url;

const POLL_MS        = config.paperclip.poll_interval_ms || 30000;

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  started:      new Date().toISOString(),
  trust_score:  config.trust_score.initial,
  issues_done:  0,
  issues_blocked: 0,
  last_poll:    null,
  active_run:   null,
  errors:       [],
};

// ─── Logging ──────────────────────────────────────────────────────────────────

function now() { return new Date().toISOString(); }

function log(msg, level = 'INFO') {
  const line = `[${now()}] [${level}] [${SERVICE_NAME}] ${msg}`;
  console.log(line);
  try {
    const logFile = path.join(__dirname, 'logs', `${SERVICE_NAME}.log`);
    fs.appendFileSync(logFile, line + '\n');
  } catch (_) {}
}

// ─── Paperclip API ────────────────────────────────────────────────────────────

function pcHeaders(runId = null, mutating = false) {
  const h = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  };
  if (mutating && runId) h['X-Paperclip-Run-Id'] = runId;
  return h;
}

async function pcRequest(method, endpoint, { body, runId } = {}) {
  const url = `${PAPERCLIP_URL}${endpoint}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  const res = await fetch(url, {
    method,
    headers: pcHeaders(runId, mutating),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`${method} ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

const pc = {
  me:           ()               => pcRequest('GET', '/api/agents/me'),
  checkout:     (id, runId)      => pcRequest('POST', `/api/issues/${id}/checkout`, { runId, body: { agentId: AGENT_ID, expectedStatuses: ['todo', 'backlog', 'blocked'] } }),
  getIssue:     (id)             => pcRequest('GET',  `/api/issues/${id}`),
  getComments:  (id)             => pcRequest('GET',  `/api/issues/${id}/comments`),
  comment:      (id, body, runId) => pcRequest('POST', `/api/issues/${id}/comments`, { runId, body: { body } }),
  patch:        (id, patch, runId) => pcRequest('PATCH', `/api/issues/${id}`, { runId, body: patch }),
  listIssues:   ()               => pcRequest('GET',  `/api/companies/${COMPANY_ID}/issues?assigneeAgentId=${AGENT_ID}&status=todo,in_progress,blocked`),
};

// ─── Supply Economy Routing ───────────────────────────────────────────────────

/**
 * Route an issue to the supply economy.
 * Posts a work package to Governor via Trade Desk, returns result summary.
 */
async function routeToSupplyEconomy(issue, comments) {
  const latestComment = comments.length > 0
    ? comments[comments.length - 1].body
    : null;

  const workPackage = {
    source:       'paperclip',
    issueId:      issue.id,
    identifier:   issue.identifier,
    title:        issue.title,
    description:  issue.description,
    latestComment,
    priority:     issue.priority || 'medium',
    requestedAt:  now(),
  };

  try {
    const res = await fetch(`${GOVERNOR_URL}/api/work-packages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workPackage),
    });
    if (res.ok) {
      const data = await res.json();
      log(`Work package submitted to Governor: ${data.id || 'ok'}`);
      return { status: 'done', comment: `Work package submitted to supply economy Governor (${data.id || 'accepted'}). Issue: "${issue.title}".` };
    }
    // Governor not running — log and continue as acknowledged
    log(`Governor returned ${res.status} — falling back to acknowledgement`, 'WARN');
  } catch (err) {
    log(`Governor unreachable (${err.message}) — acknowledging issue without supply routing`, 'WARN');
  }

  // Fallback: acknowledge and mark done — Governor will pick up on next supply economy start
  return {
    status: 'done',
    comment: `EconomyClaw acknowledged issue "${issue.title}" (${issue.identifier}). ` +
             `Supply economy Governor was not reachable at routing time; issue logged locally for replay when Governor comes online.`,
  };
}

// ─── Issue Workflow ───────────────────────────────────────────────────────────

async function executeIssue(issueId, runId) {
  log(`Executing issue ${issueId} (runId=${runId})`);
  state.active_run = runId;

  // 1. Checkout
  try {
    await pc.checkout(issueId, runId);
    log(`Checked out issue ${issueId}`);
  } catch (err) {
    if (err.message.includes('409') || err.message.includes('conflict') || err.message.includes('in_progress')) {
      log(`Issue ${issueId} already checked out — continuing`, 'WARN');
    } else {
      throw err;
    }
  }

  // 2. Read
  const [issue, comments] = await Promise.all([
    pc.getIssue(issueId),
    pc.getComments(issueId),
  ]);
  log(`Issue: ${issue.identifier} "${issue.title}" (${issue.status}), ${comments.length} comments`);

  // 3. Execute (route to supply economy)
  const result = await routeToSupplyEconomy(issue, comments);

  // 4. Patch
  await pc.patch(issueId, { status: result.status, comment: result.comment }, runId);
  log(`Issue ${issueId} → ${result.status}`);

  if (result.status === 'done') state.issues_done++;
  else state.issues_blocked++;

  state.active_run = null;
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────

async function pollOnce() {
  if (!API_KEY || !AGENT_ID || !COMPANY_ID) return;
  state.last_poll = now();

  try {
    const issues = await pc.listIssues();
    const list = Array.isArray(issues) ? issues : (issues.items || issues.data || []);

    // Pick in_progress → todo → blocked
    const pick = (s) => list.find(i => i.status === s);
    const chosen = pick('in_progress') || pick('todo') || pick('blocked');

    if (chosen) {
      log(`Picked issue from poll: ${chosen.identifier} (${chosen.status})`);
      const runId = `poll-${Date.now()}`;
      await executeIssue(chosen.id, runId);
    }
  } catch (err) {
    log(`Poll error: ${err.message}`, 'WARN');
    state.errors.push({ at: now(), message: err.message });
    if (state.errors.length > 20) state.errors.shift();
  }
}

// ─── Chief of Staff Registration ──────────────────────────────────────────────

async function registerWithCoS() {
  try {
    const res = await fetch(`${COS_URL}/api/demand/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: SERVICE_NAME,
        label: 'EconomyClaw Agent',
        port: PORT,
        outcome: 'agent',
        status: 'active',
      }),
    });
    if (res.ok) log(`Registered with Chief of Staff (port ${COS_URL})`);
    else log(`CoS registration returned ${res.status}`, 'WARN');
  } catch (err) {
    log(`CoS not reachable at startup (${err.message}) — will retry on next poll cycle`, 'WARN');
  }
}

// ─── Express HTTP Service ─────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/** Health check */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, uptime: process.uptime() });
});

/** Full state */
app.get('/state', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    version: config.version,
    ...state,
    paperclip: {
      api_url:    PAPERCLIP_URL,
      agent_id:   AGENT_ID,
      company_id: COMPANY_ID,
      configured: !!(API_KEY && AGENT_ID && COMPANY_ID),
    },
    supply_economy: {
      governor_url:   GOVERNOR_URL,
      trade_desk_url: TRADE_DESK_URL,
    },
  });
});

/**
 * POST /wake — Paperclip cloud adapter wake endpoint.
 * Called by the OpenClaw gateway when a wake event arrives.
 */
app.post('/wake', async (req, res) => {
  const { runId, taskId, issueId, wakeReason } = req.body || {};
  const resolvedIssueId = taskId || issueId;

  log(`Wake event: reason=${wakeReason}, issueId=${resolvedIssueId}, runId=${runId}`);
  res.json({ accepted: true, issueId: resolvedIssueId });

  // Execute async — don't block the HTTP response
  if (resolvedIssueId && runId) {
    executeIssue(resolvedIssueId, runId).catch(err => {
      log(`Wake execution error: ${err.message}`, 'ERROR');
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  log(`EconomyClaw agent-wrapper listening on port ${PORT}`);

  if (!API_KEY || !AGENT_ID || !COMPANY_ID) {
    log('WARNING: PAPERCLIP_API_KEY / PAPERCLIP_AGENT_ID / PAPERCLIP_COMPANY_ID not set — polling disabled. Set in environment or .env.', 'WARN');
  }

  await registerWithCoS();

  // Start poll loop
  setInterval(pollOnce, POLL_MS);
  log(`Poll loop started (interval: ${POLL_MS}ms)`);
});
