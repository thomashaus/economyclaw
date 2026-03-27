const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8110;
const SERVICE_NAME = 'market-data';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Market Data Store ─────────────────────────────────────────────────────

let prices = {};          // { instrument: { last, bid, ask, timestamp } }
let candles = {};         // { instrument: [ { open, high, low, close, volume, timestamp } ] }
let sessionState = {};    // { instrument: { dayOpen, dayHigh, dayLow, gapSize, gapFilled } }
let marketStatus = 'closed';  // 'pre-market', 'rth', 'post-market', 'overnight', 'closed'

// Initialize instruments
for (const symbol of Object.keys(config.instruments)) {
  prices[symbol] = { last: 0, bid: 0, ask: 0, change: 0, changePct: 0, volume: 0, timestamp: null };
  candles[symbol] = [];
  sessionState[symbol] = { dayOpen: null, dayHigh: null, dayLow: null, prevClose: null, gapSize: null, gapFilled: false };
}

// ─── Helper Functions ──────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function getMarketStatus() {
  const ct = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const d = new Date(ct);
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const time = hours * 100 + minutes;
  const day = d.getDay(); // 0=Sun, 6=Sat

  // Weekends
  if (day === 0 || day === 6) return 'closed';

  // RTH: 8:30 AM - 3:00 PM CT
  if (time >= 830 && time < 1500) return 'rth';
  // Pre-market: 8:15 - 8:30 CT
  if (time >= 815 && time < 830) return 'pre-market';
  // Post-market: 3:00 - 4:00 CT
  if (time >= 1500 && time < 1600) return 'post-market';
  // Overnight: 5:00 PM - 8:15 AM CT (futures)
  if (time >= 1700 || time < 815) return 'overnight';

  return 'closed';
}

function isHeatSeekerWindow() {
  const status = getMarketStatus();
  return status === 'rth' || status === 'pre-market';
}

// ─── Simulated Data Provider ───────────────────────────────────────────────
// Used until TopstepX API creds are configured

const SIM_BASE_PRICES = { ES: 5850, MES: 5850, NQ: 20500, MNQ: 20500 };

function generateSimulatedTick(symbol) {
  const inst = config.instruments[symbol];
  const base = prices[symbol].last || SIM_BASE_PRICES[symbol] || 5000;
  const volatility = symbol.startsWith('N') ? 2.0 : 0.75; // NQ more volatile
  const change = (Math.random() - 0.5) * volatility;
  const rounded = Math.round(change / inst.tick_size) * inst.tick_size;
  const newPrice = parseFloat((base + rounded).toFixed(2));
  const spread = inst.tick_size;

  return {
    last: newPrice,
    bid: parseFloat((newPrice - spread / 2).toFixed(2)),
    ask: parseFloat((newPrice + spread / 2).toFixed(2)),
    volume: Math.floor(Math.random() * 100) + 1,
    timestamp: now()
  };
}

function updatePrice(symbol, tick) {
  const prev = prices[symbol];
  const dayOpen = sessionState[symbol].dayOpen || tick.last;

  prices[symbol] = {
    ...tick,
    change: parseFloat((tick.last - dayOpen).toFixed(2)),
    changePct: parseFloat(((tick.last - dayOpen) / dayOpen * 100).toFixed(3))
  };

  // Update session state
  if (!sessionState[symbol].dayOpen) {
    sessionState[symbol].dayOpen = tick.last;
    // Calculate gap
    if (sessionState[symbol].prevClose) {
      sessionState[symbol].gapSize = parseFloat((tick.last - sessionState[symbol].prevClose).toFixed(2));
    }
  }
  if (!sessionState[symbol].dayHigh || tick.last > sessionState[symbol].dayHigh) {
    sessionState[symbol].dayHigh = tick.last;
  }
  if (!sessionState[symbol].dayLow || tick.last < sessionState[symbol].dayLow) {
    sessionState[symbol].dayLow = tick.last;
  }

  // Check gap fill
  if (sessionState[symbol].gapSize && !sessionState[symbol].gapFilled) {
    const prevClose = sessionState[symbol].prevClose;
    if ((sessionState[symbol].gapSize > 0 && tick.last <= prevClose) ||
        (sessionState[symbol].gapSize < 0 && tick.last >= prevClose)) {
      sessionState[symbol].gapFilled = true;
      sessionState[symbol].gapFilledAt = now();
    }
  }

  // Build candle (1-minute)
  const lastCandle = candles[symbol][candles[symbol].length - 1];
  const candleTime = new Date();
  candleTime.setSeconds(0, 0);
  const candleTimestamp = candleTime.toISOString();

  if (lastCandle && lastCandle.timestamp === candleTimestamp) {
    lastCandle.high = Math.max(lastCandle.high, tick.last);
    lastCandle.low = Math.min(lastCandle.low, tick.last);
    lastCandle.close = tick.last;
    lastCandle.volume += tick.volume;
  } else {
    candles[symbol].push({
      open: tick.last,
      high: tick.last,
      low: tick.last,
      close: tick.last,
      volume: tick.volume,
      timestamp: candleTimestamp
    });
    // Keep only configured number of candles
    if (candles[symbol].length > config.history_candles_kept) {
      candles[symbol] = candles[symbol].slice(-config.history_candles_kept);
    }
  }
}

