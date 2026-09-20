/**
 * tradingService.js
 * -----------------
 * Order execution and portfolio accounting. No real money moves anywhere:
 * the wallet is a single REAL column in the in-memory database.
 *
 * Cost basis uses the weighted-average method:
 *   BUY  -> avg = (oldQty*oldAvg + newQty*price) / (oldQty + newQty)
 *   SELL -> realised P&L = (price - avg) * qty, avg is left unchanged
 */

const { db, DEMO_USER, STARTING_CASH } = require('../db');
const market = require('./marketService');

const round2 = market.round2;

function getUser() {
  return db.prepare('SELECT id, name, email, cash FROM users WHERE id = ?').get(DEMO_USER.id);
}

/** A trade that cannot be filled throws this, so routes can return HTTP 400. */
class TradeError extends Error {
  constructor(message, code = 'TRADE_REJECTED') {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

function executeTrade({ symbol, side, quantity, at }) {
  const sym = String(symbol || '').toUpperCase();
  const dir = String(side || '').toUpperCase();
  const qty = Number(quantity);

  if (!['BUY', 'SELL'].includes(dir)) throw new TradeError('Side must be BUY or SELL.');
  if (!Number.isInteger(qty) || qty <= 0) throw new TradeError('Quantity must be a whole number above zero.');

  const quote = market.getQuote(sym, at);
  if (!quote) throw new TradeError(`No price available for ${sym} at that date and time.`, 'NO_QUOTE');

  const price = quote.price;
  const amount = round2(price * qty);
  const user = getUser();
  const holding = db.prepare('SELECT * FROM holdings WHERE user_id = ? AND symbol = ?')
    .get(user.id, sym);

  let realised = 0;

  const run = db.transaction(() => {
    if (dir === 'BUY') {
      if (amount > user.cash + 0.001) {
        throw new TradeError(
          `Not enough funds. This order costs ${fmt(amount)} and you have ${fmt(user.cash)}.`,
          'INSUFFICIENT_FUNDS'
        );
      }
      if (holding) {
        const newQty = holding.quantity + qty;
        const newAvg = (holding.quantity * holding.avg_price + qty * price) / newQty;
        db.prepare('UPDATE holdings SET quantity = ?, avg_price = ? WHERE id = ?')
          .run(newQty, newAvg, holding.id);
      } else {
        db.prepare('INSERT INTO holdings (user_id, symbol, quantity, avg_price) VALUES (?,?,?,?)')
          .run(user.id, sym, qty, price);
      }
      db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(amount, user.id);
    } else {
      if (!holding || holding.quantity < qty) {
        throw new TradeError(
          `You hold ${holding ? holding.quantity : 0} share(s) of ${sym}, so you cannot sell ${qty}.`,
          'INSUFFICIENT_HOLDINGS'
        );
      }
      realised = round2((price - holding.avg_price) * qty);
      const left = holding.quantity - qty;
      if (left === 0) db.prepare('DELETE FROM holdings WHERE id = ?').run(holding.id);
      else db.prepare('UPDATE holdings SET quantity = ? WHERE id = ?').run(left, holding.id);
      db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(amount, user.id);
    }

    const info = db.prepare(`
      INSERT INTO transactions
        (user_id, symbol, side, quantity, price, amount, realised_pnl, market_ts, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(user.id, sym, dir, qty, price, amount, realised, quote.asOf, new Date().toISOString());

    return info.lastInsertRowid;
  });

  const id = run();

  return {
    id,
    symbol: sym,
    side: dir,
    quantity: qty,
    price,
    amount,
    realisedPnl: realised,
    marketTime: quote.asOf,
    cashAfter: round2(getUser().cash),
  };
}

/** Full portfolio snapshot valued at the selected market time. */
function getPortfolio(at) {
  const user = getUser();
  const ts = market.normaliseTimestamp(at);
  const rows = db.prepare(`
    SELECT h.symbol, h.quantity, h.avg_price, s.name, s.sector
      FROM holdings h JOIN stocks s ON s.symbol = h.symbol
     WHERE h.user_id = ? ORDER BY h.symbol
  `).all(user.id);

  let invested = 0;
  let marketValue = 0;
  let dayChange = 0;

  const holdings = rows.map((h) => {
    const q = market.getQuote(h.symbol, ts);
    const cost = h.avg_price * h.quantity;
    const value = q.price * h.quantity;
    invested += cost;
    marketValue += value;
    dayChange += q.change * h.quantity;

    return {
      symbol: h.symbol,
      name: h.name,
      sector: h.sector,
      quantity: h.quantity,
      avgPrice: round2(h.avg_price),
      lastPrice: q.price,
      invested: round2(cost),
      currentValue: round2(value),
      unrealisedPnl: round2(value - cost),
      unrealisedPnlPercent: round2(((value - cost) / cost) * 100),
      dayChange: round2(q.change * h.quantity),
      dayChangePercent: q.changePercent,
      asOf: q.asOf,
    };
  });

  const realised = db.prepare(
    'SELECT COALESCE(SUM(realised_pnl),0) p FROM transactions WHERE user_id = ?'
  ).get(user.id).p;

  const unrealised = marketValue - invested;
  const equity = user.cash + marketValue;

  return {
    user: { name: user.name, email: user.email },
    asOf: ts,
    cash: round2(user.cash),
    startingCash: STARTING_CASH,
    invested: round2(invested),
    marketValue: round2(marketValue),
    equity: round2(equity),
    unrealisedPnl: round2(unrealised),
    unrealisedPnlPercent: invested ? round2((unrealised / invested) * 100) : 0,
    realisedPnl: round2(realised),
    totalPnl: round2(equity - STARTING_CASH),
    totalPnlPercent: round2(((equity - STARTING_CASH) / STARTING_CASH) * 100),
    dayChange: round2(dayChange),
    holdings,
  };
}

function getTransactions({ limit = 200, symbol } = {}) {
  const params = [DEMO_USER.id];
  let sql = `SELECT id, symbol, side, quantity, price, amount, realised_pnl AS realisedPnl,
                    market_ts AS marketTime, created_at AS createdAt
               FROM transactions WHERE user_id = ?`;
  if (symbol) { sql += ' AND symbol = ?'; params.push(String(symbol).toUpperCase()); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Number(limit));
  return db.prepare(sql).all(...params);
}

/**
 * Equity curve: replays every transaction against the price series so the
 * portfolio's value can be plotted candle by candle up to `at`.
 */
function getEquityCurve(at) {
  const ts = market.normaliseTimestamp(at);
  const stamps = db.prepare('SELECT DISTINCT ts FROM prices WHERE ts <= ? ORDER BY ts').all(ts)
    .map((r) => r.ts);
  const txns = db.prepare(
    'SELECT symbol, side, quantity, amount, market_ts FROM transactions WHERE user_id = ? ORDER BY id'
  ).all(DEMO_USER.id);

  const closes = {};
  for (const r of db.prepare('SELECT symbol, ts, close FROM prices WHERE ts <= ? ORDER BY ts').all(ts)) {
    (closes[r.symbol] ||= {})[r.ts] = r.close;
  }

  const held = {};
  const last = {};
  let cash = STARTING_CASH;
  let cursor = 0;
  const points = [];

  for (const stamp of stamps) {
    while (cursor < txns.length && txns[cursor].market_ts <= stamp) {
      const t = txns[cursor++];
      const sign = t.side === 'BUY' ? 1 : -1;
      held[t.symbol] = (held[t.symbol] || 0) + sign * t.quantity;
      cash -= sign * t.amount;
    }
    let value = 0;
    for (const [sym, qty] of Object.entries(held)) {
      if (closes[sym] && closes[sym][stamp] != null) last[sym] = closes[sym][stamp];
      value += qty * (last[sym] || 0);
    }
    points.push({ ts: stamp, equity: round2(cash + value) });
  }
  return points;
}

const fmt = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = { executeTrade, getPortfolio, getTransactions, getEquityCurve, getUser, TradeError };
