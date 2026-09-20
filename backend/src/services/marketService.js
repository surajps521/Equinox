/**
 * marketService.js
 * ----------------
 * Everything that answers "what was this stock worth at this moment?".
 *
 * The simulated clock is whatever timestamp the client sends as `at`. A quote
 * is the most recent candle at or before `at`, so the market never leaks a
 * price from the future — which is what makes the buy/sell prices honest.
 */

const { db } = require('../db');

const MAX_TS = () => db.prepare('SELECT MAX(ts) m FROM prices').get().m;
const MIN_TS = () => db.prepare('SELECT MIN(ts) m FROM prices').get().m;

/** Normalise whatever the client sent into a 'YYYY-MM-DD HH:MM:SS' string. */
function normaliseTimestamp(at) {
  if (!at) return MAX_TS();
  let s = String(at).trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += ' 23:59:59';      // date only -> end of day
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s += ':00'; // no seconds
  const min = MIN_TS();
  const max = MAX_TS();
  if (s < min) return min;
  if (s > max) return max;
  return s;
}

/** Distinct trading days and session times — feeds the date/time picker. */
function getTimeline() {
  const dates = db.prepare('SELECT DISTINCT trade_date d FROM prices ORDER BY d').all().map((r) => r.d);
  const times = db.prepare('SELECT DISTINCT trade_time t FROM prices ORDER BY t').all().map((r) => r.t);
  const stamps = db.prepare('SELECT DISTINCT ts FROM prices ORDER BY ts').all().map((r) => r.ts);
  return { dates, times, timestamps: stamps, first: stamps[0], last: stamps[stamps.length - 1] };
}

/** The candle in force at `at` for one stock. */
const quoteStmt = db.prepare(`
  SELECT p.*, s.name, s.sector
    FROM prices p JOIN stocks s ON s.symbol = p.symbol
   WHERE p.symbol = ? AND p.ts <= ?
   ORDER BY p.ts DESC LIMIT 1
`);

/** Previous session's closing price, used for the day-change figure. */
const prevCloseStmt = db.prepare(`
  SELECT close FROM prices
   WHERE symbol = ? AND trade_date < ?
   ORDER BY ts DESC LIMIT 1
`);

/** First candle of the current session, the fallback baseline on day one. */
const dayOpenStmt = db.prepare(`
  SELECT open FROM prices
   WHERE symbol = ? AND trade_date = ?
   ORDER BY ts ASC LIMIT 1
`);

function buildQuote(row) {
  if (!row) return null;
  const prev = prevCloseStmt.get(row.symbol, row.trade_date);
  const baseline = prev ? prev.close : dayOpenStmt.get(row.symbol, row.trade_date).open;
  const change = row.close - baseline;

  return {
    symbol: row.symbol,
    name: row.name,
    sector: row.sector,
    price: round2(row.close),
    open: round2(row.open),
    high: round2(row.high),
    low: round2(row.low),
    volume: row.volume,
    previousClose: round2(baseline),
    change: round2(change),
    changePercent: round2((change / baseline) * 100),
    asOf: row.ts,
    date: row.trade_date,
    time: row.trade_time,
  };
}

function getQuote(symbol, at) {
  return buildQuote(quoteStmt.get(String(symbol).toUpperCase(), normaliseTimestamp(at)));
}

function listStocks(at) {
  const ts = normaliseTimestamp(at);
  return db.prepare('SELECT symbol FROM stocks ORDER BY symbol').all()
    .map((r) => buildQuote(quoteStmt.get(r.symbol, ts)))
    .filter(Boolean);
}

/**
 * Candle history up to `at`.
 * range: 'day'  -> the current session only
 *        'all'  -> every candle from the first trading day (default)
 */
function getHistory(symbol, at, range = 'all') {
  const sym = String(symbol).toUpperCase();
  const ts = normaliseTimestamp(at);

  let rows;
  if (range === 'day') {
    const day = ts.slice(0, 10);
    rows = db.prepare(
      `SELECT ts, trade_date, trade_time, open, high, low, close, volume
         FROM prices WHERE symbol = ? AND trade_date = ? AND ts <= ? ORDER BY ts`
    ).all(sym, day, ts);
  } else {
    rows = db.prepare(
      `SELECT ts, trade_date, trade_time, open, high, low, close, volume
         FROM prices WHERE symbol = ? AND ts <= ? ORDER BY ts`
    ).all(sym, ts);
  }

  return rows.map((r) => ({
    ts: r.ts, date: r.trade_date, time: r.trade_time,
    open: round2(r.open), high: round2(r.high), low: round2(r.low),
    close: round2(r.close), volume: r.volume,
  }));
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { normaliseTimestamp, getTimeline, getQuote, listStocks, getHistory, round2 };
