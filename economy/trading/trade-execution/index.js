const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8114;
const SERVICE_NAME = 'trade-execution';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ─── Order Store ─────────────────────────────────────────────────────────────

let orders = [];           // all orders (open, filled, cancelled)
let executionLog = [];     // execution audit trail

// ─── Helper Functions ────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function generateOrderId() {
  return 'ORD-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
}

function logExecution(type, details) {
  const entry = {
    id: 'EX-' + Date.now().toString(36),
    type,
    details,
    timestamp: now()
  };
  executionLog.push(entry);
  if (executionLog.length > 500) executionLog = executionLog.slice(-500);
  console.log('[trade-execution] ' + type + ': ' + (details.order_id || '') + ' ' + (details.symbol || ''));
  return entry;
}

// ─── Economy Telemetry ───────────────────────────────────────────────────────
// Fire-and-forget: broadcast trade events to supply economy services.
// Treasury receives P&L data for cost/revenue tracking.
// Perf-Observability receives trade metrics for performance dashboards.

async function notifyEconomy(event, data) {
  const payload = { event, source: SERVICE_NAME, timestamp: now(), ...data };

  if (config.treasury_url) {
    fetch(config.treasury_url + '/trading/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000)
    }).catch(err => console.log('[trade-execution] Treasury notify failed: ' + err.message));
  }

  if (config.perf_observability_url) {
    fetch(config.perf_observability_url + '/trading/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000)
    }).catch(err => console.log('[trade-execution] PerfObs notify failed: ' + err.message));
  }
}

async function notifyRiskManagement(action, data) {
  try {
    const endpoint = action === 'open'
      ? config.risk_management_url + '/position/open'
      : config.risk_management_url + '/position/' + data.position_id + '/close';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const result = await res.json();
      return result;
    }
  } catch (err) {
    console.log('[trade-execution] Risk notification failed: ' + err.message);
  }
  return null;
}

