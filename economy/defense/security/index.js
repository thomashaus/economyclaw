const express = require('express');
const fs = require('fs');
const path = require('path');
const { startWorker, addWorkerEndpoints, callLLM } = require('../../services/worker');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8010;
const SERVICE_NAME = 'security';
const SECTOR = 'defense';

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
    role: 'Authentication, authorization, threat detection',
    maturity: state.maturity,
    started: state.started
  });
});

// ── Worker Endpoints ──
addWorkerEndpoints(app, SERVICE_NAME);

// ── Work Package Handler ──
// This is where the service does its actual work when assigned a package from the Trade Desk.
async function handleWork(workItem, tools) {
  const { capability, payload, description } = workItem;

  console.log(`[${SERVICE_NAME}] Handling work: ${capability} — ${description}`);

  // Use LLM to reason about the work package
  const response = await tools.callLLM({
    system: `You are the Security service in the EconomyClaw Supply Economy. Your domain is authentication, authorization, encryption, threat detection, and audit trails. You operate under Promise Theory — you can only promise about your own behavior, never command other services.

When given a work package, you should:
1. Analyze what's being asked
2. Break it into concrete deliverables you can produce
3. Identify what you need from other services (as requests, not commands)
4. Produce an initial assessment or plan

Be specific and actionable. This is a real system being built, not a theoretical exercise.`,
    prompt: `Work package assigned to you:
- Capability: ${capability}
- Description: ${description || 'No description'}
- Payload: ${JSON.stringify(payload || {}, null, 2)}

Analyze this work package. What concrete steps should the Security service take? What deliverables will you produce? What do you need from other services?`,
    model: 'anthropic/claude-3-5-haiku',
    maxTokens: 1024
  });

  state.requests_handled++;

  // Update Governor work package if we have a work_package_id in the payload
  if (payload?.work_package_id) {
    await tools.updateWorkPackageProgress(payload.work_package_id, {
      status: 'in_progress',
      progress_pct: 25,
      assigned_services: [SERVICE_NAME],
      notes: [`Initial assessment complete. Plan: ${response.content.substring(0, 200)}...`]
    });
  }

  return {
    assessment: response.content,
    model_used: response.model,
    tokens_used: response.tokens,
    cost: response.cost,
    next_steps: 'Assessment complete. Awaiting human review or follow-up work packages.',
    produced_by: SERVICE_NAME
  };
}

// ── Self-register with registry on startup ──
async function selfRegister() {
  try {
    await fetch('http://localhost:8099/services/' + SERVICE_NAME + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  // Start the worker — polls Trade Desk for assigned work
  startWorker({
    serviceName: SERVICE_NAME,
    port: PORT,
    handler: handleWork
  });
});
