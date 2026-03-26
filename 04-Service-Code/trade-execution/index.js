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

// ─── Simulated Execution Adapter ─────────────────────────────────────────────

async function simulatedExecute(order) {
  const simConfig = config.execution_adapter.adapters.simulated;

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

// ─── TopstepX Execution Adapter (Placeholder) ───────────────────────────────

async function topstepxExecute(order) {
  const tsConfig = config.execution_adapter.adapters.topstepx;

  if (!tsConfig.configured || !tsConfig.api_key) {
    return {
      filled: false,
      reason: 'TopstepX not configured. Set api_key and username via POST /configure-topstepx',
      adapter: 'topstepx'
    };
  }

  // TODO: Implement TopstepX API integration
  // 1. Authenticate: POST /api/Auth/loginKey { apiKey, username }
  // 2. Get account: GET /api/Account/list → extract account_id
  // 3. Place order: POST /api/Order/place {
  //      accountId, symbol, action (Buy/Sell),
  //      orderType (Limit/Market/StopMarket/StopLimit),
  //      quantity, limitPrice, stopPrice, timeInForce (Day/GTC)
  //    }
  // 4. Monitor via SignalR hub for fill confirmations
  // 5. Bracket orders: place OCO (stop + target) after entry fill

  return {
    filled: false,
    reason: 'TopstepX adapter: implementation pending. Use simulated adapter for now.',
    adapter: 'topstepx'
  };
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
  if (config.execution_adapter.active === 'topstepx') {
    result = await topstepxExecute(order);
  } else {
    result = await simulatedExecute(order);
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
      'POST /configure-topstepx — set TopstepX API credentials',
      'POST /adapter — switch execution adapter (simulated/topstepx)'
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

  res.json({
    order_id: order.id,
    status: 'closed',
    exit_price: order.exit_price,
    pnl: order.pnl,
    close_reason: order.close_reason
  });
});

// Execution log
app.get('/execution-log', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ log: executionLog.slice(-limit), total: executionLog.length });
});

// Configure TopstepX
app.post('/configure-topstepx', (req, res) => {
  const { api_key, username, account_id } = req.body;
  if (!api_key || !username) {
    return res.status(400).json({ error: 'Required: api_key, username. Optional: account_id' });
  }

  const tsConfig = config.execution_adapter.adapters.topstepx;
  tsConfig.api_key = api_key;
  tsConfig.username = username;
  if (account_id) tsConfig.account_id = account_id;
  tsConfig.configured = true;

  logExecution('topstepx_configured', { username, has_account_id: !!account_id });

  res.json({
    message: 'TopstepX credentials configured',
    configured: true,
    username,
    note: 'Switch to TopstepX adapter with POST /adapter { "adapter": "topstepx" }'
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

  if (adapter === 'topstepx' && !config.execution_adapter.adapters.topstepx.configured) {
    return res.status(400).json({
      error: 'TopstepX not configured. Use POST /configure-topstepx first.'
    });
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
