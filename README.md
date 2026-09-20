# Equinox — Virtual Stock Trading Platform

A paper-trading simulator built on recorded market data. You pick a date and a time,
the platform prices every stock as of that exact moment, and you buy and sell with a
virtual wallet. No real money is involved anywhere in the system.

**Live demo:** _(add your deployed link or the demo video here)_

---

## What it does

| Requirement | Where it lives |
|---|---|
| View available stocks | Market watch panel — 10 stocks with live price and day change |
| Changing stock prices from test data | 30-minute candles per stock; "Play session" steps the clock forward and the whole screen re-prices |
| Price for a **selected date and time** | Date and time pickers plus a scrubber over all 156 timestamps; every price in the UI resolves to the last candle at or before that moment |
| Buy and sell with virtual money | Order ticket with quantity presets, funds and holdings validation |
| Build and manage a portfolio | Holdings table — quantity, average cost, current price, invested, market value |
| Track profit and loss | Unrealised P&L per position, booked P&L on every sell, overall return, and a portfolio equity curve |
| Transaction history | Every fill recorded with the market timestamp it executed at |
| Load CSV into a database | 1,560 rows loaded from CSV into in-memory SQLite at boot |
| No real-money transactions | Wallet is a single number in an in-memory table |
| Single predefined user | Seeded `Demo Investor` with ₹10,00,000 — no auth, by design |

---

## Tech stack

- **Backend:** Node.js + Express
- **Database:** SQLite running in-memory (`better-sqlite3`) — schema created and CSVs loaded on every boot
- **Frontend:** Vanilla HTML/CSS/JavaScript, charts drawn as hand-rolled SVG (no chart library, no build step)
- **Data generation:** Python (standard library only)

No bundler, no framework, no npm build. Clone and run.

---

## Getting started

```bash
git clone <your-repo-url>
cd virtual-stock-trading-platform

# 1. (optional) regenerate the market data — CSVs are already committed
python3 scripts/generate_market_data.py

# 2. install and run
cd backend
npm install
npm start
```

Then open **http://localhost:4000**. The Express server serves both the API and the
frontend from the same origin, so there is nothing else to start.

Sanity check the API:

```bash
npm run test:api        # runs scripts/smoke-test.sh against a live server
```

---

## The market data

`scripts/generate_market_data.py` produces the dataset:

- **10 stocks** (TCS, INFY, RELIANCE, HDFCBANK, ICICIBANK, ITC, TATAMOTORS, SUNPHARMA, BHARTIARTL, ADANIPORTS)
- **12 trading days** — 4 to 21 September 2026, weekends skipped
- **30-minute intervals**, 09:30 to 15:30 → 13 candles per stock per day
- **1,560 rows total**, OHLCV format

Prices follow a seeded Geometric Brownian Motion walk with a per-stock drift and
volatility, an overnight gap between sessions, and wider swings in the opening and
closing candles. The seed is fixed, so everyone who runs the script gets the same
market. One stock (ADANIPORTS) carries a negative drift so that losing positions and
negative P&L are demonstrable.

Output files in `data/`:

```
market_data.csv     all 1,560 rows, used by the loader
TCS.csv, INFY.csv…  one file per stock
stocks.csv          symbol / company / sector master
```

CSV columns: `symbol, name, sector, date, time, timestamp, open, high, low, close, volume`

---

## How the "selected date and time" works

This is the core of the simulation. Every API call takes an optional `at` parameter:

```
GET /api/stocks?at=2026-09-08 11:30
```

The server resolves it with:

```sql
SELECT * FROM prices WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1
```

Because the lookup is `ts <= at`, a quote can never come from the future. That matters:
it means a trade placed at 08 September 11:30 fills at the 11:30 price, and when you
move the clock to 14 September the same position is revalued at the later price. Profit
and loss therefore come out of the data rather than out of a random number.

The day-change figure compares against the **previous session's close**, falling back to
the opening candle on the first trading day.

---

## API reference

Base URL `http://localhost:4000/api`. Every response is `{ success, data }` or
`{ success: false, error, code }`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Service check |
| GET | `/market/timeline` | Trading days, session times, all timestamps |
| GET | `/stocks?at=` | All 10 stocks priced at that moment |
| GET | `/stocks/:symbol?at=` | One quote |
| GET | `/stocks/:symbol/history?at=&range=day\|all` | Candles up to that moment |
| GET | `/portfolio?at=` | Cash, holdings, valuation, P&L |
| GET | `/portfolio/equity-curve?at=` | Portfolio value replayed candle by candle |
| POST | `/trades` | `{ symbol, side, quantity, at }` |
| GET | `/transactions?symbol=&limit=` | Order history |
| POST | `/portfolio/reset` | Back to the opening balance |

Example:

```bash
curl -X POST localhost:4000/api/trades \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"TCS","side":"BUY","quantity":10,"at":"2026-09-08 11:30"}'
```

```json
{"success":true,"data":{"id":1,"symbol":"TCS","side":"BUY","quantity":10,
 "price":3760.5,"amount":37605,"realisedPnl":0,
 "marketTime":"2026-09-08 11:30:00","cashAfter":962395}}
```

Rejections return HTTP 400 with a readable message:

```json
{"success":false,"error":"You hold 10 share(s) of TCS, so you cannot sell 99.",
 "code":"INSUFFICIENT_HOLDINGS"}
```

---

## Portfolio accounting

Cost basis uses the **weighted-average** method.

- **Buy:** `avg = (oldQty × oldAvg + newQty × price) / (oldQty + newQty)`, cash decreases
- **Sell:** `booked P&L = (price − avg) × qty`, average cost is left unchanged, cash increases
- **Unrealised P&L:** `(current price − avg) × qty`, recomputed at whatever time is selected
- **Portfolio value:** `cash + Σ(qty × current price)`
- **Overall return:** `(portfolio value − ₹10,00,000) / ₹10,00,000`

Every buy is checked against available cash and every sell against the quantity held, so
the wallet can never go negative and positions can never be oversold.

---

## Project structure

```
virtual-stock-trading-platform/
├── backend/
│   ├── src/
│   │   ├── server.js                  Express app and routes
│   │   ├── db.js                      schema, CSV parser, loader, seed user
│   │   └── services/
│   │       ├── marketService.js       price lookup for a given date and time
│   │       └── tradingService.js      order execution, portfolio, P&L
│   └── package.json
├── frontend/
│   ├── index.html                     the entire UI
│   └── market-data.js                 embedded snapshot for offline mode
├── data/                              generated CSVs
├── scripts/
│   ├── generate_market_data.py        data generator
│   └── smoke-test.sh                  end-to-end API test
├── dist/demo.html                     single-file build, opens with no server
└── README.md
```

---

## Offline mode

`frontend/index.html` pings `/api/health` on load. If the backend answers, it uses the
REST API and the badge reads **Live API · SQLite**. If it does not, it falls back to an
identical engine running in the browser over the embedded data snapshot, and the badge
reads **Demo data in browser**.

That fallback exists so `dist/demo.html` can be opened by double-clicking it, or hosted
on GitHub Pages, without anyone needing to install Node. Both engines were verified to
return the same prices, the same P&L and the same rejection messages for the same inputs.

---

## Things deliberately left out

Authentication, registration and profile management, as the brief allows. There is one
seeded user and no login screen. Order types beyond market orders, brokerage and taxes,
and short selling are also out of scope for the MVP.

## License

MIT