async function getCurrentPrice(symbol) {
  try {
    const res = await fetch(config.market_data_url + '/prices/' + symbol, {
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json();
      return data.last || data.price || null;
    }
  } catch (err) {}
  return null;
}

// ─── Stop Order Store ────────────────────────────────────────────────────────

let pendingStopOrders = [];  // stop_buy / stop_sell orders waiting to trigger

// ─── Simulated Execution Adapter ─────────────────────────────────────────────

async function simulatedExecute(order) {
  const simConfig = config.execution_adapter.adapters.simulated;

  // Stop orders don't fill immediately — they go to pending until trigger price is hit
  if (order.order_type === 'stop_buy' || order.order_type === 'stop_sell') {
    order.status = 'pending_trigger';
    order.trigger_price = order.entry_price; // entry_price IS the trigger for stop orders
    pendingStopOrders.push(order);

    logExecution('stop_order_placed', {
      order_id: order.id,
      type: order.order_type,
      symbol: order.symbol,
      trigger_price: order.trigger_price,
      direction: order.direction,
      message: order.order_type === 'stop_buy'
        ? 'Buy stop placed ABOVE market. Will trigger on reclaim to ' + order.trigger_price
        : 'Sell stop placed BELOW market. Will trigger on drop to ' + order.trigger_price
    });

    return {
      filled: false,
      pending_trigger: true,
      trigger_price: order.trigger_price,
      reason: order.order_type === 'stop_buy'
        ? 'Stop buy waiting for price to rise to ' + order.trigger_price + '. Placed above market for entry on reclaim after sweep.'
        : 'Stop sell waiting for price to drop to ' + order.trigger_price + '. Placed below market for entry on rejection after grab.',
      adapter: 'simulated'
    };
  }

  return new Promise((resolve) => {
    setTimeout(async () => {
      // Simulate fill rate
      if (Math.random() > simConfig.fill_rate) {
        resolve({
          filled: false,
          reason: 'Simulated: no fill (market moved away)',
          fill_price: null
        });
        return;
      }

      // Get current market price for realistic fill
      let fillPrice = order.entry_price;
      const marketPrice = await getCurrentPrice(order.symbol);
      if (marketPrice) {
        // Apply slippage
        const slippage = simConfig.slippage_ticks * config.instruments[order.symbol].tick_size;
        if (order.direction === 'long') {
          fillPrice = marketPrice + slippage;
        } else {
          fillPrice = marketPrice - slippage;
        }
      }

      resolve({
        filled: true,
        fill_price: parseFloat(fillPrice.toFixed(2)),
        fill_time: now(),
        slippage_ticks: simConfig.slippage_ticks,
        adapter: 'simulated'
      });
    }, simConfig.fill_delay_ms);
  });
}

// ─── Stop Order Monitoring (Simulated) ──────────────────────────────────────

async function monitorStopOrders() {
  if (pendingStopOrders.length === 0) return;

  for (let i = pendingStopOrders.length - 1; i >= 0; i--) {
    const stopOrder = pendingStopOrders[i];
    const price = await getCurrentPrice(stopOrder.symbol);
    if (!price) continue;

    let triggered = false;

    if (stopOrder.order_type === 'stop_buy' && price >= stopOrder.trigger_price) {
      triggered = true;
    } else if (stopOrder.order_type === 'stop_sell' && price <= stopOrder.trigger_price) {
      triggered = true;
    }

    if (triggered) {
      // Remove from pending
      pendingStopOrders.splice(i, 1);

      const simConfig = config.execution_adapter.adapters.simulated;
      const slippage = simConfig.slippage_ticks * config.instruments[stopOrder.symbol].tick_size;
      const fillPrice = stopOrder.direction === 'long'
        ? price + slippage
        : price - slippage;

      stopOrder.status = 'filled';
      stopOrder.fill_price = parseFloat(fillPrice.toFixed(2));
      stopOrder.filled_at = now();
      stopOrder.slippage = simConfig.slippage_ticks;

      logExecution('stop_order_triggered', {
        order_id: stopOrder.id,
        type: stopOrder.order_type,
        symbol: stopOrder.symbol,
        trigger_price: stopOrder.trigger_price,
        fill_price: stopOrder.fill_price,
        market_price_at_trigger: price
      });

      // Create bracket orders
      if (config.order_defaults.bracket_enabled && stopOrder.stop_price && stopOrder.target_price) {
        stopOrder.bracket_orders = {
          stop_loss: {
            id: generateOrderId(),
            type: 'stop_market',
            price: stopOrder.stop_price,
            status: 'working',
            created_at: now()
          },
          take_profit: {
            id: generateOrderId(),
            type: 'limit',
            price: stopOrder.target_price,
            status: 'working',
            created_at: now()
          }
        };
        logExecution('bracket_placed', {
          order_id: stopOrder.id,
          stop_id: stopOrder.bracket_orders.stop_loss.id,
          target_id: stopOrder.bracket_orders.take_profit.id,
          stop_price: stopOrder.stop_price,
          target_price: stopOrder.target_price
        });
      }

      // Notify risk management
      const riskPosition = await notifyRiskManagement('open', {
        symbol: stopOrder.symbol,
        direction: stopOrder.direction,
        contracts: stopOrder.contracts,
        entry_price: stopOrder.fill_price,
        stop_price: stopOrder.stop_price,
        target_price: stopOrder.target_price,
        signal_id: stopOrder.signal_id
      });
      if (riskPosition && riskPosition.id) {
        stopOrder.risk_position_id = riskPosition.id;
      }

      console.log('[trade-execution] STOP TRIGGERED: ' + stopOrder.order_type + ' ' + stopOrder.symbol +
        ' @ ' + stopOrder.fill_price + ' (trigger was ' + stopOrder.trigger_price + ')');
    }
  }
}

// Monitor stop orders every 3 seconds in simulated mode
if (config.execution_adapter.active === 'simulated') {
  setInterval(monitorStopOrders, 3000);
}


// ─── ProjectX Execution Adapter (Universal Broker Gateway) ──────────────────
// Covers: TopstepX (active), TFD, FuturesElite, Bulenox (v2_pending)
// Docs: https://gateway.docs.projectx.com
// Auth: JWT via /api/Auth/loginKey — 24h token, cached in-process
// Fill monitoring: polling /api/Order/search every 2s (SignalR upgrade = v2 TODO)

// ── ProjectX order type enum ──────────────────────────────────────────────────
const PX_ORDER_TYPE = { Limit: 1, Market: 2, StopLimit: 3, Stop: 4, TrailingStop: 5 };
const PX_SIDE       = { Buy: 1, Sell: 2 };

// ── In-process state (survives restarts only if adapter stays active) ─────────
const pxState = {
  token: null,
  tokenExpiry: null,       // Date
  accountId: null,
  contractCache: {},       // { 'ES': 'CON.F.US.ES.M25', ... }
};

// ── Auth — get/refresh JWT ────────────────────────────────────────────────────
async function pxGetToken(firmConfig) {
  // Return cached token if still valid (with 5-min buffer)
  if (pxState.token && pxState.tokenExpiry && new Date() < new Date(pxState.tokenExpiry.getTime() - 300000)) {
    return pxState.token;
  }

  const res = await fetch(`${firmConfig.api_base}/api/Auth/loginKey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: firmConfig.username, apiKey: firmConfig.api_key }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await res.json();
  if (!data.success || !data.token) {
    throw new Error(`ProjectX auth failed: ${data.errorMessage || 'unknown error'}`);
  }

  pxState.token = data.token;
  pxState.tokenExpiry = new Date(Date.now() + 23 * 3600 * 1000); // 23h (24h JWT)
  console.log(`[trade-execution] ProjectX auth OK — token valid until ${pxState.tokenExpiry.toISOString()}`);
  return pxState.token;
}

// ── Account lookup — get accountId ───────────────────────────────────────────
async function pxGetAccountId(firmConfig, token) {
  if (pxState.accountId) return pxState.accountId;

  const res = await fetch(`${firmConfig.api_base}/api/Account/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ onlyActiveAccounts: true }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await res.json();
  if (!data.success || !data.accounts || data.accounts.length === 0) {
    throw new Error(`ProjectX account lookup failed: ${data.errorMessage || 'no active accounts'}`);
  }

  // Use configured account_id if specified, otherwise take first active tradable account
  let account = data.accounts.find(a => a.canTrade);
  if (firmConfig.account_id) {
    account = data.accounts.find(a => String(a.id) === String(firmConfig.account_id)) || account;
  }

  if (!account) throw new Error('No tradable ProjectX account found');

  pxState.accountId = account.id;
  console.log(`[trade-execution] ProjectX account: ${account.name} (id: ${account.id})`);
  return pxState.accountId;
}

// ── Contract ID lookup — symbol → ProjectX contractId ────────────────────────
async function pxGetContractId(firmConfig, token, symbol) {
  if (pxState.contractCache[symbol]) return pxState.contractCache[symbol];

  const res = await fetch(`${firmConfig.api_base}/api/Contract/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ searchText: symbol, live: true }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await res.json();
  if (!data.success || !data.contracts || data.contracts.length === 0) {
    throw new Error(`ProjectX contract lookup failed for ${symbol}: ${data.errorMessage || 'no contracts found'}`);
  }

  // Find front-month contract (lowest expiry that is still active)
  const now = new Date();
  const active = data.contracts
    .filter(c => c.isActive && (!c.expirationDate || new Date(c.expirationDate) > now))
    .sort((a, b) => new Date(a.expirationDate || 9999999999) - new Date(b.expirationDate || 9999999999));

  if (!active.length) throw new Error(`No active front-month contract found for ${symbol}`);

  pxState.contractCache[symbol] = active[0].id;
  console.log(`[trade-execution] ProjectX contract: ${symbol} → ${active[0].id} (${active[0].name || ''})`);
  return pxState.contractCache[symbol];
}

// ── Map our order type string to ProjectX enum ────────────────────────────────
function pxMapOrderType(orderType) {
  switch (orderType) {
    case 'limit':      return PX_ORDER_TYPE.Limit;
    case 'market':     return PX_ORDER_TYPE.Market;
    case 'stop_buy':   return PX_ORDER_TYPE.Stop;   // Buy stop — triggers on rise to stopPrice
    case 'stop_sell':  return PX_ORDER_TYPE.Stop;   // Sell stop — triggers on drop to stopPrice
    case 'stop_limit': return PX_ORDER_TYPE.StopLimit;
    default:           return PX_ORDER_TYPE.Limit;
  }
}

// ── Poll for order fill ───────────────────────────────────────────────────────
// Polls /api/Order/search every 2s until filled or timeout (60s)
// TODO v2: replace with SignalR hub subscription (hubs/user → OrderUpdated)
async function pxWaitForFill(firmConfig, token, orderId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));

    const res = await fetch(`${firmConfig.api_base}/api/Order/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ orderId }),
      signal: AbortSignal.timeout(5000)
    }).catch(() => null);

    if (!res || !res.ok) continue;
    const data = await res.json();
    const orders = data.orders || [];
    const o = orders.find(x => x.id === orderId);
    if (!o) continue;

    // Status: 1=Working, 2=Filled, 3=Cancelled, 4=Rejected, 5=Expired
    if (o.status === 2) {
      return { filled: true, fill_price: o.avgFillPrice || o.limitPrice || o.stopPrice, order: o };
    }
    if (o.status >= 3) {
      return { filled: false, reason: `Order ${orderId} status: ${o.status}`, order: o };
    }
  }

  return { filled: false, reason: `Order ${orderId} fill timeout after ${timeoutMs / 1000}s` };
}

