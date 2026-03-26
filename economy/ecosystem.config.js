module.exports = {
apps: [
// ─── Supply Economy Services (12) ─────────────────────────────────────
{ name: "service-registry", script: "./services/registry-server.js", port: 8099, sector: "supply" },
{ name: "security", script: "./defense/security/index.js", port: 8010, sector: "supply" },
{ name: "iam", script: "./utilities/iam/index.js", port: 8020, sector: "supply" },
{ name: "data-governance", script: "./defense/data-governance/index.js", port: 8011, sector: "supply" },
{ name: "context-mgmt", script: "./utilities/context-management/index.js", port: 8021, sector: "supply" },
{ name: "backup-dr", script: "./defense/backup-dr/index.js", port: 8012, sector: "supply" },
{ name: "trust-scoring", script: "./regulatory/trust-scoring/index.js", port: 8030, sector: "supply" },
{ name: "observability", script: "./regulatory/perf-observability/index.js", port: 8032, sector: "supply" },
{ name: "treasury", script: "./chamber/treasury/index.js", port: 8002, sector: "supply" },
{ name: "trade-desk", script: "./chamber/trade-desk/index.js", port: 8003, sector: "supply" },
{ name: "governor", script: "./chamber/governor/index.js", port: 8001, sector: "supply" },
{ name: "entrepreneurial", script: "./regulatory/entrepreneurial-agent/index.js", port: 8031, sector: "supply" },
// ─── Trading Services (5) ─────────────────────────────────────────────
{ name: "market-data", script: "./trading/market-data/index.js", port: 8110, sector: "trading" },
{ name: "heatseeker", script: "./trading/heatseeker/index.js", port: 8111, sector: "trading" },
{ name: "risk-management", script: "./trading/risk-management/index.js", port: 8112, sector: "trading" },
{ name: "trade-approval", script: "./trading/trade-approval/index.js", port: 8113, sector: "trading" },
{ name: "trade-execution", script: "./trading/trade-execution/index.js", port: 8114, sector: "trading" },
].map(function(app) {
return {
name: app.name,
script: app.script,
cwd: "/Users/danbozicevich/economy",
env: { NODE_ENV: "production", PORT: app.port },
max_memory_restart: app.sector === "trading" ? "512M" : "256M",
log_date_format: "YYYY-MM-DD HH:mm:ss Z",
error_file: "./services/logs/" + app.name + "-error.log",
out_file: "./services/logs/" + app.name + "-out.log",
merge_logs: true
};
})
};
