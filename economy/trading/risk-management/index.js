const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8112;
const SERVICE_NAME = 'risk-management';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Risk State ──────────────────────────────────────────────────────────────

let dailyPnL = 0;                // running P&L for today (dollars)
let dailyTradeCount = 0;         // trades executed today
let consecutiveLosses = 0;       // streak counter
let cooldownUntil = null;        // timestamp when cooldown expires
let openPositions = [];           // currently open positions
let tradeLog = [];                // today's trade history
let accountBalance = null;        // set from external source or manual
let riskEvents = [];              // audit trail of risk decisions

// Reset daily state at midnight CT
function scheduleDailyReset() {
  const resetDaily = () => {
    dailyPnL = 0;
    dailyTradeCount = 0;
    consecutiveLosses = 0;
    cooldownUntil = null;
    openPositions = [];
    tradeLog = [];
    riskEvents = [];
    console.log('[risk-management] Daily reset completed at ' + now());
  };

  // Calculate ms until next midnight CT
  const ct = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const d = new Date(ct);
  const msUntilMidnight = ((24 - d.getHours()) * 3600 - d.getMinutes() * 60 - d.getSeconds()) * 1000;

  setTimeout(() => {
    resetDaily();
    // Then reset every 24 hours
    setInterval(resetDaily, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function generateEventId() {
  return 'RE-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
}

async function getMarketStatus() {
  try {
    const res = await fetch(config.market_data_url + '/market-status', {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return await res.json();
  } catch (err) {}
  return { status: 'unknown', heatseeker_window: false };
}

function getStageConfig() {
  return config.topstep_stages[config.active_stage];
}

function isMicro(symbol) {
  const inst = config.instruments[symbol];
  return inst && inst.micro === true;
}

function logRiskEvent(type, decision, details) {
  const event = {
    id: generateEventId(),
    type,
    decision,
    details,
    timestamp: now()
  };
  riskEvents.push(event);
  if (riskEvents.length > 500) riskEvents = riskEvents.slice(-500);
  console.log('[risk-management] ' + decision + ': ' + type + ' — ' + (details.reason || ''));
  return event;
}

// ─── Core Risk Check ─────────────────────────────────────────────────────────

async function evaluateTradeRisk(proposal) {
  const {
    symbol, direction, contracts, entry_price, stop_price, target_price,
    signal_id, source, map_grade
  } = proposal;

  const mkt = await getMarketStatus();
  const stage = getStageConfig();
  const isMarketHours = mkt.heatseeker_window;
  const violations = [];
  const warnings = [];

  // ── 1. Instrument validation ──
  const upperSymbol = symbol.toUpperCase();
  if (!config.instruments[upperSymbol]) {
    violations.push('Unknown instrument: ' + upperSymbol + '. Allowed: ES, MES, NQ, MNQ');
  }

  // ── 2. Off-hours restrictions ──
  if (!isMarketHours) {
    if (!config.off_hours_rules.allowed_instruments.includes(upperSymbol)) {
      violations.push('Off-hours: only MES and MNQ allowed. Got: ' + upperSymbol);
    }
    if (contracts > (config.off_hours_rules.max_contracts[upperSymbol] || 0)) {
      violations.push('Off-hours: max ' + config.off_hours_rules.max_contracts[upperSymbol] + ' contract(s) for ' + upperSymbol + '. Requested: ' + contracts);
    }
    if (openPositions.length >= config.off_hours_rules.max_concurrent_positions) {
      violations.push('Off-hours: max ' + config.off_hours_rules.max_concurrent_positions + ' concurrent position(s). Currently: ' + openPositions.length);
    }
    // Max loss per trade
    if (stop_price && entry_price) {
      const risk = Math.abs(entry_price - stop_price) * config.instruments[upperSymbol].multiplier * contracts;
      if (risk > config.off_hours_rules.max_loss_per_trade_dollars) {
        violations.push('Off-hours: max risk $' + config.off_hours_rules.max_loss_per_trade_dollars + ' per trade. This trade risks $' + risk.toFixed(2));
      }
    }
  }

  // ── 3. Market-hours restrictions ──
  if (isMarketHours) {
    if (!config.market_hours_rules.allowed_instruments.includes(upperSymbol)) {
      violations.push('Market hours: instrument ' + upperSymbol + ' not allowed');
    }
    if (openPositions.length >= config.market_hours_rules.max_concurrent_positions) {
      violations.push('Market hours: max ' + config.market_hours_rules.max_concurrent_positions + ' concurrent positions. Currently: ' + openPositions.length);
    }
    if (config.market_hours_rules.require_heatseeker_signal && source !== 'heatseeker_gex_vex') {
      warnings.push('Market hours: Heatseeker signal preferred. Source: ' + (source || 'unknown'));
    }
    if (map_grade) {
      const grades = ['A+', 'B', 'C', 'F'];
      const gradeIdx = grades.indexOf(map_grade);
      const minIdx = grades.indexOf(config.market_hours_rules.min_map_grade);
      if (gradeIdx > minIdx) {
        violations.push('Map grade ' + map_grade + ' below minimum ' + config.market_hours_rules.min_map_grade);
      }
    }
    // Max loss per trade
    if (stop_price && entry_price) {
      const risk = Math.abs(entry_price - stop_price) * config.instruments[upperSymbol].multiplier * contracts;
      if (risk > config.market_hours_rules.max_loss_per_trade_dollars) {
        violations.push('Market hours: max risk $' + config.market_hours_rules.max_loss_per_trade_dollars + ' per trade. This trade risks $' + risk.toFixed(2));
      }
    }
  }

  // ── 4. Topstep stage contract limits ──
  if (stage.max_contracts[upperSymbol] !== undefined) {
    if (contracts > stage.max_contracts[upperSymbol]) {
      violations.push('Topstep ' + config.active_stage + ': max ' + stage.max_contracts[upperSymbol] + ' contracts for ' + upperSymbol + '. Requested: ' + contracts);
    }
  }

  // ── 5. R:R ratio check ──
  if (entry_price && stop_price && target_price) {
    const risk = Math.abs(entry_price - stop_price);
    const reward = Math.abs(target_price - entry_price);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < config.market_hours_rules.min_rr_ratio) {
      violations.push('R:R ratio ' + rr.toFixed(2) + ':1 below minimum ' + config.market_hours_rules.min_rr_ratio + ':1');
    }
  }

  // ── 6. Daily loss limit ──
  const dailyLimit = stage.daily_loss_limit;
  const usedPct = dailyLimit > 0 ? Math.abs(Math.min(dailyPnL, 0)) / dailyLimit : 0;
  if (usedPct >= config.global_rules.max_daily_loss_pct_of_limit) {
    violations.push('Daily loss approaching limit: $' + Math.abs(dailyPnL).toFixed(2) + ' of $' + dailyLimit + ' (' + (usedPct * 100).toFixed(0) + '% used)');
  }

  // ── 7. Max trades per day ──
  if (dailyTradeCount >= config.global_rules.max_trades_per_day) {
    violations.push('Max ' + config.global_rules.max_trades_per_day + ' trades per day reached. Count: ' + dailyTradeCount);
  }

  // ── 8. Cooldown check ──
  if (cooldownUntil && new Date() < new Date(cooldownUntil)) {
    const remaining = Math.ceil((new Date(cooldownUntil) - new Date()) / 60000);
    violations.push('Cooldown active: ' + remaining + ' minutes remaining after ' + config.global_rules.cooldown_after_consecutive_losses + ' consecutive losses');
  }

  // ── 9. Close-of-session guard ──
  if (isMarketHours) {
    const ct = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const d = new Date(ct);
    const minutesBeforeClose = (15 * 60) - (d.getHours() * 60 + d.getMinutes());
    if (minutesBeforeClose <= config.global_rules.no_trade_last_minutes_before_close) {
      violations.push('Within last ' + config.global_rules.no_trade_last_minutes_before_close + ' minutes before close. No new trades.');
    }
  }

  // ── 10. Max drawdown proximity ──
  if (accountBalance !== null && stage.max_drawdown) {
    // This is simplified — real drawdown depends on starting balance + trailing logic
    if (Math.abs(dailyPnL) > stage.max_drawdown * 0.8 && dailyPnL < 0) {
      violations.push('CRITICAL: Approaching max drawdown. Daily P&L: $' + dailyPnL.toFixed(2) + ', max drawdown: $' + stage.max_drawdown);
    }
  }

  // ── Decision ──
  const approved = violations.length === 0;
  const decision = approved ? 'APPROVED' : 'REJECTED';

  const event = logRiskEvent('trade_risk_check', decision, {
    symbol: upperSymbol,
    direction,
    contracts,
    entry_price,
    stop_price,
    target_price,
    signal_id,
    source,
    violations,
    warnings,
    daily_pnl: dailyPnL,
    daily_trades: dailyTradeCount,
    consecutive_losses: consecutiveLosses,
    market_status: mkt.status,
    is_market_hours: isMarketHours,
    topstep_stage: config.active_stage,
    reason: approved ? 'All checks passed' : violations[0]
  });

  return {
    approved,
    decision,
    risk_event_id: event.id,
    violations,
    warnings,
    risk_summary: {
      daily_pnl: dailyPnL,
      daily_trades: dailyTradeCount,
      consecutive_losses: consecutiveLosses,
      cooldown_active: cooldownUntil ? new Date() < new Date(cooldownUntil) : false,
      open_positions: openPositions.length,
      topstep_stage: config.active_stage,
      daily_loss_limit: stage.daily_loss_limit,
      daily_loss_used_pct: (usedPct * 100).toFixed(1) + '%'
    }
  };
}

// ─── Position Tracking ───────────────────────────────────────────────────────

function openPosition(trade) {
  const position = {
    id: 'POS-' + Date.now().toString(36),
    signal_id: trade.signal_id,
    symbol: trade.symbol.toUpperCase(),
    direction: trade.direction,
    contracts: trade.contracts,
    entry_price: trade.entry_price,
    stop_price: trade.stop_price,
    target_price: trade.target_price,
    opened_at: now(),
    status: 'open'
  };
  openPositions.push(position);
  dailyTradeCount++;
  tradeLog.push({ ...position, action: 'open' });
  logRiskEvent('position_opened', 'LOGGED', {
    position_id: position.id,
    symbol: position.symbol,
    direction: position.direction,
    contracts: position.contracts,
    entry_price: position.entry_price
  });
  return position;
}

function closePosition(positionId, exitPrice, reason) {
  const idx = openPositions.findIndex(p => p.id === positionId);
  if (idx === -1) return null;

  const position = openPositions[idx];
  const multiplier = config.instruments[position.symbol].multiplier;
  const pnlPerContract = position.direction === 'long'
    ? (exitPrice - position.entry_price) * multiplier
    : (position.entry_price - exitPrice) * multiplier;
  const totalPnL = pnlPerContract * position.contracts;

  position.exit_price = exitPrice;
  position.pnl = parseFloat(totalPnL.toFixed(2));
  position.closed_at = now();
  position.close_reason = reason || 'manual';
  position.status = 'closed';

  // Update daily P&L
  dailyPnL = parseFloat((dailyPnL + totalPnL).toFixed(2));

  // Track consecutive losses
  if (totalPnL < 0) {
    consecutiveLosses++;
    if (consecutiveLosses >= config.global_rules.cooldown_after_consecutive_losses) {
      const cooldownMs = config.global_rules.cooldown_minutes * 60 * 1000;
      cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
      logRiskEvent('cooldown_triggered', 'ENFORCED', {
        consecutive_losses: consecutiveLosses,
        cooldown_minutes: config.global_rules.cooldown_minutes,
        cooldown_until: cooldownUntil
      });
    }
  } else {
    consecutiveLosses = 0;
  }

  // Remove from open positions
  openPositions.splice(idx, 1);

  tradeLog.push({ ...position, action: 'close' });
  logRiskEvent('position_closed', 'LOGGED', {
    position_id: position.id,
    symbol: position.symbol,
    pnl: position.pnl,
    exit_price: exitPrice,
    reason,
    daily_pnl: dailyPnL,
    consecutive_losses: consecutiveLosses
  });

  return position;
}

// ─── API Endpoints ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  getMarketStatus().then(mkt => {
    res.json({
      service: SERVICE_NAME,
      status: 'healthy',
      timestamp: now(),
      market_status: mkt.status,
      topstep_stage: config.active_stage,
      daily_pnl: dailyPnL,
      daily_trades: dailyTradeCount,
      open_positions: openPositions.length,
      cooldown_active: cooldownUntil ? new Date() < new Date(cooldownUntil) : false
    });
  }).catch(() => {
    res.json({ service: SERVICE_NAME, status: 'healthy', timestamp: now() });
  });
});

app.get('/info', (req, res) => {
  res.json({
    name: SERVICE_NAME,
    sector: 'trading',
    port: PORT,
    version: config.version,
    maturity: 'observe',
    description: 'Risk management for ES/MES and NQ/MNQ trading. Topstep stage-aware limits, off-hours restrictions, daily loss tracking, cooldown enforcement.',
    active_stage: config.active_stage,
    endpoints: [
      'GET /health',
      'GET /info',
      'POST /check — evaluate trade risk (pre-trade check)',
      'GET /status — current risk state summary',
      'POST /position/open — register new open position',
      'POST /position/:id/close — close a position with exit price',
      'GET /positions — current open positions',
      'GET /trade-log — today\'s trade log',
      'GET /risk-events — audit trail of risk decisions',
      'POST /account-balance — set account balance',
      'POST /stage — change Topstep stage',
      'POST /reset-daily — manual daily reset (admin)'
    ]
  });
});

// Pre-trade risk check
app.post('/check', async (req, res) => {
  const { symbol, direction, contracts, entry_price, stop_price, target_price, signal_id, source, map_grade } = req.body;

  if (!symbol || !direction || !contracts || !entry_price) {
    return res.status(400).json({
      error: 'Required: symbol, direction, contracts, entry_price',
      recommended: 'Also provide: stop_price, target_price, signal_id, source, map_grade'
    });
  }

  const result = await evaluateTradeRisk(req.body);
  const statusCode = result.approved ? 200 : 403;
  res.status(statusCode).json(result);
});

// Current risk state
app.get('/status', async (req, res) => {
  const mkt = await getMarketStatus();
  const stage = getStageConfig();
  const isMarketHours = mkt.heatseeker_window;

  res.json({
    timestamp: now(),
    market_status: mkt.status,
    is_market_hours: isMarketHours,
    topstep_stage: config.active_stage,
    stage_label: stage.label,
    daily_pnl: dailyPnL,
    daily_trade_count: dailyTradeCount,
    max_trades_per_day: config.global_rules.max_trades_per_day,
    trades_remaining: Math.max(0, config.global_rules.max_trades_per_day - dailyTradeCount),
    consecutive_losses: consecutiveLosses,
    cooldown_active: cooldownUntil ? new Date() < new Date(cooldownUntil) : false,
    cooldown_until: cooldownUntil,
    open_positions: openPositions.length,
    open_position_details: openPositions,
    daily_loss_limit: stage.daily_loss_limit,
    daily_loss_used_pct: stage.daily_loss_limit > 0
      ? ((Math.abs(Math.min(dailyPnL, 0)) / stage.daily_loss_limit) * 100).toFixed(1) + '%'
      : '0%',
    max_drawdown: stage.max_drawdown,
    account_balance: accountBalance,
    mode: isMarketHours ? 'market_hours' : 'off_hours',
    allowed_instruments: isMarketHours
      ? config.market_hours_rules.allowed_instruments
      : config.off_hours_rules.allowed_instruments,
    max_contracts: isMarketHours
      ? stage.max_contracts
      : config.off_hours_rules.max_contracts
  });
});

// Open position
app.post('/position/open', (req, res) => {
  const { symbol, direction, contracts, entry_price, stop_price, target_price, signal_id } = req.body;
  if (!symbol || !direction || !contracts || !entry_price) {
    return res.status(400).json({ error: 'Required: symbol, direction, contracts, entry_price' });
  }
  const position = openPosition(req.body);
  res.status(201).json(position);
});

// Close position
app.post('/position/:id/close', (req, res) => {
  const { exit_price, reason } = req.body;
  if (exit_price === undefined) {
    return res.status(400).json({ error: 'Required: exit_price' });
  }
  const position = closePosition(req.params.id, parseFloat(exit_price), reason);
  if (!position) {
    return res.status(404).json({ error: 'Position not found: ' + req.params.id });
  }
  res.json(position);
});

// Open positions
app.get('/positions', (req, res) => {
  res.json({ positions: openPositions, count: openPositions.length });
});

// Trade log
app.get('/trade-log', (req, res) => {
  res.json({ trades: tradeLog, count: tradeLog.length, daily_pnl: dailyPnL });
});

// Risk events
app.get('/risk-events', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ events: riskEvents.slice(-limit), total: riskEvents.length });
});