// ── Place bracket (stop loss + take profit) after entry fill ─────────────────
async function pxPlaceBracket(firmConfig, token, accountId, contractId, order, fillPrice) {
  const isLong = order.direction === 'long';
  const results = {};

  // Stop loss
  if (order.stop_price) {
    const slRes = await fetch(`${firmConfig.api_base}/api/Order/place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        accountId,
        contractId,
        type: PX_ORDER_TYPE.Stop,
        side: isLong ? PX_SIDE.Sell : PX_SIDE.Buy,
        size: order.contracts,
        stopPrice: order.stop_price,
        timeInForce: 'GTC'
      }),
      signal: AbortSignal.timeout(10000)
    });
    const slData = await slRes.json();
    results.stop_loss = slData.success ? { id: slData.orderId, price: order.stop_price } : { error: slData.errorMessage };
  }

  // Take profit
  if (order.target_price) {
    const tpRes = await fetch(`${firmConfig.api_base}/api/Order/place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        accountId,
        contractId,
        type: PX_ORDER_TYPE.Limit,
        side: isLong ? PX_SIDE.Sell : PX_SIDE.Buy,
        size: order.contracts,
        limitPrice: order.target_price,
        timeInForce: 'GTC'
      }),
      signal: AbortSignal.timeout(10000)
    });
    const tpData = await tpRes.json();
    results.take_profit = tpData.success ? { id: tpData.orderId, price: order.target_price } : { error: tpData.errorMessage };
  }

  return results;
}

