// ─── Supply Economy — PM2 Ecosystem Config ───────────────────────────────────
// 12 supply services: provide capabilities ON DEMAND to any consumer.
// Consumers submit work packages via the Trade Desk; services poll and execute.
// Governed by the Governor. Trust tracked by Trust Scoring.
//
// Demand-side consumers (e.g., trading sector) live in /trading — NOT here.
// Supply ↔ Demand boundary is HTTP only. No shared code, no shared process tree.

module.exports = {
  apps: [

    // ── Chamber (3) — orchestration, clearing, coordination ───────────────────
    { name: "governor",          script: "./chamber/governor/index.js",          port: 8001 },
    { name: "treasury",          script: "./chamber/treasury/index.js",          port: 8002 },
    { name: "trade-desk",        script: "./chamber/trade-desk/index.js",        port: 8003 },

    // ── Defense (3) — data protection, security, continuity ──────────────────
    { name: "security",          script: "./defense/security/index.js",          port: 8010 },
    { name: "data-governance",   script: "./defense/data-governance/index.js",   port: 8011 },
    { name: "backup-dr",         script: "./defense/backup-dr/index.js",         port: 8012 },

    // ── Utilities (2) — identity, context ────────────────────────────────────
    { name: "iam",               script: "./utilities/iam/index.js",             port: 8020 },
    { name: "context-mgmt",      script: "./utilities/context-management/index.js", port: 8021 },

    // ── Regulatory (3) — trust, observability, growth ────────────────────────
    { name: "trust-scoring",     script: "./regulatory/trust-scoring/index.js",  port: 8030 },
    { name: "entrepreneurial",   script: "./regulatory/entrepreneurial-agent/index.js", port: 8031 },
    { name: "observability",     script: "./regulatory/perf-observability/index.js",    port: 8032 },

    // ── Infrastructure (1) ────────────────────────────────────────────────────
    { name: "service-registry",  script: "./services/registry-server.js",        port: 8099 },

  ].map(app => ({
    ...app,
    cwd: process.env.ECONOMY_CWD || __dirname,
    env: { NODE_ENV: "production", PORT: app.port },
    max_memory_restart: "256M",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: `./services/logs/${app.name}-error.log`,
    out_file:   `./services/logs/${app.name}-out.log`,
    merge_logs: true,
  })),
};
