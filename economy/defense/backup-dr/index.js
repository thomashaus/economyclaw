const express = require('express');
const fs = require('fs');
const path = require('path');
const { startWorker, addWorkerEndpoints } = require('../../services/worker');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8012;
const SERVICE_NAME = 'backup-dr';
const SECTOR = 'defense';

const state = { started: new Date().toISOString(), maturity: 'observe', requests_handled: 0 };

app.get('/health', (req, res) => {
  res.json({ service: SERVICE_NAME, sector: SECTOR, status: 'healthy', uptime: process.uptime(),
    maturity: state.maturity, requests_handled: state.requests_handled, timestamp: new Date().toISOString() });
});

app.get('/info', (req, res) => {
  res.json({ service: SERVICE_NAME, sector: SECTOR, port: PORT,
    role: 'Backup orchestration, disaster recovery, state preservation',
    maturity: state.maturity, started: state.started });
});

addWorkerEndpoints(app, SERVICE_NAME);

async function handleWork(workItem, tools) {
  const { capability, payload, description } = workItem;
  console.log(`[${SERVICE_NAME}] Handling work: ${capability} — ${description}`);

  const response = await tools.callLLM({
    system: `You are the Backup & Disaster Recovery service in the EconomyClaw Supply Economy. Your domain is snapshots, recovery planning, and state preservation. Per Promise Theory P19, redundancy is the client's responsibility — you provide the mechanisms, but each service must wire its own backup strategy. Per P46, the economy survives agent failures through redundancy.

You handle: backup scheduling, recovery procedures, state preservation across restarts, DR planning for Mac Mini M4 infrastructure running PM2.

Be specific and actionable.`,
    prompt: `Work package assigned to you:\n- Capability: ${capability}\n- Description: ${description || 'No description'}\n- Payload: ${JSON.stringify(payload || {}, null, 2)}\n\nAnalyze this work package. What concrete steps should Backup & DR take? What deliverables will you produce?`,
    maxTokens: 1024
  });

  state.requests_handled++;
  if (payload?.work_package_id) {
    await tools.updateWorkPackageProgress(payload.work_package_id, {
      status: 'in_progress', progress_pct: 25, assigned_services: [SERVICE_NAME],
      notes: [`Initial assessment complete. Plan: ${response.content.substring(0, 200)}...`]
    });
  }
  return { assessment: response.content, model_used: response.model, tokens_used: response.tokens, cost: response.cost, produced_by: SERVICE_NAME };
}

async function selfRegister() {
  try {
    await fetch('http://localhost:8099/services/' + SERVICE_NAME + '/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'online' })
    });
    console.log('[' + SERVICE_NAME + '] Registered with Service Registry');
  } catch (err) { console.log('[' + SERVICE_NAME + '] Registry not available yet — will retry'); }
}

app.listen(PORT, () => {
  console.log('[' + SERVICE_NAME + '] Running on port ' + PORT + ' | Sector: ' + SECTOR);
  setTimeout(selfRegister, 2000);
  startWorker({ serviceName: SERVICE_NAME, port: PORT, handler: handleWork });
});
