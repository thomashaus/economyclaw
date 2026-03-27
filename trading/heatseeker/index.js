const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8111;
const SERVICE_NAME = 'heatseeker';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Signal & State Stores ──────────────────────────────────────────────────

let signals = [];           // generated trade signals
let activeAnalysis = null;  // current Heatseeker map analysis
let taSignals = [];         // price action / TA signals (off-hours)
let gatekeeperTests = {};   // track test counts per strike: { "5880": { count: 2, last_test: ... } }
let nodeHistory = {};       // track node value changes for lifecycle/divergence: { "5880": [{ value, timestamp }] }
let trinityState = {};      // cross-ticker King alignment: { SPX: {...}, SPY: {...}, QQQ: {...} }

// ─── Helper Functions ────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function generateSignalId() {
  return 'HS-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
}

async function getMarketData(symbol) {
  try {
    var res = await fetch(config.market_data_url + '/prices/' + symbol, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return await res.json();
  } catch (err) {}
  return null;
}

async function getMarketStatus() {
  try {
    var res = await fetch(config.market_data_url + '/market-status', {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return await res.json();
  } catch (err) {}
  return { status: 'unknown', heatseeker_window: false };
}

async function getTechnicals(symbol) {
  try {
    var res = await fetch(config.market_data_url + '/technicals/' + symbol, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return await res.json();
  } catch (err) {}
  return null;
}

// ─── Methodology Engine ──────────────────────────────────────────────────────

function determineVixQuadrant(vix_level, vix_direction) {
  if (!vix_level || !vix_direction) return null;
  var level = vix_level >= 20 ? 'high' : 'low';
  var dir = vix_direction;
  var key = level + '_' + dir;
  return config.vix_matrix[key] || null;
}

function getVexQualityMultiplier(gex_sign, vex_sign) {
  if (gex_sign === '+' && vex_sign === '+') return config.vex_quality_adjustment.dual_positive;
  if (gex_sign === '+' && vex_sign === '-') return config.vex_quality_adjustment.misaligned_pos_gex;
  if (gex_sign === '-' && vex_sign === '-') return config.vex_quality_adjustment.dual_negative;
  if (gex_sign === '-' && vex_sign === '+') return config.vex_quality_adjustment.misaligned_neg_gex;
  return { multiplier: 1.0, description: 'unknown alignment' };
}

function classifyNode(gex_value) {
  if (gex_value > 0) {
    return {
      type: 'deflective',
      color: 'yellow',
      behavior: config.node_types.yellow_positive_gex.dealer_action
    };
  } else {
    return {
      type: 'amplifying',
      color: 'purple',
      behavior: config.node_types.purple_negative_gex.dealer_action
    };
  }
}

function classifyNodeRole(gex_value, strike, spot_price) {
  var classification = classifyNode(gex_value);
  if (classification.type === 'deflective') {
    if (strike > spot_price) {
      classification.role = 'gatekeeper';
      classification.role_detail = 'Resistance — dealers sell to hedge approaching calls';
    } else {
      classification.role = 'floor';
      classification.role_detail = 'Support — dealers buy to hedge approaching puts';
    }
  } else {
    classification.role = 'acceleration';
    classification.role_detail = 'Pro-cyclical fuel — amplifies whatever direction price is moving';
  }
  return classification;
}

function getGatekeeperTestCount(strike) {
  var key = String(strike);
  if (!gatekeeperTests[key]) return 0;
  return gatekeeperTests[key].count;
}

function recordGatekeeperTest(strike) {
  var key = String(strike);
  if (!gatekeeperTests[key]) {
    gatekeeperTests[key] = { count: 0, tests: [] };
  }
  gatekeeperTests[key].count += 1;
  gatekeeperTests[key].tests.push({ timestamp: now() });

  var testCount = gatekeeperTests[key].count;
  var probability = testCount >= 3 ? 0.66 : 0.34; // 3rd test: 66% breakthrough
  var recommendation = testCount >= 3
    ? 'THIRD TEST — 66% breakthrough probability. Do NOT fade.'
    : 'Test #' + testCount + ' — 66% rejection. Fade the approach.';

  return {
    strike: strike,
    test_number: testCount,
    breakthrough_probability: probability,
    rejection_probability: 1 - probability,
    recommendation: recommendation
  };
}

function recordNodeValue(strike, gex_value, vex_value) {
  var key = String(strike);
  if (!nodeHistory[key]) {
    nodeHistory[key] = [];
  }
  nodeHistory[key].push({
    gex: gex_value,
    vex: vex_value || null,
    timestamp: now()
  });
  // Keep last 50 snapshots per strike
  if (nodeHistory[key].length > 50) {
    nodeHistory[key] = nodeHistory[key].slice(-50);
  }
}

function detectNodeLifecycle(strike) {
  var key = String(strike);
  var history = nodeHistory[key];
  if (!history || history.length < 2) return null;

  var latest = history[history.length - 1];
  var previous = history[history.length - 2];
  var gex_change = latest.gex - previous.gex;
  var pct_change = previous.gex !== 0 ? (gex_change / Math.abs(previous.gex)) * 100 : 0;

  var lifecycle = {
    strike: strike,
    current_gex: latest.gex,
    previous_gex: previous.gex,
    change: gex_change,
    pct_change: parseFloat(pct_change.toFixed(1)),
    snapshots: history.length
  };

  if (pct_change > 20) {
    lifecycle.signal = 'growing';
    lifecycle.interpretation = config.node_lifecycle_signals.growing_toward;
  } else if (pct_change < -20) {
    lifecycle.signal = 'shrinking';
    lifecycle.interpretation = config.node_lifecycle_signals.shrinking_after_touch;
    lifecycle.warning = 'Node may be washing off — do not re-trade dead levels';
  } else {
    lifecycle.signal = 'stable';
    lifecycle.interpretation = 'Node value holding steady';
  }

  return lifecycle;
}

function detectDivergence(strike, price_direction) {
  var key = String(strike);
  var history = nodeHistory[key];
  if (!history || history.length < 2) return null;

  var latest = history[history.length - 1];
  var previous = history[history.length - 2];
  var gex_growing = Math.abs(latest.gex) > Math.abs(previous.gex);

  // GEX growing while price moves away = bearish divergence
  if (gex_growing && price_direction === 'away') {
    return {
      type: 'bearish_divergence',
      strike: strike,
      detail: config.divergence_signals.gex_growing_price_retreating,
      warning: 'Node value growing while price retreats — the bounce is FAKE. Expect price to revisit.'
    };
  }

  // GEX shrinking while price approaches = washoff warning
  if (!gex_growing && price_direction === 'toward') {
    return {
      type: 'washoff_warning',
      strike: strike,
      detail: config.divergence_signals.gex_shrinking_price_approaching,
      warning: 'Node losing hedging interest as price approaches — may not hold.'
    };
  }

  return null;
}

function isSpeculativeNode(strike, gex_value, spot_price) {
  var distance_pct = Math.abs(strike - spot_price) / spot_price * 100;
  var key = String(strike);
  var history = nodeHistory[key] || [];

  var flags = [];
  if (distance_pct > 3) flags.push('Far OTM (>' + distance_pct.toFixed(1) + '% from spot)');
  if (Math.abs(gex_value) < 5) flags.push('Small magnitude');
  if (history.length <= 1) flags.push('Recently appeared — no growth history');

  return {
    is_speculative: flags.length >= 2,
    flags: flags,
    distance_from_spot_pct: parseFloat(distance_pct.toFixed(2))
  };
}

function validatePatternSetup(pattern_name, nodes, spot_price) {
  var patternDef = config.patterns[pattern_name];
  if (!patternDef) return { valid: false, error: 'Unknown pattern: ' + pattern_name };

  var warnings = [];
  var confirmations = [];

  switch (pattern_name) {
    case 'rug_pull':
      // Need yellow ceiling above purple, air pocket below
      if (nodes.yellow_ceiling && nodes.purple_below) {
        confirmations.push('Yellow ceiling at ' + nodes.yellow_ceiling.strike + ' above purple at ' + nodes.purple_below.strike);
        if (nodes.air_pocket_below) confirmations.push('Air pocket below — free-fall zone');
        else warnings.push('No air pocket identified below — rug pull may be dampened');
      } else {
        warnings.push('Missing required nodes for rug pull setup');
      }
      break;

    case 'reverse_rug_slingshot':
      if (nodes.yellow_floor && nodes.purple_above) {
        confirmations.push('Yellow floor at ' + nodes.yellow_floor.strike + ' below purple at ' + nodes.purple_above.strike);
        if (nodes.clear_skies_above) confirmations.push('Clear Skies above — maximum velocity slingshot');
        else warnings.push('Resistance above — slingshot velocity may be limited');
      } else {
        warnings.push('Missing required nodes for reverse rug setup');
      }
      break;

    case 'gatekeeper_rejection':
      if (nodes.gatekeeper) {
        var testInfo = recordGatekeeperTest(nodes.gatekeeper.strike);
        confirmations.push('Gatekeeper at ' + nodes.gatekeeper.strike + ' — ' + testInfo.recommendation);
        if (testInfo.test_number >= 3) {
          warnings.push('THIRD TEST — probability has FLIPPED. Do NOT fade this approach.');
        }
      }
      break;

    case 'beach_ball':
      if (nodes.negative_gex_pit) {
        confirmations.push('Price in -GEX pit at ' + nodes.negative_gex_pit.strike);
        confirmations.push('Delta saturation = violent snap-back potential');
      }
      break;

    case 'rainbow_road':
      warnings.push('Rainbow Road active — GEX levels are UNRELIABLE');
      warnings.push('Trade VEX alignment and trend direction ONLY');
      break;

    default:
      confirmations.push('Pattern ' + patternDef.name + ' identified');
  }

  return {
    valid: confirmations.length > 0,
    pattern: patternDef,
    confirmations: confirmations,
    warnings: warnings
  };
}

function buildVixAssessment(vix_level, vix_direction) {
  var quadrant = determineVixQuadrant(vix_level, vix_direction);
  if (!quadrant) {
    return { regime: 'unknown', warnings: ['VIX data not provided — cannot assess vanna impact'] };
  }

  var assessment = {
    vix_level: vix_level,
    vix_direction: vix_direction,
    regime: quadrant.regime,
    dominant_force: quadrant.dominant_force,
    vex_modifier_strength: quadrant.vex_modifier_strength,
    gex_reliability: quadrant.gex_reliability,
    description: quadrant.description,
    warnings: []
  };

  if (quadrant.warning) assessment.warnings.push(quadrant.warning);
  if (quadrant.transition_warning) assessment.warnings.push(quadrant.transition_warning);

  return assessment;
}

function assessTrinityAlignment(trinityData) {
  // trinityData: { SPX: { king_strike, king_gex, king_vex, spot }, SPY: {...}, QQQ: {...} }
  if (!trinityData || Object.keys(trinityData).length < 2) {
    return { aligned: 'unknown', message: 'Insufficient Trinity data for cross-ticker analysis' };
  }

  var pulls = {};
  var totalBullish = 0;
  var totalBearish = 0;

  Object.keys(trinityData).forEach(function(ticker) {
    var data = trinityData[ticker];
    if (!data.king_strike || !data.king_gex || !data.spot) return;

    var gex_sign = data.king_gex > 0 ? '+' : '-';
    var vex_sign = data.king_vex > 0 ? '+' : (data.king_vex < 0 ? '-' : '+');
    var quality = getVexQualityMultiplier(gex_sign, vex_sign);
    var raw_magnitude = Math.abs(data.king_gex);
    var effective_pull = raw_magnitude * quality.multiplier;
    var direction = data.king_strike > data.spot ? 'bullish' : 'bearish';

    pulls[ticker] = {
      king_strike: data.king_strike,
      king_gex: data.king_gex,
      king_vex: data.king_vex,
      alignment: quality.description,
      raw_magnitude: raw_magnitude,
      effective_pull: parseFloat(effective_pull.toFixed(1)),
      direction: direction
    };

    if (direction === 'bullish') totalBullish += effective_pull;
    else totalBearish += effective_pull;
  });

  var dominant = totalBullish > totalBearish ? 'bullish' : 'bearish';
  var ratio = Math.max(totalBullish, totalBearish) / (Math.min(totalBullish, totalBearish) || 1);

  var target_adjustment = 'full';
  if (ratio >= 2) target_adjustment = 'subordinate';
  else if (ratio >= 1.2) target_adjustment = 'competitive';

  // Store for reference
  trinityState = {
    pulls: pulls,
    dominant_direction: dominant,
    ratio: parseFloat(ratio.toFixed(2)),
    target_adjustment: target_adjustment,
    total_bullish: parseFloat(totalBullish.toFixed(1)),
    total_bearish: parseFloat(totalBearish.toFixed(1)),
    timestamp: now(),
    recommendation: config.trinity_alignment.target_adjustments[target_adjustment] || {}
  };

  return trinityState;
}

function buildAnalysisScore(mapData) {
  var score = {
    base_confidence: 0,
    modifiers: [],
    warnings: [],
    final_confidence: 0
  };

  // Base confidence from map grade
  var gradeConfig = config.map_grading.grades[mapData.map_grade];
  if (gradeConfig) {
    score.base_confidence = gradeConfig.confidence_base;
    score.recommended_sizing = gradeConfig.sizing;
  }

  // VIX regime modifier
  if (mapData.vix_level && mapData.vix_direction) {
    var vixAssessment = buildVixAssessment(mapData.vix_level, mapData.vix_direction);
    if (vixAssessment.regime === 'Rainbow Road') {
      score.modifiers.push({ factor: 'Rainbow Road regime', adjustment: -0.2 });
      score.warnings.push('GEX levels unreliable in Rainbow Road. Trade VEX and trend only.');
    }
    if (vixAssessment.vex_modifier_strength === 'LOUD') {
      score.modifiers.push({ factor: 'VEX modifiers LOUD (VIX > 20)', adjustment: 0 });
      score.warnings.push('VEX alignment is a dominant factor at this VIX level.');
    }
  }

  // VEX alignment modifier
  if (mapData.vex_alignment) {
    if (mapData.vex_alignment === 'dual_positive' || mapData.vex_alignment === 'positive_aligned') {
      score.modifiers.push({ factor: 'VEX aligned with trade direction', adjustment: 0.05 });
    } else if (mapData.vex_alignment === 'misaligned' || mapData.vex_alignment === 'negative_misaligned') {
      score.modifiers.push({ factor: 'VEX misaligned — forces fighting', adjustment: -0.1 });
      score.warnings.push('VEX misalignment reduces effective pull by ~50%');
    }
  }

  // Pattern stacking modifier
  if (mapData.pattern && config.patterns[mapData.pattern]) {
    score.modifiers.push({ factor: 'Recognized pattern: ' + config.patterns[mapData.pattern].name, adjustment: 0.05 });
  }

  // R:R modifier
  if (mapData.risk_reward) {
    if (mapData.risk_reward >= 5) score.modifiers.push({ factor: 'Excellent R:R (' + mapData.risk_reward + ':1)', adjustment: 0.05 });
    else if (mapData.risk_reward < 3) {
      score.modifiers.push({ factor: 'Below minimum R:R', adjustment: -0.2 });
      score.warnings.push('R:R below 3:1 minimum');
    }
  }

  // Calculate final
  var totalAdjustment = 0;
  score.modifiers.forEach(function(m) { totalAdjustment += m.adjustment; });
  score.final_confidence = Math.max(0, Math.min(1, score.base_confidence + totalAdjustment));
  score.final_confidence = parseFloat(score.final_confidence.toFixed(2));

  return score;
}

function checkCommandments(mapData) {
  var violations = [];
  var confirmations = [];

  // #1: F-grade map
  if (mapData.map_grade === 'F') {
    violations.push({ commandment: 1, rule: config.ten_commandments[0], severity: 'block' });
  }

  // #2: Mid-range entry check (simplified — flag if no floor/ceiling identified)
  if (!mapData.floor_nodes || mapData.floor_nodes.length === 0) {
    if (!mapData.gatekeeper_nodes || mapData.gatekeeper_nodes.length === 0) {
      violations.push({ commandment: 2, rule: config.ten_commandments[1], severity: 'warn' });
    }
  } else {
    confirmations.push({ commandment: 2, detail: 'Entry near identified floor/ceiling' });
  }

  // #6: Cross-ticker check
  if (mapData.trinity_data) {
    var trinity = assessTrinityAlignment(mapData.trinity_data);
    if (trinity.target_adjustment === 'subordinate') {
      violations.push({
        commandment: 6,
        rule: config.ten_commandments[5],
        severity: 'warn',
        detail: 'King target is subordinate to opposing cross-ticker pull (' + trinity.ratio + ':1). Reduce target.'
      });
    } else {
      confirmations.push({ commandment: 6, detail: 'Trinity alignment: ' + trinity.target_adjustment });
    }
  }

  // #10: Node washoff check
  if (mapData.target_strike) {
    var lifecycle = detectNodeLifecycle(mapData.target_strike);
    if (lifecycle && lifecycle.signal === 'shrinking') {
      violations.push({
        commandment: 10,
        rule: config.ten_commandments[9],
        severity: 'warn',
        detail: 'Target node at ' + mapData.target_strike + ' is shrinking — may have washed off'
      });
    }
  }

  return {
    violations: violations,
    confirmations: confirmations,
    blocked: violations.some(function(v) { return v.severity === 'block'; }),
    warning_count: violations.filter(function(v) { return v.severity === 'warn'; }).length
  };
}

// ─── Rolling Ceiling/Floor Detection ─────────────────────────────────────────

var rollingLevels = {
  ceilings: [],  // { strike, gex_value, timestamp, vex_value }
  floors: [],
  history: [],   // snapshots for compression detection
  last_updated: null
};

function updateRollingLevels(mapSnapshot) {
  // mapSnapshot: { nodes: [{ strike, gex_value, vex_value }], spot_price, timestamp }
  if (!mapSnapshot || !mapSnapshot.nodes || !mapSnapshot.spot_price) return null;

  var spot = mapSnapshot.spot_price;
  var ceilings = [];
  var floors = [];

  // Classify all positive GEX nodes as ceilings (above spot) or floors (below spot)
  mapSnapshot.nodes.forEach(function(node) {
    if (node.gex_value > 0) {
      if (node.strike > spot) {
        ceilings.push({ strike: node.strike, gex_value: node.gex_value, vex_value: node.vex_value || null });
      } else {
        floors.push({ strike: node.strike, gex_value: node.gex_value, vex_value: node.vex_value || null });
      }
    }
  });

  // Sort: ceilings ascending (nearest first), floors descending (nearest first)
  ceilings.sort(function(a, b) { return a.strike - b.strike; });
  floors.sort(function(a, b) { return b.strike - a.strike; });

  var snapshot = {
    timestamp: mapSnapshot.timestamp || now(),
    spot: spot,
    ceiling_count: ceilings.length,
    floor_count: floors.length,
    nearest_ceiling: ceilings.length > 0 ? ceilings[0].strike : null,
    farthest_ceiling: ceilings.length > 0 ? ceilings[ceilings.length - 1].strike : null,
    nearest_floor: floors.length > 0 ? floors[0].strike : null,
    farthest_floor: floors.length > 0 ? floors[floors.length - 1].strike : null,
    ceiling_range: ceilings.length > 1 ? ceilings[ceilings.length - 1].strike - ceilings[0].strike : 0,
    floor_range: floors.length > 1 ? floors[0].strike - floors[floors.length - 1].strike : 0
  };

  rollingLevels.ceilings = ceilings;
  rollingLevels.floors = floors;
  rollingLevels.last_updated = snapshot.timestamp;
  rollingLevels.history.push(snapshot);
  if (rollingLevels.history.length > 30) {
    rollingLevels.history = rollingLevels.history.slice(-30);
  }

  return snapshot;
}

function detectCeilingFloorCompression() {
  var history = rollingLevels.history;
  if (history.length < 3) return null;

  var latest = history[history.length - 1];
  var previous = history[history.length - 2];
  var older = history[history.length - 3];

  var signals = [];

  // Rolling ceilings shrinking = bearish evidence
  // Upside targets getting smaller means dealers are pulling resistance tighter
  if (latest.nearest_ceiling && previous.nearest_ceiling && older.nearest_ceiling) {
    var ceiling_trend = latest.nearest_ceiling - older.nearest_ceiling;
    if (ceiling_trend < 0 && latest.ceiling_range < previous.ceiling_range) {
      signals.push({
        type: 'ceiling_compression',
        bias: 'bearish',
        detail: 'Upside targets shrinking. Nearest ceiling moved from ' + older.nearest_ceiling + ' to ' + latest.nearest_ceiling + '.',
        interpretation: 'Dealers pulling resistance tighter — strong directional bearish evidence. Upside is capping.',
        ceiling_delta: ceiling_trend,
        range_compression: previous.ceiling_range - latest.ceiling_range
      });
    }
  }

  // Rolling floors compressing upward = bullish evidence
  // Downside floors moving higher means dealers are building support underneath
  if (latest.nearest_floor && previous.nearest_floor && older.nearest_floor) {
    var floor_trend = latest.nearest_floor - older.nearest_floor;
    if (floor_trend > 0 && latest.floor_range < previous.floor_range) {
      signals.push({
        type: 'floor_compression',
        bias: 'bullish',
        detail: 'Downside floors compressing upward. Nearest floor moved from ' + older.nearest_floor + ' to ' + latest.nearest_floor + '.',
        interpretation: 'Dealers building support higher — strong directional bullish evidence. Downside is firming.',
        floor_delta: floor_trend,
        range_compression: previous.floor_range - latest.floor_range
      });
    }
  }

  // Both compressing = squeeze setup
  if (signals.length === 2) {
    signals.push({
      type: 'dual_compression',
      bias: 'squeeze',
      detail: 'Both ceilings AND floors compressing simultaneously.',
      interpretation: 'Volatility compression — expect breakout. Direction determined by which side breaks first. Watch for Beach Ball or Rug Pull setup.',
      warning: 'Do NOT fade the breakout direction.'
    });
  }

  return signals.length > 0 ? signals : null;
}

// ─── Price Action Signal Generation (Off-Hours) ─────────────────────────────

async function generateTASignal(symbol) {
  var ta = await getTechnicals(symbol);
  if (!ta || !ta.technicals) return null;

  var t = ta.technicals;
  var price = ta.price;
  var signalReasons = [];
  var direction = null;
  var confidence = 0;

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
    var deviation = ((price - t.vwap) / t.vwap) * 100;
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
    symbol: symbol,
    direction: direction,
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

// ─── TA Signal Scanning Loop ─────────────────────────────────────────────────

async function scanForTASignals() {
  var mktStatus = await getMarketStatus();

  // Only generate TA signals during off-hours
  if (mktStatus.heatseeker_window) return;
  if (mktStatus.status === 'closed') return;

  for (var i = 0; i < 2; i++) {
    var symbol = ['MES', 'MNQ'][i];
    var signal = await generateTASignal(symbol);
    if (signal) {
      taSignals.push(signal);
      signals.push(signal);
      console.log('[heatseeker] TA signal: ' + signal.direction + ' ' + symbol + ' (confidence: ' + signal.confidence + ')');

      if (signals.length > 100) signals = signals.slice(-100);
      if (taSignals.length > 50) taSignals = taSignals.slice(-50);
    }
  }
}

// Scan every 60 seconds during off-hours
setInterval(scanForTASignals, 60000);

// ─── API Endpoints ───────────────────────────────────────────────────────────

app.get('/health', function(req, res) {
  getMarketStatus().then(function(mkt) {
    res.json({
      service: SERVICE_NAME,
      status: 'healthy',
      timestamp: now(),
      version: config.version,
      market_status: mkt.status,
      heatseeker_window: mkt.heatseeker_window,
      mode: mkt.heatseeker_window ? 'heatseeker_gex_vex' : 'price_action_ta',
      total_signals: signals.length,
      active_analysis: activeAnalysis ? true : false,
      tracked_gatekeepers: Object.keys(gatekeeperTests).length,
      tracked_nodes: Object.keys(nodeHistory).length
    });
  }).catch(function() {
    res.json({ service: SERVICE_NAME, status: 'healthy', timestamp: now(), version: config.version });
  });
});

app.get('/info', function(req, res) {
  res.json({
    name: SERVICE_NAME,
    sector: 'trading',
    port: PORT,
    version: config.version,
    maturity: 'observe',
    methodology: 'Heatseeker GEX/VEX with full pattern library, VIX matrix, Trinity alignment, gatekeeper tracking',
    description: 'Heatseeker GEX/VEX analysis during market hours. Price action TA during off-hours. ES/MES and NQ/MNQ only.',
    instruments: config.instruments,
    patterns: Object.keys(config.patterns),
    ten_commandments: config.ten_commandments,
    endpoints: [
      'GET /health',
      'GET /info',
      'POST /analyze — submit Heatseeker analysis (GEX/VEX map data) with methodology scoring',
      'GET /analysis — current active analysis',
      'GET /signals — all generated signals',
      'GET /signals/active — pending signals awaiting approval',
      'GET /signals/:id — single signal detail',
      'POST /signals/:id/invalidate — mark signal as invalidated',
      'GET /ta-signals — price action signals (off-hours)',
      'POST /gap-check/:symbol — check gap fill pattern',
      'POST /node/classify — classify a GEX node (type, role, approach direction)',
      'POST /node/record — record node value snapshot for lifecycle tracking',
      'GET /node/:strike/history — node value history and lifecycle signal',
      'POST /gatekeeper/test — record a gatekeeper test and get probability',
      'GET /gatekeeper/status — all tracked gatekeeper test counts',
      'POST /trinity — submit cross-ticker Trinity data for alignment analysis',
      'GET /trinity — current Trinity alignment state',
      'POST /vix/assess — get VIX regime assessment and implications',
      'GET /methodology/patterns — full pattern library reference',
      'GET /methodology/dealer-behavior — dealer behavior quick reference',
      'GET /methodology/commandments — Ten Commandments',
      'POST /rolling-levels — submit map snapshot for rolling ceiling/floor tracking',
      'GET /rolling-levels — current rolling levels and compression signals'
    ]
  });
});

// ─── Enhanced Analyze Endpoint ───────────────────────────────────────────────

app.post('/analyze', function(req, res) {
  var body = req.body;

  if (!body.symbol || !body.map_grade || !body.direction || !body.entry_price || !body.target_price || !body.stop_price) {
    return res.status(400).json({
      error: 'Required: symbol, map_grade, direction, entry_price, target_price, stop_price',
      optional: 'pattern, king_node, gatekeeper_nodes, floor_nodes, air_pockets, vex_alignment, vix_level, vix_direction, trinity_data, nodes (for validation)',
      example: {
        symbol: 'ES',
        map_grade: 'A+',
        direction: 'long',
        pattern: 'reverse_rug_slingshot',
        king_node: { strike: 5880, gex_value: 45, vex_value: 30 },
        gatekeeper_nodes: [{ strike: 5860, gex_value: 15 }],
        floor_nodes: [{ strike: 5840, gex_value: 30, vex_value: 20 }],
        air_pockets: [{ from: 5810, to: 5830 }],
        entry_price: 5842,
        target_price: 5875,
        stop_price: 5830,
        vex_alignment: 'dual_positive',
        vix_level: 18.5,
        vix_direction: 'dropping',
        notes: 'Clean A+ map. Yellow floor at 5840 with clear skies to King at 5880.'
      }
    });
  }

  // Validate map grade meets minimum
  var grades = Object.keys(config.map_grading.grades);
  var gradeIndex = grades.indexOf(body.map_grade);
  var minIndex = grades.indexOf(config.map_grading.min_trade_grade);
  if (gradeIndex > minIndex) {
    return res.status(400).json({
      warning: 'Map grade ' + body.map_grade + ' is below minimum tradeable grade (' + config.map_grading.min_trade_grade + ')',
      commandment: config.ten_commandments[0],
      recommendation: 'Cash is a position. Wait for a cleaner map.'
    });
  }

  // Calculate R:R
  var risk = Math.abs(body.entry_price - body.stop_price);
  var reward = Math.abs(body.target_price - body.entry_price);
  var rr = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;

  if (rr < config.min_rr_ratio && !body.force) {
    return res.status(400).json({
      warning: 'R:R ratio ' + rr + ':1 is below minimum ' + config.min_rr_ratio + ':1',
      recommendation: 'Adjust entry, target, or stop to improve risk/reward.'
    });
  }

  // ── Methodology Scoring ──
  var analysisData = {
    map_grade: body.map_grade,
    vix_level: body.vix_level,
    vix_direction: body.vix_direction,
    vex_alignment: body.vex_alignment,
    pattern: body.pattern,
    risk_reward: rr,
    floor_nodes: body.floor_nodes,
    gatekeeper_nodes: body.gatekeeper_nodes,
    trinity_data: body.trinity_data,
    target_strike: body.king_node ? body.king_node.strike : null
  };

  var score = buildAnalysisScore(analysisData);
  var commandmentCheck = checkCommandments(analysisData);

  if (commandmentCheck.blocked && !body.force) {
    return res.status(400).json({
      blocked: true,
      violations: commandmentCheck.violations,
      message: 'Trade blocked by Commandment violation. Submit with force: true to override.'
    });
  }

  // VIX assessment
  var vixAssessment = null;
  if (body.vix_level && body.vix_direction) {
    vixAssessment = buildVixAssessment(body.vix_level, body.vix_direction);
  }

  // Pattern validation
  var patternValidation = null;
  if (body.pattern && body.nodes) {
    patternValidation = validatePatternSetup(body.pattern, body.nodes, body.entry_price);
  }

  // Trinity assessment
  var trinityAssessment = null;
  if (body.trinity_data) {
    trinityAssessment = assessTrinityAlignment(body.trinity_data);
  }

  // Record node snapshots if provided
  if (body.king_node && body.king_node.strike) {
    recordNodeValue(body.king_node.strike, body.king_node.gex_value || 0, body.king_node.vex_value || 0);
  }
  if (body.floor_nodes) {
    body.floor_nodes.forEach(function(n) {
      if (n.strike) recordNodeValue(n.strike, n.gex_value || 0, n.vex_value || 0);
    });
  }
  if (body.gatekeeper_nodes) {
    body.gatekeeper_nodes.forEach(function(n) {
      if (n.strike) recordNodeValue(n.strike, n.gex_value || 0, n.vex_value || 0);
    });
  }

  // Build the signal
  var signal = {
    id: generateSignalId(),
    symbol: body.symbol.toUpperCase(),
    direction: body.direction,
    source: 'heatseeker_gex_vex',
    mode: 'market_hours',
    map_grade: body.map_grade,
    pattern: body.pattern || 'manual_analysis',
    king_node: body.king_node || null,
    gatekeeper_nodes: body.gatekeeper_nodes || [],
    floor_nodes: body.floor_nodes || [],
    air_pockets: body.air_pockets || [],
    entry_price: parseFloat(body.entry_price),
    target_price: parseFloat(body.target_price),
    stop_price: parseFloat(body.stop_price),
    risk_reward: rr,
    vex_alignment: body.vex_alignment || 'unknown',
    vix_assessment: vixAssessment,
    pattern_validation: patternValidation,
    trinity_assessment: trinityAssessment,
    methodology_score: score,
    commandment_check: commandmentCheck,
    confidence: score.final_confidence,
    recommended_sizing: score.recommended_sizing || 'speculative',
    notes: body.notes || '',
    timestamp: now(),
    status: 'pending'
  };

  activeAnalysis = signal;
  signals.push(signal);
  if (signals.length > 100) signals = signals.slice(-100);

  console.log('[heatseeker] Signal: ' + signal.id + ' ' + signal.direction + ' ' + signal.symbol +
    ' (grade: ' + body.map_grade + ', R:R ' + rr + ':1, confidence: ' + score.final_confidence + ')');

  var responseWarnings = score.warnings.slice();
  if (commandmentCheck.warning_count > 0) {
    commandmentCheck.violations.forEach(function(v) {
      if (v.severity === 'warn') responseWarnings.push('Commandment #' + v.commandment + ': ' + v.rule);
    });
  }

  res.status(201).json({
    signal_id: signal.id,
    direction: signal.direction,
    symbol: signal.symbol,
    map_grade: body.map_grade,
    risk_reward: rr + ':1',
    confidence: score.final_confidence,
    recommended_sizing: signal.recommended_sizing,
    regime: vixAssessment ? vixAssessment.regime : 'unknown',
    warnings: responseWarnings,
    commandment_violations: commandmentCheck.warning_count,
    status: 'pending — awaiting Risk Management check and Trade Approval',
    message: 'Signal created with methodology scoring. Route to Trade Approval.'
  });
});

// Current analysis
app.get('/analysis', function(req, res) {
  if (!activeAnalysis) {
    return res.json({ active_analysis: null, message: 'No active Heatseeker analysis. Submit via POST /analyze.' });
  }
  res.json({ active_analysis: activeAnalysis });
});

// All signals
app.get('/signals', function(req, res) {
  var limit = parseInt(req.query.limit) || 20;
  res.json({
    signals: signals.slice(-limit),
    total: signals.length,
    timestamp: now()
  });
});

// Active (pending) signals
app.get('/signals/active', function(req, res) {
  var active = signals.filter(function(s) { return s.status === 'pending'; });
  res.json({ active_signals: active, count: active.length });
});

// Single signal
app.get('/signals/:id', function(req, res) {
  var signal = signals.find(function(s) { return s.id === req.params.id; });
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  res.json(signal);
});

// Invalidate a signal
app.post('/signals/:id/invalidate', function(req, res) {
  var signal = signals.find(function(s) { return s.id === req.params.id; });
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
app.get('/ta-signals', function(req, res) {
  res.json({ ta_signals: taSignals.slice(-20), total: taSignals.length });
});

// ─── Node Classification & Tracking ─────────────────────────────────────────

app.post('/node/classify', function(req, res) {
  var body = req.body;
  if (!body.strike || body.gex_value === undefined || !body.spot_price) {
    return res.status(400).json({ error: 'Required: strike, gex_value, spot_price' });
  }

  var classification = classifyNodeRole(body.gex_value, body.strike, body.spot_price);
  var specFilter = isSpeculativeNode(body.strike, body.gex_value, body.spot_price);

  // Add VEX interaction if provided
  var vexInteraction = null;
  if (body.vex_value !== undefined && body.vix_level && body.vix_direction) {
    var gex_sign = body.gex_value > 0 ? '+' : '-';
    var vex_sign = body.vex_value > 0 ? '+' : '-';
    var quality = getVexQualityMultiplier(gex_sign, vex_sign);
    vexInteraction = {
      vex_value: body.vex_value,
      gex_vex_alignment: quality.description,
      effective_pull_multiplier: quality.multiplier,
      vix_regime: buildVixAssessment(body.vix_level, body.vix_direction)
    };
  }

  res.json({
    strike: body.strike,
    gex_value: body.gex_value,
    classification: classification,
    speculative_filter: specFilter,
    vex_interaction: vexInteraction,
    gatekeeper_tests: classification.role === 'gatekeeper' ? getGatekeeperTestCount(body.strike) : null
  });
});

app.post('/node/record', function(req, res) {
  var body = req.body;
  if (!body.strike || body.gex_value === undefined) {
    return res.status(400).json({ error: 'Required: strike, gex_value. Optional: vex_value' });
  }

  recordNodeValue(body.strike, body.gex_value, body.vex_value);
  var lifecycle = detectNodeLifecycle(body.strike);

  res.json({
    strike: body.strike,
    recorded: true,
    lifecycle: lifecycle
  });
});

app.get('/node/:strike/history', function(req, res) {
  var key = req.params.strike;
  var history = nodeHistory[key];
  if (!history || history.length === 0) {
    return res.json({ strike: key, history: [], message: 'No recorded history for this strike' });
  }

  var lifecycle = detectNodeLifecycle(parseInt(key));

  res.json({
    strike: key,
    history: history,
    snapshots: history.length,
    lifecycle: lifecycle
  });
});

// ─── Gatekeeper Tracking ─────────────────────────────────────────────────────

app.post('/gatekeeper/test', function(req, res) {
  if (!req.body.strike) {
    return res.status(400).json({ error: 'Required: strike' });
  }
  var result = recordGatekeeperTest(req.body.strike);
  res.json(result);
});

app.get('/gatekeeper/status', function(req, res) {
  var status = {};
  Object.keys(gatekeeperTests).forEach(function(key) {
    status[key] = {
      test_count: gatekeeperTests[key].count,
      last_test: gatekeeperTests[key].tests.length > 0
        ? gatekeeperTests[key].tests[gatekeeperTests[key].tests.length - 1].timestamp
        : null,
      probability_note: gatekeeperTests[key].count >= 3
        ? '3rd+ test — 66% BREAKTHROUGH probability'
        : 'Test #' + gatekeeperTests[key].count + ' — 66% rejection probability'
    };
  });
  res.json({ gatekeepers: status, tracked: Object.keys(status).length });
});

// ─── Trinity Alignment ───────────────────────────────────────────────────────

app.post('/trinity', function(req, res) {
  var body = req.body;
  // Expects: { SPX: { king_strike, king_gex, king_vex, spot }, SPY: {...}, QQQ: {...} }
  if (!body.SPX && !body.SPY && !body.QQQ) {
    return res.status(400).json({
      error: 'Provide at least 2 of: SPX, SPY, QQQ',
      format: '{ "SPX": { "king_strike": 6600, "king_gex": 30, "king_vex": 25, "spot": 6571 }, ... }'
    });
  }

  var result = assessTrinityAlignment(body);
  res.json(result);
});

app.get('/trinity', function(req, res) {
  if (!trinityState || !trinityState.pulls) {
    return res.json({ trinity: null, message: 'No Trinity data submitted yet. POST to /trinity.' });
  }
  res.json(trinityState);
});

// ─── VIX Assessment ──────────────────────────────────────────────────────────

app.post('/vix/assess', function(req, res) {
  if (!req.body.vix_level || !req.body.vix_direction) {
    return res.status(400).json({
      error: 'Required: vix_level (number), vix_direction ("dropping" or "rising")'
    });
  }
  var assessment = buildVixAssessment(req.body.vix_level, req.body.vix_direction);
  res.json(assessment);
});

// ─── Methodology Reference Endpoints ─────────────────────────────────────────

app.get('/methodology/patterns', function(req, res) {
  res.json({
    patterns: config.patterns,
    node_behaviors: config.node_behaviors_cheat_sheet,
    node_types: config.node_types,
    strike_selection: config.strike_selection_by_map_type
  });
});

app.get('/methodology/dealer-behavior', function(req, res) {
  res.json({
    dealer_behavior: config.dealer_behavior_reference,
    vex_quality_adjustment: config.vex_quality_adjustment,
    gatekeeper_vex_interaction: config.gatekeeper_vex_interaction,
    vix_matrix: config.vix_matrix
  });
});

app.get('/methodology/commandments', function(req, res) {
  res.json({
    ten_commandments: config.ten_commandments,
    critical_rules: config.critical_rules,
    position_sizing: config.position_sizing,
    operational_rules: config.operational_rules
  });
});

// ─── Gap Fill Pattern Check ──────────────────────────────────────────────────

app.post('/gap-check/:symbol', async function(req, res) {
  var symbol = req.params.symbol.toUpperCase();
  try {
    var sessionRes = await fetch(config.market_data_url + '/session/' + symbol, {
      signal: AbortSignal.timeout(3000)
    });
    if (!sessionRes.ok) return res.status(502).json({ error: 'Market data unavailable' });
    var session = await sessionRes.json();

    if (!session.gap_analysis) {
      return res.json({ pattern_active: false, reason: 'No gap detected today' });
    }

    var gap = session.gap_analysis;
    var ct = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    var d = new Date(ct);
    var minutes_since_open = (d.getHours() * 60 + d.getMinutes()) - (8 * 60 + 30);

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
        minutes_since_open: minutes_since_open,
        recommendation: 'Short-only bias. Block new long entries.',
        source: 'Pattern #1 — TheQuietCalf / SKY Discord'
      });
    }

    res.json({
      pattern_active: false,
      gap_size: gap.gap_size,
      gap_filled: gap.gap_filled,
      minutes_since_open: minutes_since_open,
      reason: gap.gap_filled ? 'Gap was filled — pattern not triggered' : 'Gap too large or not enough time elapsed'
    });
  } catch (err) {
    res.status(502).json({ error: 'Market data check failed: ' + err.message });
  }
});

// ─── Rolling Ceiling/Floor Endpoints ─────────────────────────────────────────

app.post('/rolling-levels', function(req, res) {
  var body = req.body;
  if (!body.nodes || !body.spot_price) {
    return res.status(400).json({
      error: 'Required: nodes (array of { strike, gex_value, vex_value }), spot_price',
      example: {
        spot_price: 5870,
        nodes: [
          { strike: 5900, gex_value: 35, vex_value: 20 },
          { strike: 5880, gex_value: 50, vex_value: 30 },
          { strike: 5850, gex_value: 25, vex_value: 15 },
          { strike: 5820, gex_value: -20, vex_value: -10 }
        ]
      }
    });
  }

  var snapshot = updateRollingLevels(body);
  var compression = detectCeilingFloorCompression();

  res.json({
    snapshot: snapshot,
    ceilings: rollingLevels.ceilings,
    floors: rollingLevels.floors,
    compression_signals: compression,
    history_depth: rollingLevels.history.length,
    message: compression
      ? 'COMPRESSION DETECTED — ' + compression.length + ' signal(s). Review compression_signals.'
      : 'Levels updated. No compression detected yet (need 3+ snapshots).'
  });
});

app.get('/rolling-levels', function(req, res) {
  if (!rollingLevels.last_updated) {
    return res.json({ message: 'No rolling levels data. Submit map snapshots via POST /rolling-levels.' });
  }

  var compression = detectCeilingFloorCompression();

  res.json({
    ceilings: rollingLevels.ceilings,
    floors: rollingLevels.floors,
    compression_signals: compression,
    history_depth: rollingLevels.history.length,
    last_updated: rollingLevels.last_updated,
    latest_snapshot: rollingLevels.history.length > 0
      ? rollingLevels.history[rollingLevels.history.length - 1]
      : null
  });
});

// ─── Daily Reset ─────────────────────────────────────────────────────────────

app.post('/reset-daily', function(req, res) {
  var previousCounts = {
    signals: signals.length,
    gatekeepers: Object.keys(gatekeeperTests).length,
    nodes: Object.keys(nodeHistory).length
  };

  signals = [];
  taSignals = [];
  activeAnalysis = null;
  gatekeeperTests = {};
  // Keep node history — it's useful across days for lifecycle tracking
  trinityState = {};
  rollingLevels = { ceilings: [], floors: [], history: [], last_updated: null };

  console.log('[heatseeker] Daily reset complete');
  res.json({
    reset: true,
    cleared: previousCounts,
    note: 'Node history preserved for lifecycle tracking. Trinity state cleared.',
    timestamp: now()
  });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

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

app.listen(PORT, function() {
  console.log('[heatseeker] v' + config.version + ' running on port ' + PORT);
  console.log('[heatseeker] Methodology: ' + Object.keys(config.patterns).length + ' patterns, ' +
    config.node_behaviors_cheat_sheet.length + ' node behaviors, ' +
    config.ten_commandments.length + ' commandments loaded');
  selfRegister();
  setTimeout(scanForTASignals, 10000);
});