// ── Main projectxExecute ──────────────────────────────────────────────────────
async function projectxExecute(order) {
  const pxConfig = config.execution_adapter.adapters.projectx;
  const activeFirmKey = pxConfig.active_firm;
  const firmConfig = pxConfig.firms[activeFirmKey];

  if (!firmConfig || !firmConfig.configured || !firmConfig.api_key) {
    return {
      filled: false,
      reason: `ProjectX not configured for firm: ${activeFirmKey}. Use POST /configure-projectx`,
      adapter: 'projectx',
      active_firm: activeFirmKey
    };
  }

  try {
    // 1. Auth
    const token = await pxGetToken(firmConfig);

    // 2. Account
    const accountId = await pxGetAccountId(firmConfig, token);

    // 3. Contract ID
    const contractId = await pxGetContractId(firmConfig, token, order.symbol);

    // 4. Map order side
    const side = (order.direction === 'long') ? PX_SIDE.Buy : PX_SIDE.Sell;
    const orderType = pxMapOrderType(order.order_type || 'stop_buy');

    // 5. Build order payload
    const payload = {
      accountId,
      contractId,
      type: orderType,
      side,
      size: order.contracts,
      timeInForce: 'DAY'
    };

    // Attach prices based on order type
    if (order.entry_price) {
      if (orderType === PX_ORDER_TYPE.Limit)      payload.limitPrice = order.entry_price;
      if (orderType === PX_ORDER_TYPE.Stop)        payload.stopPrice  = order.entry_price;
      if (orderType === PX_ORDER_TYPE.StopLimit) { payload.stopPrice  = order.entry_price; payload.limitPrice = order.entry_price; }
    }

    console.log(`[trade-execution] ProjectX placing order: ${order.symbol} ${order.direction} ×${order.contracts} ${order.order_type} @ ${order.entry_price}`);

    // 6. Place entry order
    const placeRes = await fetch(`${firmConfig.api_base}/api/Order/place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    const placeData = await placeRes.json();
    if (!placeData.success) {
      throw new Error(`Order placement failed: ${placeData.errorMessage}`);
    }

    const pxOrderId = placeData.orderId;
    console.log(`[trade-execution] ProjectX order placed: ${pxOrderId}`);

    // 7. For stop orders — return pending_trigger (don't poll; they wait for price)
    if (orderType === PX_ORDER_TYPE.Stop || orderType === PX_ORDER_TYPE.StopLimit) {
      return {
        filled: false,
        pending_trigger: true,
        trigger_price: order.entry_price,
        px_order_id: pxOrderId,
        reason: `Stop order ${pxOrderId} placed. Waiting for price to reach ${order.entry_price}.`,
        adapter: 'projectx',
        active_firm: activeFirmKey
      };
    }

    // 8. For limit/market orders — poll for fill
    const fillResult = await pxWaitForFill(firmConfig, token, pxOrderId);

    if (!fillResult.filled) {
      return { filled: false, reason: fillResult.reason, px_order_id: pxOrderId, adapter: 'projectx' };
    }

    const fillPrice = fillResult.fill_price;
    console.log(`[trade-execution] ProjectX filled: ${pxOrderId} @ ${fillPrice}`);

    // 9. Place bracket orders after fill
    let bracketOrders = null;
    if (config.order_defaults.bracket_enabled && (order.stop_price || order.target_price)) {
      bracketOrders = await pxPlaceBracket(firmConfig, token, accountId, contractId, order, fillPrice);
    }

    return {
      filled: true,
      fill_price: fillPrice,
      fill_time: now(),
      px_order_id: pxOrderId,
      bracket_orders: bracketOrders ? {
        stop_loss:   bracketOrders.stop_loss?.price  || null,
        take_profit: bracketOrders.take_profit?.price || null,
        stop_loss_id:   bracketOrders.stop_loss?.id  || null,
        take_profit_id: bracketOrders.take_profit?.id || null
      } : null,
      adapter: 'projectx',
      active_firm: activeFirmKey,
      firm_label: firmConfig.label
    };

  } catch (err) {
    console.error(`[trade-execution] ProjectX error: ${err.message}`);
    return {
      filled: false,
      reason: `ProjectX error: ${err.message}`,
      adapter: 'projectx',
      active_firm: activeFirmKey
    };
  }
}

// ─── Execute Trade ───────────────────────────────────────────────────────────

async function executeTrade(proposal) {
  const order = {
    id: generateOrderId(),
    approval_id: proposal.approval_id || proposal.id || null,
    signal_id: proposal.signal_id || null,
    symbol: (proposal.symbol || '').toUpperCase(),
    direction: proposal.direction,
    contracts: proposal.contracts || 1,
    entry_price: parseFloat(proposal.entry_price),
    stop_price: proposal.stop_price ? parseFloat(proposal.stop_price) : null,
    target_price: proposal.target_price ? parseFloat(proposal.target_price) : null,
    order_type: proposal.order_type || config.order_defaults.order_type,
    time_in_force: config.order_defaults.time_in_force,
    source: proposal.source || 'unknown',
    map_grade: proposal.map_grade || null,
    adapter: config.execution_adapter.active,
    status: 'submitting',
    created_at: now(),
    filled_at: null,
    fill_price: null,
    cancelled_at: null,
    bracket_orders: null
  };

  // Validate instrument
  if (!config.instruments[order.symbol]) {
    order.status = 'rejected';
    logExecution('order_rejected', { order_id: order.id, reason: 'Unknown instrument: ' + order.symbol });
    orders.push(order);
    return { order_id: order.id, status: 'rejected', reason: 'Unknown instrument' };
  }

  // Validate stop required
  if (config.order_defaults.stop_loss_required && !order.stop_price) {
    order.status = 'rejected';
    logExecution('order_rejected', { order_id: order.id, reason: 'Stop price required' });
    orders.push(order);
    return { order_id: order.id, status: 'rejected', reason: 'Stop price is required for all orders' };
  }

  orders.push(order);
  logExecution('order_submitted', {
    order_id: order.id,
    symbol: order.symbol,
    direction: order.direction,
    contracts: order.contracts,
    entry_price: order.entry_price,
    adapter: order.adapter
  });

  // Route to active adapter
  let result;
  if (config.execution_adapter.active === 'projectx') {
    result = await projectxExecute(order);
  } else {
    result = await simulatedExecute(order);
  }

  if (result.pending_trigger) {
    // Stop order placed but not yet triggered
    return {
      order_id: order.id,
      status: 'pending_trigger',
      order_type: order.order_type,
      symbol: order.symbol,
      direction: order.direction,
      contracts: order.contracts,
      trigger_price: result.trigger_price,
      stop_price: order.stop_price,
      target_price: order.target_price,
      message: result.reason,
      adapter: order.adapter,
      timestamp: now()
    };
  }

  if (result.filled) {
    order.status = 'filled';
    order.fill_price = result.fill_price;
    order.filled_at = result.fill_time || now();
    order.slippage = result.slippage_ticks || 0;

    logExecution('order_filled', {
      order_id: order.id,
      symbol: order.symbol,
      direction: order.direction,
      contracts: order.contracts,
      fill_price: order.fill_price,
      slippage: order.slippage,
      adapter: order.adapter
    });

    // Create bracket orders (stop + target) in simulated mode
    if (config.order_defaults.bracket_enabled && order.stop_price && order.target_price) {
      order.bracket_orders = {
        stop_loss: {
          id: generateOrderId(),
          type: 'stop_market',
          price: order.stop_price,
          status: 'working',
          created_at: now()
        },
        take_profit: {
          id: generateOrderId(),
          type: 'limit',
          price: order.target_price,
          status: 'working',
          created_at: now()
        }
      };
      logExecution('bracket_placed', {
        order_id: order.id,
        stop_id: order.bracket_orders.stop_loss.id,
        target_id: order.bracket_orders.take_profit.id,
        stop_price: order.stop_price,
        target_price: order.target_price
      });
    }

    // Notify risk management of open position
    const riskPosition = await notifyRiskManagement('open', {
      symbol: order.symbol,
      direction: order.direction,
      contracts: order.contracts,
      entry_price: order.fill_price,
      stop_price: order.stop_price,
      target_price: order.target_price,
      signal_id: order.signal_id
    });
    if (riskPosition && riskPosition.id) {
      order.risk_position_id = riskPosition.id;
    }

    // Notify supply economy: trade opened
    notifyEconomy('trade_opened', {
      order_id: order.id,
      symbol: order.symbol,
      direction: order.direction,
      contracts: order.contracts,
      fill_price: order.fill_price,
      stop_price: order.stop_price,
      target_price: order.target_price,
      adapter: order.adapter,
      signal_id: order.signal_id
    });

    return {
      order_id: order.id,
      status: 'filled',
      symbol: order.symbol,
      direction: order.direction,
      contracts: order.contracts,
      fill_price: order.fill_price,
      slippage: order.slippage,
      bracket_orders: order.bracket_orders ? {
        stop_loss: order.bracket_orders.stop_loss.price,
        take_profit: order.bracket_orders.take_profit.price
      } : null,
      adapter: order.adapter,
      timestamp: order.filled_at
    };
  } else {
    order.status = 'not_filled';
    order.not_filled_reason = result.reason;
    logExecution('order_not_filled', { order_id: order.id, reason: result.reason });
    return {
      order_id: order.id,
      status: 'not_filled',
      reason: result.reason,
      adapter: order.adapter
    };
  }
}

// ─── Bracket Monitoring (Simulated) ──────────────────────────────────────────

async function monitorBrackets() {
  const openOrders = orders.filter(o => o.status === 'filled' && o.bracket_orders);

  for (const order of openOrders) {
    const price = await getCurrentPrice(order.symbol);
    if (!price) continue;

    const stop = order.bracket_orders.stop_loss;
    const target = order.bracket_orders.take_profit;

    if (stop.status !== 'working' && target.status !== 'working') continue;

    let triggered = null;

    if (order.direction === 'long') {
      if (price <= stop.price && stop.status === 'working') triggered = 'stop_loss';
      else if (price >= target.price && target.status === 'working') triggered = 'take_profit';
    } else {
      if (price >= stop.price && stop.status === 'working') triggered = 'stop_loss';
      else if (price <= target.price && target.status === 'working') triggered = 'take_profit';
    }

    if (triggered) {
      const exitPrice = triggered === 'stop_loss' ? stop.price : target.price;

      // Cancel the other side
      if (triggered === 'stop_loss') {
        stop.status = 'filled';
        stop.filled_at = now();
        target.status = 'cancelled';
        target.cancelled_at = now();
      } else {
        target.status = 'filled';
        target.filled_at = now();
        stop.status = 'cancelled';
        stop.cancelled_at = now();
      }

      order.status = 'closed';
      order.closed_at = now();
      order.exit_price = exitPrice;
      order.close_reason = triggered;

      const multiplier = config.instruments[order.symbol].multiplier;
      const pnlPerContract = order.direction === 'long'
        ? (exitPrice - order.fill_price) * multiplier
        : (order.fill_price - exitPrice) * multiplier;
      order.pnl = parseFloat((pnlPerContract * order.contracts).toFixed(2));

      logExecution('bracket_triggered', {
        order_id: order.id,
        triggered,
        exit_price: exitPrice,
        pnl: order.pnl,
        symbol: order.symbol
      });

      // Notify risk management
      await notifyRiskManagement('close', {
        position_id: order.risk_position_id,
        exit_price: exitPrice,
        reason: triggered
      });

      // Notify supply economy: trade closed with P&L
      notifyEconomy('trade_closed', {
        order_id: order.id,
        symbol: order.symbol,
        direction: order.direction,
        contracts: order.contracts,
        entry_price: order.fill_price,
        exit_price: exitPrice,
        pnl: order.pnl,
        close_reason: triggered,
        adapter: order.adapter
      });

      console.log('[trade-execution] ' + triggered.toUpperCase() + ': ' + order.symbol + ' ' + order.direction +
        ' @ ' + exitPrice + ' P&L: $' + order.pnl);
    }
  }
}

// Monitor brackets every 5 seconds in simulated mode
if (config.execution_adapter.active === 'simulated') {
  setInterval(monitorBrackets, 5000);
}

// ─── API Endpoints ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const openCount = orders.filter(o => o.status === 'filled').length;
  const filledToday = orders.filter(o => o.filled_at && o.filled_at.startsWith(new Date().toISOString().slice(0, 10))).length;
  res.json({
    service: SERVICE_NAME,
    status: 'healthy',
    timestamp: now(),
    adapter: config.execution_adapter.active,
    open_orders: openCount,
    filled_today: filledToday,
    total_orders: orders.length
  });
});

app.get('/info', (req, res) => {
  res.json({
    name: SERVICE_NAME,
    sector: 'trading',
    port: PORT,
    version: config.version,
    maturity: 'observe',
    description: 'Trade execution for ES/MES and NQ/MNQ futures. Simulated adapter active until TopstepX configured. Bracket orders with stop + target.',
    adapter: config.execution_adapter.active,
    endpoints: [
      'GET /health',
      'GET /info',
      'POST /execute — execute an approved trade',
      'GET /orders — all orders',
      'GET /orders/open — currently open orders',
      'GET /orders/:id — single order detail',
      'POST /orders/:id/cancel — cancel an open order',
      'POST /orders/:id/close — manually close at market',
      'GET /execution-log — audit trail',
      'POST /configure-projectx — set ProjectX credentials for a firm { firm, api_key, username }',
      'POST /active-firm — switch active firm within ProjectX { firm }',
      'POST /adapter — switch execution adapter (simulated/projectx)',
      'GET /orders/stops — pending stop orders waiting for trigger',
      'POST /orders/stops/:id/cancel — cancel a pending stop order',
      'POST /backtest — replay trade records through performance analysis { trades, firm? }'
    ]
  });
});

// Execute trade
app.post('/execute', async (req, res) => {
  const { symbol, direction, contracts, entry_price, stop_price, target_price } = req.body;
  if (!symbol || !direction || !entry_price) {
    return res.status(400).json({
      error: 'Required: symbol, direction, entry_price',
      recommended: 'Also provide: contracts, stop_price, target_price'
    });
  }
  const result = await executeTrade(req.body);
  const statusCode = result.status === 'filled' ? 201 : result.status === 'rejected' ? 400 : 200;
  res.status(statusCode).json(result);
});

// All orders
app.get('/orders', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ orders: orders.slice(-limit), total: orders.length, timestamp: now() });
});

// Open orders
app.get('/orders/open', (req, res) => {
  const open = orders.filter(o => o.status === 'filled');
  res.json({ orders: open, count: open.length });
});

// Single order
app.get('/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// Cancel order
app.post('/orders/:id/cancel', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'filled') {
    // Cancel bracket orders
    if (order.bracket_orders) {
      if (order.bracket_orders.stop_loss.status === 'working') {
        order.bracket_orders.stop_loss.status = 'cancelled';
        order.bracket_orders.stop_loss.cancelled_at = now();
      }
      if (order.bracket_orders.take_profit.status === 'working') {
        order.bracket_orders.take_profit.status = 'cancelled';
        order.bracket_orders.take_profit.cancelled_at = now();
      }
    }
    return res.json({ order_id: order.id, message: 'Bracket orders cancelled. Position still open — close manually.' });
  }

  if (order.status !== 'submitting') {
    return res.status(400).json({ error: 'Order cannot be cancelled in status: ' + order.status });
  }

  order.status = 'cancelled';
  order.cancelled_at = now();
  logExecution('order_cancelled', { order_id: order.id, reason: req.body.reason || 'manual' });
  res.json({ order_id: order.id, status: 'cancelled' });
});

// Close position at market
app.post('/orders/:id/close', async (req, res) => {
  const order = orders.find(o => o.id === req.params.id && o.status === 'filled');
  if (!order) return res.status(404).json({ error: 'Open order not found' });

  const exitPrice = req.body.exit_price || await getCurrentPrice(order.symbol);
  if (!exitPrice) {
    return res.status(400).json({ error: 'Could not get market price. Provide exit_price manually.' });
  }

  // Cancel bracket orders
  if (order.bracket_orders) {
    if (order.bracket_orders.stop_loss.status === 'working') {
      order.bracket_orders.stop_loss.status = 'cancelled';
    }
    if (order.bracket_orders.take_profit.status === 'working') {
      order.bracket_orders.take_profit.status = 'cancelled';
    }
  }

  order.status = 'closed';
  order.exit_price = parseFloat(exitPrice);
  order.closed_at = now();
  order.close_reason = req.body.reason || 'manual_close';

  const multiplier = config.instruments[order.symbol].multiplier;
  const pnlPerContract = order.direction === 'long'
    ? (exitPrice - order.fill_price) * multiplier
    : (order.fill_price - exitPrice) * multiplier;
  order.pnl = parseFloat((pnlPerContract * order.contracts).toFixed(2));

  logExecution('position_closed', {
    order_id: order.id,
    exit_price: exitPrice,
    pnl: order.pnl,
    reason: order.close_reason
  });

  // Notify risk management
  await notifyRiskManagement('close', {
    position_id: order.risk_position_id,
    exit_price: exitPrice,
    reason: order.close_reason
  });

  // Notify supply economy: trade closed with P&L
  notifyEconomy('trade_closed', {
    order_id: order.id,
    symbol: order.symbol,
    direction: order.direction,
    contracts: order.contracts,
    entry_price: order.fill_price,
    exit_price: order.exit_price,
    pnl: order.pnl,
    close_reason: order.close_reason,
    adapter: order.adapter
  });

  res.json({
    order_id: order.id,
    status: 'closed',
    exit_price: order.exit_price,
    pnl: order.pnl,
    close_reason: order.close_reason
  });
});

// Pending stop orders
app.get('/orders/stops', (req, res) => {
  res.json({
    pending_stop_orders: pendingStopOrders.map(o => ({
      order_id: o.id,
      type: o.order_type,
      symbol: o.symbol,
      direction: o.direction,
      contracts: o.contracts,
      trigger_price: o.trigger_price,
      stop_price: o.stop_price,
      target_price: o.target_price,
      created_at: o.created_at
    })),
    count: pendingStopOrders.length,
    note: 'These orders are waiting for price to reach trigger_price before filling.'
  });
});

// Cancel a pending stop order
app.post('/orders/stops/:id/cancel', (req, res) => {
  const idx = pendingStopOrders.findIndex(o => o.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Pending stop order not found: ' + req.params.id });
  }
  const cancelled = pendingStopOrders.splice(idx, 1)[0];
  cancelled.status = 'cancelled';
  cancelled.cancelled_at = now();
  logExecution('stop_order_cancelled', { order_id: cancelled.id, reason: req.body.reason || 'manual' });
  res.json({ order_id: cancelled.id, status: 'cancelled', message: 'Stop order cancelled before trigger.' });
});

// Execution log
app.get('/execution-log', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ log: executionLog.slice(-limit), total: executionLog.length });
});

// ─── Backtesting ─────────────────────────────────────────────────────────────
// POST /backtest — replay completed trade records through performance analysis.
// Accepts historical trades; computes win rate, P&L, profit factor, drawdown,
// R:R, and consistency rule compliance against prop firm limits.
//
// Body: { firm?: "topstepx", trades: [ { symbol, direction, contracts,
//   entry_price, exit_price, stop_price, target_price, close_reason? } ] }

app.post('/backtest', (req, res) => {
  const { trades, firm } = req.body;
  if (!Array.isArray(trades) || trades.length === 0) {
    return res.status(400).json({
      error: 'Required: trades array',
      example: {
        firm: 'topstepx',
        trades: [{ symbol: 'ES', direction: 'long', contracts: 1,
          entry_price: 5850, exit_price: 5856, stop_price: 5848,
          target_price: 5856, close_reason: 'take_profit' }]
      }
    });
  }

  // Load firm rules (optional — for compliance check)
  const pxConfig = config.execution_adapter.adapters.projectx;
  const firmKey = firm || pxConfig.active_firm || 'topstepx';
  const firmRules = pxConfig.firms[firmKey]?.firm_rules || null;

  // ── Per-trade analysis ─────────────────────────────────────────────────────
  const results = [];
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const inst = config.instruments[(t.symbol || '').toUpperCase()];
    if (!inst) { results.push({ index: i, error: 'Unknown symbol: ' + t.symbol }); continue; }

    const qty = t.contracts || 1;
    const mult = inst.multiplier * qty;
    const pnl = t.direction === 'long'
      ? (t.exit_price - t.entry_price) * mult
      : (t.entry_price - t.exit_price) * mult;
    const riskPts  = Math.abs(t.entry_price - (t.stop_price || t.entry_price));
    const rewardPts = Math.abs((t.target_price || t.exit_price) - t.entry_price);
    const plannedRR = riskPts > 0 ? parseFloat((rewardPts / riskPts).toFixed(2)) : null;
    const actualMove = Math.abs(t.exit_price - t.entry_price);
    const actualR    = riskPts > 0
      ? parseFloat((actualMove / riskPts * (pnl >= 0 ? 1 : -1)).toFixed(2))
      : null;

    results.push({
      index: i,
      symbol: (t.symbol || '').toUpperCase(),
      direction: t.direction,
      contracts: qty,
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      pnl: parseFloat(pnl.toFixed(2)),
      win: pnl > 0,
      rr_planned: plannedRR,
      actual_r: actualR,
      close_reason: t.close_reason || 'unknown'
    });
  }

  const valid = results.filter(r => !r.error);
  const wins   = valid.filter(r => r.win);
  const losses = valid.filter(r => !r.win);
  const grossWins   = wins.reduce((s, r) => s + r.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
  const totalPnl    = valid.reduce((s, r) => s + r.pnl, 0);
  const profitFactor = grossLosses > 0 ? parseFloat((grossWins / grossLosses).toFixed(2)) : null;
  const avgPlannedRR = valid.filter(r => r.rr_planned).reduce((s, r) => s + r.rr_planned, 0) /
                        (valid.filter(r => r.rr_planned).length || 1);

  // Max drawdown (running P&L peak-to-trough)
  let peak = 0, runningPnl = 0, maxDrawdown = 0;
  for (const r of valid) {
    runningPnl += r.pnl;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Max consecutive losses
  let maxConsec = 0, consec = 0;
  for (const r of valid) {
    if (!r.win) { consec++; if (consec > maxConsec) maxConsec = consec; }
    else consec = 0;
  }

  // ── Compliance checks ──────────────────────────────────────────────────────
  const compliance = {};

  if (firmRules) {
    // Daily loss limit (simplified: worst single-trade loss vs limit)
    const worstSingleLoss = losses.length > 0
      ? Math.min(...losses.map(r => r.pnl))
      : 0;
    if (firmRules.hard_stop_daily_loss) {
      compliance.daily_loss = Math.abs(worstSingleLoss) >= firmRules.hard_stop_daily_loss
        ? `WARN: Worst loss $${Math.abs(worstSingleLoss).toFixed(0)} approaches DLL hard stop $${firmRules.hard_stop_daily_loss}`
        : `OK (worst single: $${Math.abs(worstSingleLoss).toFixed(0)} vs DLL $${firmRules.hard_stop_daily_loss})`;
    }

    // Drawdown check
    if (firmRules.hard_stop_drawdown) {
      compliance.drawdown = maxDrawdown >= firmRules.hard_stop_drawdown
        ? `BREACH: Max drawdown $${maxDrawdown.toFixed(0)} exceeds hard stop $${firmRules.hard_stop_drawdown}`
        : `OK (max DD: $${maxDrawdown.toFixed(0)} vs limit $${firmRules.hard_stop_drawdown})`;
    }

    // Consistency rule: no single day > N% of total profit
    if (firmRules.consistency_rule_pct && grossWins > 0) {
      const threshold = grossWins * firmRules.consistency_rule_pct;
      const violations = wins.filter(r => r.pnl > threshold);
      compliance.consistency = violations.length > 0
        ? `WARN: ${violations.length} trade(s) exceeded ${(firmRules.consistency_rule_pct * 100).toFixed(0)}% of gross wins ($${threshold.toFixed(0)} threshold). Indices: ${violations.map(r => r.index).join(', ')}`
        : `OK (threshold: $${threshold.toFixed(0)} per trade)`;
    }

    // Scalping check
    if (firmRules.scalping_allowed === false) {
      compliance.scalping = 'NOTE: Scalping disabled on this firm. Verify min hold time before live use.';
    }

    compliance.firm = firmKey;
    compliance.firm_label = pxConfig.firms[firmKey]?.label || firmKey;
  } else {
    compliance.note = 'No firm specified — skipping compliance check. Pass ?firm=topstepx to enable.';
  }

  res.json({
    summary: {
      total_trades: valid.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: valid.length > 0
        ? parseFloat((wins.length / valid.length * 100).toFixed(1)) + '%'
        : 'N/A',
      total_pnl: parseFloat(totalPnl.toFixed(2)),
      gross_wins: parseFloat(grossWins.toFixed(2)),
      gross_losses: parseFloat(grossLosses.toFixed(2)),
      profit_factor: profitFactor,
      avg_winner: wins.length > 0 ? parseFloat((grossWins / wins.length).toFixed(2)) : 0,
      avg_loser: losses.length > 0 ? parseFloat((-grossLosses / losses.length).toFixed(2)) : 0,
      avg_planned_rr: parseFloat(avgPlannedRR.toFixed(2)),
      max_drawdown: parseFloat(maxDrawdown.toFixed(2)),
      max_consecutive_losses: maxConsec
    },
    compliance,
    trades: results,
    errors: results.filter(r => r.error)
  });
});

// Configure ProjectX (for a specific firm)
// Body: { firm: "topstepx", api_key: "...", username: "...", account_id: "..." }
app.post('/configure-projectx', (req, res) => {
  const { firm, api_key, username, account_id } = req.body;
  const pxConfig = config.execution_adapter.adapters.projectx;

  const targetFirm = firm || pxConfig.active_firm;
  if (!pxConfig.firms[targetFirm]) {
    return res.status(400).json({
      error: 'Unknown firm. Available: ' + Object.keys(pxConfig.firms).join(', '),
      example: { firm: 'topstepx', api_key: '...', username: '...' }
    });
  }
  if (!api_key || !username) {
    return res.status(400).json({ error: 'Required: api_key, username. Optional: firm, account_id' });
  }

  const firmConfig = pxConfig.firms[targetFirm];
  firmConfig.api_key = api_key;
  firmConfig.username = username;
  if (account_id) firmConfig.account_id = account_id;
  firmConfig.configured = true;

  logExecution('projectx_configured', { firm: targetFirm, username, has_account_id: !!account_id });

  res.json({
    message: `ProjectX credentials configured for: ${targetFirm}`,
    firm: targetFirm,
    firm_label: firmConfig.label,
    configured: true,
    username,
    note: 'Switch to ProjectX adapter with POST /adapter { "adapter": "projectx" }. To change active firm: POST /active-firm { "firm": "topstepx" }'
  });
});

// Switch active firm within ProjectX
app.post('/active-firm', (req, res) => {
  const { firm } = req.body;
  const pxConfig = config.execution_adapter.adapters.projectx;

  if (!pxConfig.firms[firm]) {
    return res.status(400).json({
      error: 'Unknown firm. Available: ' + Object.keys(pxConfig.firms).join(', ')
    });
  }

  const previous = pxConfig.active_firm;
  pxConfig.active_firm = firm;
  logExecution('active_firm_changed', { previous, new_firm: firm, label: pxConfig.firms[firm].label });

  res.json({
    active_firm: firm,
    label: pxConfig.firms[firm].label,
    previous,
    status: pxConfig.firms[firm].status,
    configured: pxConfig.firms[firm].configured,
    timestamp: now()
  });
});

// Switch adapter
app.post('/adapter', (req, res) => {
  const { adapter } = req.body;
  if (!config.execution_adapter.adapters[adapter]) {
    return res.status(400).json({
      error: 'Unknown adapter. Available: ' + Object.keys(config.execution_adapter.adapters).join(', ')
    });
  }

  if (adapter === 'projectx') {
    const pxConfig = config.execution_adapter.adapters.projectx;
    const activeFirm = pxConfig.firms[pxConfig.active_firm];
    if (!activeFirm || !activeFirm.configured) {
      return res.status(400).json({
        error: `ProjectX not configured for active firm: ${pxConfig.active_firm}. Use POST /configure-projectx first.`
      });
    }
  }

  const previous = config.execution_adapter.active;
  config.execution_adapter.active = adapter;
  logExecution('adapter_switched', { previous, new_adapter: adapter });

  res.json({
    adapter,
    label: config.execution_adapter.adapters[adapter].label,
    previous,
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
    console.log('[trade-execution] Registered with Service Registry');
  } catch (err) {
    console.log('[trade-execution] Registry not available: ' + err.message);
  }
}

app.listen(PORT, () => {
  console.log('[trade-execution] Running on port ' + PORT + ' (adapter: ' + config.execution_adapter.active + ')');
  selfRegister();
});