// ─── Data Feed Loop ────────────────────────────────────────────────────────

function startDataFeed() {
  if (config.data_sources.active === 'simulated') {
    console.log('[market-data] Running in SIMULATED mode');
    setInterval(() => {
      marketStatus = getMarketStatus();
      for (const symbol of Object.keys(config.instruments)) {
        const tick = generateSimulatedTick(symbol);
        updatePrice(symbol, tick);
      }
    }, config.snapshot_interval_ms);
  } else if (config.data_sources.active === 'topstepx') {
    console.log('[market-data] TopstepX mode — awaiting API configuration');
    // TODO: Connect to TopstepX SignalR streams via project-x-py bridge
    // For now, fall back to simulated
    config.data_sources.active = 'simulated';
    startDataFeed();
  }
}

// ─── Technical Analysis Helpers ────────────────────────────────────────────

function calculateSMA(symbol, period) {
  const bars = candles[symbol].slice(-period);
  if (bars.length < period) return null;
  const sum = bars.reduce((s, b) => s + b.close, 0);
  return parseFloat((sum / period).toFixed(2));
}

function calculateEMA(symbol, period) {
  const bars = candles[symbol];
  if (bars.length < period) return null;
  const k = 2 / (period + 1);
  let ema = bars[0].close;
  for (let i = 1; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

function calculateRSI(symbol, period) {
  const bars = candles[symbol].slice(-(period + 1));
  if (bars.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calculateVWAP(symbol) {
  const bars = candles[symbol];
  if (bars.length === 0) return null;
  let cumPV = 0, cumVol = 0;
  for (const bar of bars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    cumPV += tp * bar.volume;
    cumVol += bar.volume;
  }
  if (cumVol === 0) return null;
  return parseFloat((cumPV / cumVol).toFixed(2));
}

function getTechnicals(symbol) {
  return {
    sma_9: calculateSMA(symbol, 9),
    sma_20: calculateSMA(symbol, 20),
    sma_50: calculateSMA(symbol, 50),
    ema_9: calculateEMA(symbol, 9),
    ema_21: calculateEMA(symbol, 21),
    rsi_14: calculateRSI(symbol, 14),
    vwap: calculateVWAP(symbol)
  };
}

// ─── API Endpoints ─────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    status: 'healthy',
    timestamp: now(),
    market_status: getMarketStatus(),
    data_source: config.data_sources.active,
    instruments_tracked: Object.keys(config.instruments).length,
    heatseeker_window: isHeatSeekerWindow()
  });
});

app.get('/info', (req, res) => {
  res.json({
    name: SERVICE_NAME,
    sector: 'trading',
    port: PORT,
    version: config.version,
    maturity: 'manual',
    description: 'Real-time price feeds for ES/MES and NQ/MNQ futures. Simulated until TopstepX API configured.',
    instruments: Object.keys(config.instruments),
    endpoints: [
      'GET /health',
      'GET /info',
      'GET /prices — all current prices',
      'GET /prices/:symbol — single instrument price + technicals',
      'GET /candles/:symbol — 1-min candle history',
      'GET /candles/:symbol?period=5 — aggregated candles (1, 5, 15 min)',
      'GET /session/:symbol — session state (open, high, low, gap)',
      'GET /technicals/:symbol — SMA, EMA, RSI, VWAP',
      'GET /market-status — current market session status',
      'POST /prices/:symbol — manual price update (for testing)'
    ]
  });
});

