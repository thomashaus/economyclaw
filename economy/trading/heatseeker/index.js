const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8111;
const SERVICE_NAME = 'heatseeker';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Signal Store ──────────────────────────────────────────────────────────

let signals = [];           // generated trade signals
let activeAnalysis = null;  // current Heatseeker map analysis (submitted by user)
let taSignals = [];         // price action / TA signals (off-hours)

// ─── Helper Functions ──────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function generateSignalId() {
  return 'HS-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
}

async function getMarketData(symbol) {
  try {
    const res = await fetch(config.market_data_url + '/prices/' + symbol, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return await res.json();
  } catch (err) {}
  return null;
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

async function getTechnicals(symbol) {
  try {
    const res = await fetch(config.market_data_url + '/technicals/' + symbol, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return await res.json();
  } catch (err) {}
  return null;
}

// ─── Price Action Signal Generation (Off-Hours) ───────────────────────────

async function generateTASignal(symbol) {
  const ta = await getTechnicals(symbol);
  if (!ta || !ta.technicals) return null;

  const t = ta.technicals;
  const price = ta.price;
  const signalReasons = [];
  let direction = null;
  let confidence = 0;

  // RSI oversold/overbought
  if (t.rsi_14 && t.rsi_14 <= config.price_action.signals.rsi_oversold) {
    signalReasons.push('RSI oversold (' + t.rsi_14 + ')');
    direction = 'long';
    confidence += 0.3;
  } else if (t.rsi_14 && t.rsi_14 >= config.price_action.signals.rsi_overbought) {
    signalReasons.push('RSI overbought (' + t.rsi_14 + ')');
    direction = 'short';
    confidence += 0.3;
  }

  // EMA crossover
  if (t.ema_9 && t.ema_21) {
    if (t.ema_9 > t.ema_21) {
      signalReasons.push('EMA 9 > EMA 21 (bullish)');
      if (!direction) direction = 'long';
      if (direction === 'long') confidence += 0.2;
    } else {
      signalReasons.push('EMA 9 < EMA 21 (bearish)');
      if (!direction) direction = 'short';
      if (direction === 'short') confidence += 0.2;
    }
  }

  // VWAP deviation
  if (t.vwap && price) {
    const deviation = ((price - t.vwap) / t.vwap) * 100;
    if (Math.abs(deviation) >= config.price_action.signals.vwap_deviation_pct) {
      if (deviation < 0) {
        signalReasons.push('Below VWAP by ' + Math.abs(deviation).toFixed(2) + '%');
        if (!direction) direction = 'long';
        if (direction === 'long') confidence += 0.15;
      } else {
        signalReasons.push('Above VWAP by ' + deviation.toFixed(2) + '%');
        if (!direction) direction = 'short';
        if (direction === 'short') confidence += 0.15;
      }
    }
  }

  // SMA trend alignment
  if (t.sma_9 && t.sma_20 && t.sma_50) {
    if (t.sma_9 > t.sma_20 && t.sma_20 > t.sma_50) {
      signalReasons.push('SMA 9 > 20 > 50 (bullish trend)');
      if (direction === 'long') confidence += 0.2;
    } else if (t.sma_9 < t.sma_20 && t.sma_20 < t.sma_50) {
      signalReasons.push('SMA 9 < 20 < 50 (bearish trend)');
      if (direction === 'short') confidence += 0.2;
    }
  }

  if (!direction || confidence < 0.4) return null;

  return {
    id: generateSignalId(),
    symbol,
    direction,
    confidence: parseFloat(confidence.toFixed(2)),
    source: 'price_action_ta',
    reasons: signalReasons,
    technicals: t,
    price_at_signal: price,
    timestamp: now(),
    status: 'pending',
    mode: 'off_hours'
  };
}

// ─── TA Signal Scanning Loop ───────────────────────────────────────────────

async function scanForTASignals() {
  const mktStatus = await getMarketStatus();

  // Only generate TA signals during off-hours (overnight, post-market)
  // During market hours, Heatseeker analysis drives signals
  if (mktStatus.heatseeker_window) return;
  if (mktStatus.status === 'closed') return;

  for (const symbol of ['MES', 'MNQ']) { // off-hours: micros only
    const signal = await generateTASignal(symbol);
    if (signal) {
      taSignals.push(signal);
      signals.push(signal);
      console.log('[heatseeker] TA signal: ' + signal.direction + ' ' + symbol + ' (confidence: ' + signal.confidence + ')');

      // Keep last 100 signals
      if (signals.length > 100) signals = signals.slice(-100);
      if (taSignals.length > 50) taSignals = taSignals.slice(-50);
    }
  }
}

// Scan every 60 seconds during off-hours
setInterval(scanForTASignals, 60000);

// ─── API Endpoints ─────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  getMarketStatus().then(mkt => {
    res.json({
      service: SERVICE_NAME,
      status: 'healthy',
      timestamp: now(),
      market_status: mkt.status,
      heatseeker_window: mkt.heatseeker_window,
      mode: mkt.heatseeker_window ? 'heatseeker_gex_vex' : 'price_action_ta',
      total_signals: signals.length,
      active_analysis: activeAnalysis ? true : false
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
    description: 'Heatseeker GEX/VEX analysis during market hours. Price action TA during off-hours. ES/MES and NQ/MNQ only.',
    instruments: config.instruments,
    endpoints: [
      'GET /health',
      'GET /info',
      'POST /analyze — submit Heatseeker analysis (GEX/VEX map data)',
      'GET /analysis — current active analysis',
      'GET /signals — all generated signals',
      'GET /signals/active — pending signals awaiting approval',
      'GET /signals/:id — single signal detail',
      'POST /signals/:id/invalidate — mark signal as invalidated',
      'GET /ta-signals — price action signals (off-hours)',
      'POST /gap-check/:symbol — check gap fill pattern (Pattern #1)'
    ]
  });
});

// Submit Heatseeker analysis (from user reviewing GEX/VEX maps)
app.post('/analyze', (req, res) => {
  const {
    symbol, map_grade, direction, pattern,
    king_node, gatekeeper_nodes, floor_nodes, air_pockets,
    entry_price, target_price, stop_price,
    notes, vex_alignment, vix_regime
  } = req.body;

  if (!symbol || !map_grade || !direction || !entry_price || !target_price || !stop_price) {
    return res.status(400).json({
      error: 'Required: symbol, map_grade, direction, entry_price, target_price, stop_price',
      example: {
        symbol: 'ES',
        map_grade: 'A+',
        direction: 'long',
        pattern: 'reverse_rug_slingshot',
        king_node: { strike: 5880, value: '+45M' },
        gatekeeper_nodes: [{ strike: 5860, value: '+15M' }],
        floor_nodes: [{ strike: 5840, value: '+30M' }],
        air_pockets: [{ from: 5810, to: 5830 }],
        entry_price: 5842,
        target_price: 5875,
        stop_price: 5830,
        vex_alignment: 'positive_below',
        vix_regime: 'calm',
        notes: 'Clean A+ map. Yellow floor at 5840 with clear skies to King at 5880.'
      }
    });
  }

  // Validate map grade meets minimum
  const gradeIndex = config.heatseeker.map_quality_grades.indexOf(map_grade);
  const minIndex = config.heatseeker.map_quality_grades.indexOf(config.heatseeker.min_trade_grade);
  if (gradeIndex > minIndex) {
    return res.status(400).json({
      warning: 'Map grade ' + map_grade + ' is below minimum tradeable grade (' + config.heatseeker.min_trade_grade + ')',
      recommendation: 'Consider sitting this session out or waiting for map clarity.',
      override: 'Resubmit with force: true to override'
    });
  }

  // Calculate R:R
  const risk = Math.abs(entry_price - stop_price);
  const reward = Math.abs(target_price - entry_price);
  const rr = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;

  if (rr < config.heatseeker.min_rr_ratio && !req.body.force) {
    return res.status(400).json({
      warning: 'R:R ratio ' + rr + ':1 is below minimum ' + config.heatseeker.min_rr_ratio + ':1',
      recommendation: 'Adjust entry, target, or stop to improve risk/reward.',
      override: 'Resubmit with force: true to override'
    });
  }

  const signal = {
    id: generateSignalId(),
    symbol: symbol.toUpperCase(),
    direction,
    source: 'heatseeker_gex_vex',
    mode: 'market_hours',
    map_grade,
    pattern: pattern || 'manual_analysis',
    king_node: king_node || null,
    gatekeeper_nodes: gatekeeper_nodes || [],
    floor_nodes: floor_nodes || [],
    air_pockets: air_pockets || [],
    entry_price: parseFloat(entry_price),
    target_price: parseFloat(target_price),
    stop_price: parseFloat(stop_price),
    risk_reward: rr,
    vex_alignment: vex_alignment || 'unknown',
    vix_regime: vix_regime || 'unknown',
    confidence: map_grade === 'A+' ? 0.9 : map_grade === 'B' ? 0.7 : 0.5,
    notes: notes || '',
    timestamp: now(),
    status: 'pending'
  };

  activeAnalysis = signal;
  signals.push(signal);
  if (signals.length > 100) signals = signals.slice(-100);

  console.log('[heatseeker] Signal generated: ' + signal.id + ' ' + signal.direction + ' ' + signal.symbol + ' (grade: ' + map_grade + ', R:R ' + rr + ':1)');

  res.status(201).json({
    signal_id: signal.id,
    direction: signal.direction,
    symbol: signal.symbol,
    map_grade,
    risk_reward: rr + ':1',
    status: 'pending — awaiting Risk Management check and Trade Approval',
    message: 'Signal created. Route to Trade Approval via Trade Desk or direct.'
  });
});

// Current analysis
app.get('/analysis', (req, res) => {
  if (!activeAnalysis) {
    return res.json({ active_analysis: null, message: 'No active Heatseeker analysis. Submit via POST /analyze.' });
  }
  res.json({ active_analysis: activeAnalysis });
});

// All signals
app.get('/signals', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({
    signals: signals.slice(-limit),
    total: signals.length,
    timestamp: now()
  });
});

