// ─── Trading (Demand Economy) — PM2 Ecosystem Config ─────────────────────────
// 5 trading services: the demand-side consumer of the supply economy.
// These services define WHAT capabilities are needed; the supply economy
// determines HOW to deliver them via work packages and the Trade Desk.
//
// Relationship to supply economy:
//   - Communicates via HTTP only (no shared code, no shared process tree)
//   - Posts telemetry events to treasury (P&L) and observability (metrics)
//   - Submits work packages to Trade Desk for supply services to action
//   - Supply economy has NO knowledge of trading internals
//
// Pipeline: market-data → heatseeker → trade-approval → risk-management → trade-execution

module.exports = {
  apps: [

    // ── Data & Signals ────────────────────────────────────────────────────────
    { name: "market-data",      script: "./market-data/index.js",      port: 8110 },
    { name: "heatseeker",       script: "./heatseeker/index.js",       port: 8111 },

    // ── Risk & Approval ───────────────────────────────────────────────────────
    { name: "risk-management",  script: "./risk-management/index.js",  port: 8112 },
    { name: "trade-approval",   script: "./trade-approval/index.js",   port: 8113 },

    // ── Execution ─────────────────────────────────────────────────────────────
    { name: "trade-execution",  script: "./trade-execution/index.js",  port: 8114 },

  ].map(app => ({
    ...app,
    cwd: "/Users/danbozicevich/trading",
    env: { NODE_ENV: "production", PORT: app.port },
    max_memory_restart: "512M",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: `./logs/${app.name}-error.log`,
    out_file:   `./logs/${app.name}-out.log`,
    merge_logs: true,
  })),
};