// All prices
app.get('/prices', (req, res) => {
  res.json({
    prices,
    market_status: getMarketStatus(),
    heatseeker_window: isHeatSeekerWindow(),
    timestamp: now()
  });
});

// Single instrument price + technicals
app.get('/prices/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!prices[symbol]) {
    return res.status(404).json({ error: "Unknown instrument. Available: " + Object.keys(config.instruments).join(', ') });
  }
  res.json({
    symbol,
    ...prices[symbol],
    session: sessionState[symbol],
    technicals: getTechnicals(symbol),
    instrument_spec: config.instruments[symbol],
    market_status: getMarketStatus()
  });
});

// Candle history
app.get('/candles/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!candles[symbol]) {
    return res.status(404).json({ error: "Unknown instrument" });
  }

  const period = parseInt(req.query.period) || 1;
  const limit = parseInt(req.query.limit) || 100;
  let bars = candles[symbol];

  // Aggregate candles if period > 1
  if (period > 1) {
    const aggregated = [];
    for (let i = 0; i < bars.length; i += period) {
      const chunk = bars.slice(i, i + period);
      if (chunk.length === 0) continue;
      aggregated.push({
        open: chunk[0].open,
        high: Math.max(...chunk.map(c => c.high)),
        low: Math.min(...chunk.map(c => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + c.volume, 0),
        timestamp: chunk[0].timestamp
      });
    }
    bars = aggregated;
  }

  res.json({
    symbol,
    period_minutes: period,
    candles: bars.slice(-limit),
    total_available: bars.length
  });
});

// Session state
app.get('/session/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!sessionState[symbol]) {
    return res.status(404).json({ error: "Unknown instrument" });
  }
  res.json({
    symbol,
    ...sessionState[symbol],
    current_price: prices[symbol].last,
    market_status: getMarketStatus(),
    gap_analysis: sessionState[symbol].gapSize ? {
      gap_size: sessionState[symbol].gapSize,
      gap_direction: sessionState[symbol].gapSize > 0 ? 'gap_up' : 'gap_down',
      gap_filled: sessionState[symbol].gapFilled,
      gap_filled_at: sessionState[symbol].gapFilledAt || null,
      gap_pct: sessionState[symbol].prevClose
        ? parseFloat((sessionState[symbol].gapSize / sessionState[symbol].prevClose * 100).toFixed(3))
        : null
    } : null
  });
});

// Technicals
app.get('/technicals/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!candles[symbol]) {
    return res.status(404).json({ error: "Unknown instrument" });
  }
  res.json({
    symbol,
    timestamp: now(),
    price: prices[symbol].last,
    technicals: getTechnicals(symbol),
    candle_count: candles[symbol].length,
    data_source: config.data_sources.active
  });
});

// Market status
app.get('/market-status', (req, res) => {
  res.json({
    status: getMarketStatus(),
    heatseeker_window: isHeatSeekerWindow(),
    timestamp: now(),
    hours: config.market_hours
  });
});

// Manual price update (for testing)
app.post('/prices/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!prices[symbol]) {
    return res.status(404).json({ error: "Unknown instrument" });
  }
  const { last, bid, ask, volume } = req.body;
  if (last === undefined) {
    return res.status(400).json({ error: "Required: last (price)" });
  }
  const tick = {
    last: parseFloat(last),
    bid: bid || parseFloat(last) - config.instruments[symbol].tick_size / 2,
    ask: ask || parseFloat(last) + config.instruments[symbol].tick_size / 2,
    volume: volume || 1,
    timestamp: now()
  };
  updatePrice(symbol, tick);
  res.json({ symbol, updated: tick });
});

// ─── Startup ───────────────────────────────────────────────────────────────

async function selfRegister() {
  try {
    await fetch('http://localhost:8099/services/market-data/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online', port: PORT })
    });
    console.log('[market-data] Registered with Service Registry');
  } catch (err) {
    console.log('[market-data] Registry not available: ' + err.message);
  }
}

app.listen(PORT, () => {
  console.log('[market-data] Running on port ' + PORT);
  selfRegister();
  startDataFeed();
});
