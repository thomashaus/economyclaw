const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8020;
const SERVICE_NAME = 'iam';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Token Store (in-memory, persisted to file) ───────────────────────────

let tokens = {};        // { serviceName: { token, issuedAt, expiresAt } }
let accessLog = [];     // last 500 access decisions
let stats = { allowed: 0, denied: 0, total: 0 };

const TOKENS_FILE = path.join(__dirname, config.persistence.file);
try {
  if (fs.existsSync(TOKENS_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    tokens = data.tokens || {};
    stats = data.stats || stats;
    console.log(`[iam] Loaded ${Object.keys(tokens).length} service tokens from disk`);
  }
} catch (err) {
  console.error(`[iam] Failed to load persisted tokens: ${err.message}`);
}

// ─── Helper Functions ──────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function generateToken() {
  return crypto.randomBytes(config.tokens.secret_length).toString('hex');
}

function isTokenValid(serviceName, token) {
  const entry = tokens[serviceName];
  if (!entry) return false;
  if (entry.token !== token) return false;
  if (new Date(entry.expiresAt) < new Date()) return false;
  return true;
}

function logAccess(caller, target, endpoint, method, allowed, reason) {
  const entry = {
    timestamp: now(),
    caller,
    target,
    endpoint,
    method,
    allowed,
    reason
  };
  accessLog.push(entry);
  if (accessLog.length > 500) {
    accessLog = accessLog.slice(-500);
  }
  stats.total++;
  if (allowed) stats.allowed++;
  else stats.denied++;

  // Append to audit file
  try {
    const auditFile = path.join(__dirname, '..', '..', 'services', 'audit', 'iam.log');
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Non-fatal
  }
}

function matchEndpoint(pattern, endpoint) {
  if (pattern === '*') return true;
  if (pattern === endpoint) return true;
  // Wildcard suffix: "/scores/*" matches "/scores/governor"
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1); // "/scores/"
    return endpoint.startsWith(prefix);
  }
  return false;
}

function matchMethod(pattern, method) {
  if (pattern === '*') return true;
  return pattern.toUpperCase() === method.toUpperCase();
}

function checkPolicy(caller, target, endpoint, method) {
  const policies = config.access_policies.policies;

  // Check explicit policies first (most specific wins)
  for (const policy of policies) {
    const callerMatch = policy.caller === '*' || policy.caller === caller;
    const targetMatch = policy.target === '*' || policy.target === target;
    const endpointMatch = policy.endpoints.some(p => matchEndpoint(p, endpoint));
    const methodMatch = policy.methods.some(m => matchMethod(m, method));

    if (callerMatch && targetMatch && endpointMatch && methodMatch) {
      return { allowed: policy.allow, reason: policy.note || 'policy match' };
    }
  }

  // Default policy
  if (config.access_policies.default_policy === 'allow_registered') {
    // In Phase 0.5, allow any registered service to call any other
    if (tokens[caller]) {
      return { allowed: true, reason: 'default_policy: allow_registered (Phase 0.5)' };
    }
    return { allowed: false, reason: 'caller not registered' };
  }

  return { allowed: false, reason: 'no matching policy, default deny' };
}

// ─── Persistence ───────────────────────────────────────────────────────────

function persist() {
  try {
    // Never persist actual token values to disk in plaintext
    // In Phase 0.5, we store token hashes for validation
    const safeTokens = {};
    for (const [name, entry] of Object.entries(tokens)) {
      safeTokens[name] = {
        tokenHash: crypto.createHash('sha256').update(entry.token).digest('hex').slice(0, 16),
        token: entry.token, // Phase 0.5: stored for simplicity. Phase 1: encrypt at rest
        issuedAt: entry.issuedAt,
        expiresAt: entry.expiresAt
      };
    }
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({ tokens: safeTokens, stats, savedAt: now() }, null, 2));
  } catch (err) {
    console.error(`[iam] Persist failed: ${err.message}`);
  }
}

setInterval(persist, config.persistence.save_interval_ms);

// ─── API Endpoints ─────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    status: 'healthy',
    timestamp: now(),
    registered_services: Object.keys(tokens).length,
    stats
  });
});

