// ─── EconomyClaw Agent Wrapper — PM2 Ecosystem Config ───────────────────────
// Paperclip cloud adapter. Bridges Paperclip issue workflow to the supply economy.
// Registers with Chief of Staff on startup (port 8200).

module.exports = {
  apps: [
    {
      name:   'agent-wrapper',
      script: './index.js',
      port:   8210,
    }
  ].map(app => ({
    ...app,
    cwd: `${__dirname}`,
    env: {
      NODE_ENV: 'production',
      PORT:     app.port,
      // Secrets should be set via environment or a secrets manager — not hardcoded here.
      // Copy .env.example to .env and source it, or inject via your deploy pipeline.
      PAPERCLIP_API_URL:     process.env.PAPERCLIP_API_URL     || 'https://team.tomhaus.cloud/',
      PAPERCLIP_API_KEY:     process.env.PAPERCLIP_API_KEY     || '',
      PAPERCLIP_AGENT_ID:    process.env.PAPERCLIP_AGENT_ID    || '25b834bf-798a-489e-ae16-e8b8fdc12628',
      PAPERCLIP_COMPANY_ID:  process.env.PAPERCLIP_COMPANY_ID  || '4dda4043-d49a-41a2-9517-508035fa6996',
    },
    max_memory_restart: '256M',
    log_date_format:    'YYYY-MM-DD HH:mm:ss Z',
    error_file: `./logs/${app.name}-error.log`,
    out_file:   `./logs/${app.name}-out.log`,
    merge_logs: true,
  })),
};
