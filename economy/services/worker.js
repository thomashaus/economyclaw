/**
 * EconomyClaw — Supply Service Worker Mixin
 *
 * Gives any supply service the ability to:
 *   1. Poll the Trade Desk for assigned work packages
 *   2. Call an LLM (via OpenRouter) to reason about the work
 *   3. Report completion/failure back to Trade Desk
 *   4. Update the Governor's work package progress
 *
 * Usage in a service:
 *   const { startWorker, callLLM } = require('../services/worker');
 *   startWorker({ serviceName: 'security', port: 8010, handler: async (workPackage) => { ... } });
 *
 * Copyright 2026 DB — Licensed under Apache 2.0
 */

const TRADE_DESK_URL = 'http://localhost:8003';
const GOVERNOR_URL = 'http://localhost:8001';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_MODEL = 'anthropic/claude-3-5-haiku';
const FRONTIER_MODEL = 'anthropic/claude-sonnet-4-5-20250929';

const POLL_INTERVAL_MS = 15000;  // check for work every 15 seconds
const MAX_CONCURRENT = 1;        // one work item at a time per service (Phase 0.5)

let activeJobs = 0;
let totalProcessed = 0;
let totalFailed = 0;
let workerRunning = false;

// ─── LLM Client ──────────────────────────────────────────────────────────────

/**
 * Call an LLM via OpenRouter.
 *
 * @param {Object} options
 * @param {string} options.prompt - The user message
 * @param {string} [options.system] - System prompt
 * @param {string} [options.model] - OpenRouter model ID (default: haiku)
 * @param {number} [options.maxTokens] - Max response tokens (default: 2048)
 * @param {number} [options.temperature] - Temperature (default: 0.3)
 * @returns {Promise<{content: string, model: string, tokens: {prompt: number, completion: number, total: number}, cost: number}>}
 */
async function callLLM(options = {}) {
  const {
    prompt,
    system,
    model = DEFAULT_MODEL,
    maxTokens = 2048,
    temperature = 0.3
  } = options;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set in environment. Source ~/bin/load-keys.sh before starting PM2.');
  }

  const messages = [];
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: prompt });

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://economyclaw.local',
      'X-Title': 'EconomyClaw Supply Economy'
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature
    })
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenRouter API error (${res.status}): ${errBody}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error('OpenRouter returned no choices');
  }

  return {
    content: choice.message.content,
    model: data.model || model,
    tokens: {
      prompt: data.usage?.prompt_tokens || 0,
      completion: data.usage?.completion_tokens || 0,
      total: data.usage?.total_tokens || 0
    },
    cost: data.usage?.cost || 0,
    provider: data.provider || 'unknown'
  };
}

// ─── Trade Desk Integration ──────────────────────────────────────────────────

/**
 * Fetch work items assigned to this service from the Trade Desk.
 */
async function fetchAssignedWork(serviceName) {
  try {
    const res = await fetch(`${TRADE_DESK_URL}/requests?status=assigned`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];

    const data = await res.json();
    return (data.requests || []).filter(r => r.assigned_to === serviceName);
  } catch (err) {
    // Trade Desk unavailable — not fatal, we'll try again next poll
    return [];
  }
}

/**
 * Get full details of a specific request from Trade Desk.
 */
async function getRequestDetails(requestId) {
  try {
    const res = await fetch(`${TRADE_DESK_URL}/requests/${requestId}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/**
 * Mark a Trade Desk request as completed.
 */
async function completeRequest(requestId, result, serviceName) {
  try {
    const res = await fetch(`${TRADE_DESK_URL}/requests/${requestId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result,
        completed_by: serviceName
      })
    });
    return res.ok;
  } catch (err) {
    console.error(`[worker] Failed to complete request ${requestId}: ${err.message}`);
    return false;
  }
}

/**
 * Mark a Trade Desk request as failed.
 */