// Active (pending) signals
app.get('/signals/active', (req, res) => {
  const active = signals.filter(s => s.status === 'pending');
  res.json({ active_signals: active, count: active.length });
});

// Single signal
app.get('/signals/:id', (req, res) => {
  const signal = signals.find(s => s.id === req.params.id);
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  res.json(signal);
});

// Invalidate a signal
app.post('/signals/:id/invalidate', (req, res) => {
  const signal = signals.find(s => s.id === req.params.id);
  if (!signal) return res.status(404).json({ error: 'Signal not found' });

  signal.status = 'invalidated';
  signal.invalidated_at = now();
  signal.invalidation_reason = req.body.reason || 'manual invalidation';

  if (activeAnalysis && activeAnalysis.id === signal.id) {
    activeAnalysis = null;
  }

  res.json({ signal_id: signal.id, status: 'invalidated', reason: signal.invalidation_reason });
});

// TA signals (off-hours only)
app.get('/ta-signals', (req, res) => {
  res.json({ ta_signals: taSignals.slice(-20), total: taSignals.length });
});

// Gap fill pattern check (Market Pattern #1)
app.post('/gap-check/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const sessionRes = await fetch(config.market_data_url + '/session/' + symbol, {
      signal: AbortSignal.timeout(3000)
    });
    if (!sessionRes.ok) return res.status(502).json({ error: 'Market data unavailable' });
    const session = await sessionRes.json();

    if (!session.gap_analysis) {
      return res.json({ pattern_active: false, reason: 'No gap detected today' });
    }

    const gap = session.gap_analysis;
    const ct = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const d = new Date(ct);
    const minutes_since_open = (d.getHours() * 60 + d.getMinutes()) - (8 * 60 + 30);

    // Pattern #1: Small gap, unfilled after 15 minutes = 95% high of day is in by 9:45 AM ET
    if (Math.abs(gap.gap_size) < config.gap_analysis.small_gap_threshold_points &&
        !gap.gap_filled &&
        minutes_since_open >= 15) {
      return res.json({
        pattern_active: true,
        pattern: 'gap_fill_failure',
        confidence: 0.95,
        implication: 'High of day likely in by 9:45 AM ET. Bearish bias for rest of session.',
        gap_size: gap.gap_size,
        gap_direction: gap.gap_direction,
        minutes_since_open,
        recommendation: 'Short-only bias. Block new long entries.',
        source: 'Pattern #1 — TheQuietCalf / SKY Discord'
      });
    }

    res.json({
      pattern_active: false,
      gap_size: gap.gap_size,
      gap_filled: gap.gap_filled,
      minutes_since_open,
      reason: gap.gap_filled ? 'Gap was filled — pattern not triggered' : 'Gap too large or not enough time elapsed'
    });
  } catch (err) {
    res.status(502).json({ error: 'Market data check failed: ' + err.message });
  }
});

// ─── Startup ───────────────────────────────────────────────────────────────

async function selfRegister() {
  try {
    await fetch(config.registry_url + '/services/' + SERVICE_NAME + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online', port: PORT })
    });
    console.log('[heatseeker] Registered with Service Registry');
  } catch (err) {
    console.log('[heatseeker] Registry not available: ' + err.message);
  }
}

app.listen(PORT, () => {
  console.log('[heatseeker] Running on port ' + PORT);
  selfRegister();
  // Initial TA scan after 10 seconds
  setTimeout(scanForTASignals, 10000);
});
