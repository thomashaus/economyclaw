module.exports = {
  apps: [
    { name: "market-data",      script: "./market-data/index.js",      port: 8110 },
    { name: "heatseeker",       script: "./heatseeker/index.js",       port: 8111 },
    { name: "risk-management",  script: "./risk-management/index.js",  port: 8112 },
    { name: "trade-approval",   script: "./trade-approval/index.js",   port: 8113 },
    { name: "trade-execution",  script: "./trade-execution/index.js",  port: 8114 },
  ].map(app => ({
    ...app,
    cwd: "/Users/danbozicevich/trading",
    env: { NODE_ENV: "production", PORT: app.port },
    max_memory_restart: "512M",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: `./logs/${app.name}-error.log`,
    out_file: `./logs/${app.name}-out.log`,
    merge_logs: true,
  })),
};