async function failRequest(requestId, reason, serviceName) {
  try {
    const res = await fetch(`${TRADE_DESK_URL}/requests/${requestId}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason,
        failed_by: serviceName
      })
    });
    return res.ok;
  } catch (err) {
    console.error(`[worker] Failed to report failure for ${requestId}: ${err.message}`);
    return false;
  }
}

// ─── Governor Integration ────────────────────────────────────────────────────

/**
 * Update a Governor work package's progress.
 */
async function updateWorkPackageProgress(workPackageId, updates) {
  try {
    const res = await fetch(`${GOVERNOR_URL}/work-packages/${workPackageId}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    return res.ok;
  } catch (err) {
    // Governor unavailable — non-fatal
    return false;
  }
}

/**
 * Post a clarifying question to the Governor for the human.
 */
async function askQuestion(question, context = {}) {
  try {
    const res = await fetch(`${GOVERNOR_URL}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        asked_by: context.serviceName || 'unknown',
        work_package_id: context.workPackageId || null,
        context: context.detail || '',
        options: context.options || []
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.question_id || null;
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ─── Worker Loop ─────────────────────────────────────────────────────────────

/**
 * Start the worker polling loop.
 *
 * @param {Object} config
 * @param {string} config.serviceName - Name of this service (must match Trade Desk assignment)
 * @param {number} config.port - Port this service runs on
 * @param {Function} config.handler - async function(workItem, tools) that processes a work item
 *   workItem: the full Trade Desk request object
 *   tools: { callLLM, askQuestion, updateWorkPackageProgress }
 * @param {number} [config.pollInterval] - Poll interval in ms (default: 15000)
 * @param {number} [config.maxConcurrent] - Max concurrent jobs (default: 1)
 */
function startWorker(config) {
  const {
    serviceName,
    port,
    handler,
    pollInterval = POLL_INTERVAL_MS,
    maxConcurrent = MAX_CONCURRENT
  } = config;

  if (workerRunning) {
    console.warn(`[worker:${serviceName}] Worker already running`);
    return;
  }

  workerRunning = true;
  console.log(`[worker:${serviceName}] Worker started — polling every ${pollInterval / 1000}s`);

  // Check for API key on startup
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn(`[worker:${serviceName}] WARNING: OPENROUTER_API_KEY not set. LLM calls will fail.`);
  } else {
    console.log(`[worker:${serviceName}] OpenRouter API key detected`);
  }

  const tools = {
    callLLM,
    askQuestion: (question, ctx = {}) => askQuestion(question, { serviceName, ...ctx }),
    updateWorkPackageProgress
  };

  async function poll() {
    if (activeJobs >= maxConcurrent) return;

    try {
      const assigned = await fetchAssignedWork(serviceName);

      for (const item of assigned) {
        if (activeJobs >= maxConcurrent) break;

        activeJobs++;
        console.log(`[worker:${serviceName}] Processing ${item.id}: ${item.capability}`);

        // Get full details
        const fullItem = await getRequestDetails(item.id) || item;

        try {
          const result = await handler(fullItem, tools);
          await completeRequest(item.id, result, serviceName);
          totalProcessed++;
          console.log(`[worker:${serviceName}] Completed ${item.id}`);
        } catch (err) {
          console.error(`[worker:${serviceName}] Failed ${item.id}: ${err.message}`);
          await failRequest(item.id, err.message, serviceName);
          totalFailed++;
        } finally {
          activeJobs--;
        }
      }
    } catch (err) {
      console.error(`[worker:${serviceName}] Poll error: ${err.message}`);
    }
  }

  // Start polling
  setInterval(poll, pollInterval);

  // Also poll once immediately after a short delay (let Express start first)
  setTimeout(poll, 3000);

  return {
    getStats: () => ({
      running: workerRunning,
      active_jobs: activeJobs,
      total_processed: totalProcessed,
      total_failed: totalFailed
    })
  };
}

// ─── Express Endpoint Mixin ──────────────────────────────────────────────────

/**
 * Add worker status endpoints to an Express app.
 */
function addWorkerEndpoints(app, serviceName) {
  app.get('/worker/status', (req, res) => {
    res.json({
      service: serviceName,
      worker: {
        running: workerRunning,
        active_jobs: activeJobs,
        total_processed: totalProcessed,
        total_failed: totalFailed,
        has_api_key: !!process.env.OPENROUTER_API_KEY
      }
    });
  });

  // Manual trigger to process work immediately (useful for testing)
  app.post('/worker/poll', async (req, res) => {
    const assigned = await fetchAssignedWork(serviceName);
    res.json({
      assigned_items: assigned.length,
      items: assigned.map(a => ({ id: a.id, capability: a.capability }))
    });
  });
}

module.exports = {
  callLLM,
  startWorker,
  addWorkerEndpoints,
  askQuestion,
  updateWorkPackageProgress,
  completeRequest,
  failRequest,
  DEFAULT_MODEL,
  FRONTIER_MODEL
};
