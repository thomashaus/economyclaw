// ─── Chief of Staff — PM2 Ecosystem Config ───────────────────────────────────
// Demand economy orchestrator. Single service — the analog of Governor for the
// demand side. Trading services, and future outcomes (consulting, incubator, R&D)
// register with CoS, not with the supply economy registry.

module.exports = {
  apps: [
    { name: "chief-of-staff", script: "./index.js", port: 8200 }
  ].map(app => ({
    ...app,
    cwd: "/Users/danbozicevich/chief-of-staff",
    env: { NODE_ENV: "production", PORT: app.port },
    max_memory_restart: "256M",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: `./logs/${app.name}-error.log`,
    out_file:   `./logs/${app.name}-out.log`,
    merge_logs: true,
  })),
};