// Set account balance
app.post('/account-balance', (req, res) => {
  const { balance } = req.body;
  if (balance === undefined) {
    return res.status(400).json({ error: 'Required: balance' });
  }
  accountBalance = parseFloat(balance);
  logRiskEvent('balance_updated', 'LOGGED', { balance: accountBalance });
  res.json({ account_balance: accountBalance, timestamp: now() });
});

// Change Topstep stage
app.post('/stage', (req, res) => {
  const { stage } = req.body;
  if (!config.topstep_stages[stage]) {
    return res.status(400).json({
      error: 'Unknown stage. Available: ' + Object.keys(config.topstep_stages).join(', ')
    });
  }
  const previous = config.active_stage;
  config.active_stage = stage;
  logRiskEvent('stage_changed', 'LOGGED', { previous, new_stage: stage });
  res.json({
    stage,
    label: config.topstep_stages[stage].label,
    previous,
    timestamp: now()
  });
});

// Manual daily reset (admin)
app.post('/reset-daily', (req, res) => {
  logRiskEvent('manual_reset', 'LOGGED', { daily_pnl: dailyPnL, trade_count: dailyTradeCount });
  dailyPnL = 0;
  dailyTradeCount = 0;
  consecutiveLosses = 0;
  cooldownUntil = null;
  openPositions = [];
  tradeLog = [];
  res.json({ message: 'Daily risk state reset', timestamp: now() });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function selfRegister() {
  try {
    await fetch(config.registry_url + '/services/' + SERVICE_NAME + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online', port: PORT })
    });
    console.log('[risk-management] Registered with Service Registry');
  } catch (err) {
    console.log('[risk-management] Registry not available: ' + err.message);
  }
}

app.listen(PORT, () => {
  console.log('[risk-management] Running on port ' + PORT + ' (stage: ' + config.active_stage + ')');
  selfRegister();
  scheduleDailyReset();
});
