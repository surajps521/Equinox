/**
 * db.js
 * -----
 * Creates an in-memory SQLite database, builds the schema, and loads the
 * generated CSV market data into it on boot.
 *
 * Everything lives in RAM (":memory:"), so a restart gives a clean market and
 * a fresh virtual wallet. Set DB_FILE=trading.db in .env to persist instead.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STARTING_CASH = Number(process.env.STARTING_CASH || 1_000_000); // Rs 10 lakh
const DEMO_USER = { id: 1, name: 'Demo Investor', email: 'demo@vtrade.local' };

const db = new Database(process.env.DB_FILE || ':memory:');
db.pragma('journal_mode = MEMORY');

/* ------------------------------------------------------------------ schema */

function createSchema() {
  db.exec(`
    CREATE TABLE stocks (
      symbol  TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      sector  TEXT NOT NULL
    );

    CREATE TABLE prices (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol    TEXT NOT NULL REFERENCES stocks(symbol),
      ts        TEXT NOT NULL,              -- 'YYYY-MM-DD HH:MM:SS'
      trade_date TEXT NOT NULL,
      trade_time TEXT NOT NULL,
      open      REAL NOT NULL,
      high      REAL NOT NULL,
      low       REAL NOT NULL,
      close     REAL NOT NULL,
      volume    INTEGER NOT NULL,
      UNIQUE (symbol, ts)
    );
    CREATE INDEX idx_prices_symbol_ts ON prices(symbol, ts);

    CREATE TABLE users (
      id    INTEGER PRIMARY KEY,
      name  TEXT NOT NULL,
      email TEXT NOT NULL,
      cash  REAL NOT NULL
    );

    CREATE TABLE holdings (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      symbol    TEXT NOT NULL REFERENCES stocks(symbol),
      quantity  INTEGER NOT NULL,
      avg_price REAL NOT NULL,             -- weighted average buy price
      UNIQUE (user_id, symbol)
    );

    CREATE TABLE transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      symbol        TEXT NOT NULL,
      side          TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
      quantity      INTEGER NOT NULL,
      price         REAL NOT NULL,          -- price taken from the CSV candle
      amount        REAL NOT NULL,          -- quantity * price
      fee           REAL NOT NULL DEFAULT 0,-- 0.05% brokerage fee
      realised_pnl  REAL NOT NULL DEFAULT 0,
      market_ts     TEXT NOT NULL,          -- simulated market time of the trade
      created_at    TEXT NOT NULL           -- real wall-clock time
    );
  `);
}

/* ------------------------------------------------------------- CSV loading */

/** Minimal RFC-4180-ish CSV parser (handles quoted fields and \r\n). */
function parseCSV(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.length === header.length && r.some((c) => c !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

function loadMarketData() {
  const combined = path.join(DATA_DIR, 'market_data.csv');
  const files = fs.existsSync(combined)
    ? [combined]
    : fs.readdirSync(DATA_DIR)
        .filter((f) => f.endsWith('.csv') && f !== 'stocks.csv')
        .map((f) => path.join(DATA_DIR, f));

  if (!files.length) {
    throw new Error(`No CSV files found in ${DATA_DIR}. Run: npm run seed`);
  }

  const insertStock = db.prepare(
    'INSERT OR IGNORE INTO stocks (symbol, name, sector) VALUES (?, ?, ?)'
  );
  const insertPrice = db.prepare(`
    INSERT OR IGNORE INTO prices
      (symbol, ts, trade_date, trade_time, open, high, low, close, volume)
    VALUES (@symbol, @ts, @trade_date, @trade_time, @open, @high, @low, @close, @volume)
  `);

  let count = 0;
  const load = db.transaction((rows) => {
    for (const r of rows) {
      insertStock.run(r.symbol, r.name || r.symbol, r.sector || 'Other');
      insertPrice.run({
        symbol: r.symbol,
        ts: r.timestamp || `${r.date} ${r.time}:00`,
        trade_date: r.date,
        trade_time: r.time,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume || 0),
      });
      count++;
    }
  });

  for (const file of files) load(parseCSV(fs.readFileSync(file, 'utf8')));
  return { files: files.length, rows: count };
}

/* --------------------------------------------------------------- user seed */

function seedUser() {
  db.prepare('INSERT OR REPLACE INTO users (id, name, email, cash) VALUES (?, ?, ?, ?)')
    .run(DEMO_USER.id, DEMO_USER.name, DEMO_USER.email, STARTING_CASH);
}

/** Wipe the portfolio back to day one, keeping the market data intact. */
function resetPortfolio() {
  db.prepare('DELETE FROM holdings WHERE user_id = ?').run(DEMO_USER.id);
  db.prepare('DELETE FROM transactions WHERE user_id = ?').run(DEMO_USER.id);
  db.prepare('UPDATE users SET cash = ? WHERE id = ?').run(STARTING_CASH, DEMO_USER.id);
}

function init() {
  createSchema();
  const stats = loadMarketData();
  seedUser();

  const stocks = db.prepare('SELECT COUNT(*) c FROM stocks').get().c;
  const days = db.prepare('SELECT COUNT(DISTINCT trade_date) c FROM prices').get().c;
  console.log(
    `[db] in-memory SQLite ready — ${stats.rows} price rows from ${stats.files} CSV file(s), ` +
    `${stocks} stocks across ${days} trading days`
  );
  return stats;
}

// The schema and CSV load happen at import time so that any module which
// prepares statements at the top level always finds the tables ready.
const stats = init();

module.exports = { db, init, stats, resetPortfolio, DEMO_USER, STARTING_CASH };
