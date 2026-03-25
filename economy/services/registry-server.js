const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = 8099;

const REGISTRY_PATH = path.join(__dirname, 'registry.json');

app.get('/health', (req, res) => {
  res.json({ service: 'registry', status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/services', (req, res) => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  res.json(registry);
});

app.get('/services/:name', (req, res) => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const svc = registry.services[req.params.name];
  if (!svc) return res.status(404).json({ error: `Service ${req.params.name} not found` });
  res.json({ name: req.params.name, ...svc });
});

// Services self-register or update status
app.post('/services/:name/status', (req, res) => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  if (!registry.services[req.params.name]) {
    return res.status(404).json({ error: `Service ${req.params.name} not found` });
  }
  registry.services[req.params.name].status = req.body.status || 'unknown';
  registry.services[req.params.name].last_seen = new Date().toISOString();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  res.json({ updated: req.params.name, status: registry.services[req.params.name] });
});

app.listen(PORT, () => console.log(`[Service Registry] Running on port ${PORT}`));