// Service info
app.get('/info', (req, res) => {
  res.json({
    name: SERVICE_NAME,
    sector: 'utilities',
    port: PORT,
    version: config.version,
    maturity: 'manual',
    description: 'Service identity verification and cross-service authorization. Zero-trust, fail-closed.',
    endpoints: [
      'GET /health',
      'GET /info',
      'POST /token/issue — issue a service token (on startup)',
      'POST /token/validate — validate a service token',
      'POST /authorize — check if caller can access target endpoint',
      'GET /policies — access control matrix (Governor only)',
      'GET /access-log — recent access decisions'
    ]
  });
});

// Issue a service token (called by services on startup)
app.post('/token/issue', (req, res) => {
  const { service, port } = req.body;

  if (!service) {
    return res.status(400).json({ error: 'Required: service name' });
  }

  const token = generateToken();
  const issuedAt = now();
  const expiresAt = new Date(Date.now() + config.tokens.expiry_hours * 3600000).toISOString();

  tokens[service] = { token, issuedAt, expiresAt, port };

  logAccess(service, 'iam', '/token/issue', 'POST', true, 'token issued');
  console.log(`[iam] Token issued for: ${service} (expires: ${expiresAt})`);

  res.json({
    service,
    token,
    issued_at: issuedAt,
    expires_at: expiresAt,
    _warning: 'Store this token securely. It will not be returned again.'
  });
});

// Validate a token
app.post('/token/validate', (req, res) => {
  const { service, token } = req.body;

  if (!service || !token) {
    return res.status(400).json({ error: 'Required: service, token' });
  }

  const valid = isTokenValid(service, token);

  res.json({
    service,
    valid,
    ...(valid ? {} : { reason: tokens[service] ? 'invalid or expired token' : 'service not registered' })
  });
});

// Authorization check (is caller allowed to access target endpoint?)
app.post('/authorize', (req, res) => {
  const { caller, caller_token, target, endpoint, method } = req.body;

  if (!caller || !target || !endpoint) {
    return res.status(400).json({
      error: 'Required: caller, target, endpoint',
      example: {
        caller: 'governor',
        caller_token: '(optional in Phase 0.5)',
        target: 'trust-scoring',
        endpoint: '/scores',
        method: 'GET'
      }
    });
  }

  const reqMethod = method || 'GET';

  // Phase 0.5: Token validation is optional (services may not have tokens yet)
  // Phase 1: Token validation will be mandatory
  if (caller_token && !isTokenValid(caller, caller_token)) {
    logAccess(caller, target, endpoint, reqMethod, false, 'invalid token');
    return res.json({ allowed: false, reason: 'invalid or expired token' });
  }

  const decision = checkPolicy(caller, target, endpoint, reqMethod);
  logAccess(caller, target, endpoint, reqMethod, decision.allowed, decision.reason);

  res.json({
    caller,
    target,
    endpoint,
    method: reqMethod,
    allowed: decision.allowed,
    reason: decision.reason
  });
});

// Access control matrix (Governor only in Phase 1; open in Phase 0.5)
app.get('/policies', (req, res) => {
  res.json({
    _iam_note: 'Phase 0.5: open access. Phase 1: restricted to Governor.',
    default_policy: config.access_policies.default_policy,
    policies: config.access_policies.policies,
    registered_services: Object.keys(tokens)
  });
});

// Recent access log
app.get('/access-log', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    entries: accessLog.slice(-limit),
    total: accessLog.length,
    stats
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
    console.log(`[iam] Registered with Service Registry`);
  } catch (err) {
    console.log(`[iam] Registry not available (will retry): ${err.message}`);
  }

  // Issue own token
  tokens[SERVICE_NAME] = {
    token: generateToken(),
    issuedAt: now(),
    expiresAt: new Date(Date.now() + config.tokens.expiry_hours * 3600000).toISOString(),
    port: PORT
  };
}

process.on('SIGTERM', () => { persist(); process.exit(0); });
process.on('SIGINT', () => { persist(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`[iam] Running on port ${PORT}`);
  selfRegister();
});
