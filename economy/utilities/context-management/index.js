const express = require('express');
const fs = require('fs');
const path = require('path');
const { startWorker, addWorkerEndpoints } = require('../../services/worker');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8021;
const SERVICE_NAME = 'context-management';
const SECTOR = 'utilities';

const state = {
  started: new Date().toISOString(),
  maturity: 'observe',
  requests_handled: 0
};

// ── Health Check ──
app.get('/health', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    sector: SECTOR,
    status: 'healthy',
    uptime: process.uptime(),
    maturity: state.maturity,
    requests_handled: state.requests_handled,
    timestamp: new Date().toISOString()
  });
});

// ── Service Info ──
app.get('/info', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    sector: SECTOR,
    port: PORT,
    role: 'Context lifecycle, isolation boundaries, state management',
    maturity: state.maturity,
    started: state.started
  });
});

// ── Worker Endpoints ──
addWorkerEndpoints(app, SERVICE_NAME);

// ── Work Package Handler ──
async function handleWork(workItem, tools) {
  const { capability, payload, description } = workItem;
  console.log(`[${SERVICE_NAME}] Handling work: ${capability} — ${description}`);

  const response = await tools.callLLM({
    system: `You are the Context Management service in the EconomyClaw Supply Economy. Your domain is context lifecycle management, isolation boundaries between operational contexts, and state management across service interactions.

You ensure:
- Contexts (consulting, trading, R&D) remain properly isolated
- Context state is preserved across service restarts and handoffs
- Context windows for LLM interactions are optimized and tracked
- Cross-context contamination is detected and prevented
- Per Promise Theory P23, context boundaries are promises — each service promises to respect them, you provide the enforcement mechanisms

Be specific and actionable. Produce concrete deliverables.`,
    prompt: `Work package assigned to you:
- Capability: ${capability}
- Description: ${description || 'No description'}
- Payload: ${JSON.stringify(payload || {}, null, 2)}

Analyze this work package. What concrete steps should Context Management take? What deliverables will you produce? What do you need from other services?`,
    maxTokens: 1024
  });

  state.requests_handled++;

  if (payload?.work_package_id) {
    await tools.updateWorkPackageProgress(payload.work_package_id, {
      status: 'in_progress', progress_pct: 25, assigned_services: [SERVICE_NAME],
      notes: [`Initial assessment complete. Plan: ${response.content.substring(0, 200)}...`]
    });
  }

  return {
    assessment: response.content, model_used: response.model,
    tokens_used: response.tokens, cost: response.cost, produced_by: SERVICE_NAME
  };
}

// ── Self-register ──
async function selfRegister() {
  try {
    await fetch('http://localhost:8099/services/' + SERVICE_NAME + '/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online' })
    });
    console.log('[' + SERVICE_NAME + '] Registered with Service Registry');
  } catch (err) {
    console.log('[' + SERVICE_NAME + '] Registry not available yet — will retry');
  }
}

app.listen(PORT, () => {
  console.log('[' + SERVICE_NAME + '] Running on port ' + PORT + ' | Sector: ' + SECTOR);
  setTimeout(selfRegister, 2000);
  startWorker({ serviceName: SERVICE_NAME, port: PORT, handler: handleWork });
});
