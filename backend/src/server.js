/**
 * server.js
 * ---------
 * Virtual Stock Trading Platform — REST API.
 *
 *   GET  /api/health
 *   GET  /api/market/timeline                 trading days + session times
 *   GET  /api/stocks?at=...                   all 10 stocks priced at a moment
 *   GET  /api/stocks/:symbol?at=...           one quote
 *   GET  /api/stocks/:symbol/history?at=&range=day|all
 *   GET  /api/portfolio?at=...                holdings, valuation, P&L
 *   GET  /api/portfolio/equity-curve?at=...
 *   POST /api/trades       { symbol, side, quantity, at }
 *   GET  /api/transactions?symbol=&limit=
 *   POST /api/portfolio/reset
 *
 * `at` is the selected date and time, e.g. 2026-09-08 11:30 — every price and
 * valuation in the response is resolved as of that moment.
 */

const path = require('path');
const express = require('express');
const cors = require('cors');

const { resetPortfolio, stats } = require('./db');
const market = require('./services/marketService');
const trading = require('./services/tradingService');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

const ok = (res, data) => res.json({ success: true, data });
const wrap = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };

/* ------------------------------------------------------------------ routes */

app.get('/api/health', wrap((req, res) => ok(res, {
  status: 'up',
  market: market.getTimeline().last,
  time: new Date().toISOString(),
})));

app.get('/api/market/timeline', wrap((req, res) => ok(res, market.getTimeline())));

app.get('/api/stocks', wrap((req, res) => ok(res, {
  asOf: market.normaliseTimestamp(req.query.at),
  stocks: market.listStocks(req.query.at),
})));

app.get('/api/stocks/:symbol', wrap((req, res) => {
  const quote = market.getQuote(req.params.symbol, req.query.at);
  if (!quote) return res.status(404).json({ success: false, error: 'Stock not found.' });
  return ok(res, quote);
}));

app.get('/api/stocks/:symbol/history', wrap((req, res) => ok(res, {
  symbol: req.params.symbol.toUpperCase(),
  range: req.query.range || 'all',
  candles: market.getHistory(req.params.symbol, req.query.at, req.query.range),
})));

app.get('/api/portfolio', wrap((req, res) => ok(res, trading.getPortfolio(req.query.at))));

app.get('/api/portfolio/equity-curve', wrap((req, res) =>
  ok(res, trading.getEquityCurve(req.query.at))));

app.post('/api/trades', wrap((req, res) => ok(res, trading.executeTrade(req.body))));

app.get('/api/transactions', wrap((req, res) => ok(res, trading.getTransactions({
  limit: req.query.limit || 200,
  symbol: req.query.symbol,
}))));

app.post('/api/portfolio/reset', wrap((req, res) => {
  resetPortfolio();
  ok(res, { message: 'Portfolio reset. Virtual wallet is back to its opening balance.' });
}));

/* --------------------------------------------------------- error handling */

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status === 500) console.error('[error]', err);
  res.status(status).json({ success: false, error: err.message, code: err.code || 'SERVER_ERROR' });
});

/* ------------------------------------------------------------------- boot */

app.listen(PORT, () => {
  console.log(`[api] Virtual Stock Trading Platform running at http://localhost:${PORT}`);
  console.log(`[api] Serving ${stats.rows} price rows loaded from CSV.`);
  console.log(`[api] Frontend served from the same origin — open that URL in a browser.`);
});

module.exports = app;
