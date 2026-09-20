"""
generate_market_data.py
-----------------------
Creates dummy-but-realistic market data for the Virtual Stock Trading Platform.

  * 10 stocks
  * 12 trading days (weekends skipped)
  * 30-minute intervals, 09:30 -> 15:30 (13 candles per stock per day)
  * OHLCV format, one CSV per stock + one combined CSV

The price path is a Geometric Brownian Motion walk with a per-stock drift and
volatility, plus a small overnight gap and an intraday "opening hour is more
volatile" factor. Seeded, so the data is identical on every machine.

Usage:  python scripts/generate_market_data.py
"""

import csv
import json
import math
import os
import random
from datetime import date, datetime, timedelta

SEED = 20260927
random.seed(SEED)

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
os.makedirs(OUT_DIR, exist_ok=True)

# symbol, company, sector, starting price, annual drift, annual volatility, avg volume
STOCKS = [
    ("TCS",       "Tata Consultancy Services", "Information Technology", 3890.00,  0.14, 0.20, 1_450_000),
    ("INFY",      "Infosys",                   "Information Technology", 1642.50,  0.10, 0.24, 6_200_000),
    ("RELIANCE",  "Reliance Industries",       "Energy",                 2875.00,  0.09, 0.22, 8_100_000),
    ("HDFCBANK",  "HDFC Bank",                 "Banking",                1698.25,  0.07, 0.18, 9_400_000),
    ("ICICIBANK", "ICICI Bank",                "Banking",                1184.60,  0.12, 0.21, 11_800_000),
    ("ITC",       "ITC Limited",               "FMCG",                    452.30,  0.05, 0.16, 14_500_000),
    ("TATAMOTORS","Tata Motors",               "Automobile",              985.75,  0.18, 0.34, 15_900_000),
    ("SUNPHARMA", "Sun Pharmaceutical",        "Pharmaceuticals",        1742.40,  0.11, 0.23, 2_300_000),
    ("BHARTIARTL","Bharti Airtel",             "Telecom",                1596.80,  0.15, 0.25, 5_600_000),
    ("ADANIPORTS","Adani Ports & SEZ",         "Infrastructure",         1342.15, -0.06, 0.38, 7_700_000),
]

TRADING_DAYS = 12
# Keep the simulated market current through the workspace's reference date.
START_DATE = date(2026, 9, 4)
SESSION_START = (9, 30)
SESSION_END = (15, 30)
INTERVAL_MIN = 30

# Minutes of market time in one 30-min candle, as a fraction of a trading year
# (252 sessions x 6h of trading). Used to scale drift/volatility per step.
CANDLES_PER_DAY = int(((SESSION_END[0] * 60 + SESSION_END[1]) -
                       (SESSION_START[0] * 60 + SESSION_START[1])) / INTERVAL_MIN) + 1
DT = 1.0 / (252.0 * CANDLES_PER_DAY)


def trading_days(start: date, count: int):
    """Return `count` weekday dates starting at `start`."""
    days, cursor = [], start
    while len(days) < count:
        if cursor.weekday() < 5:          # 0-4 = Mon-Fri
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


def candle_times(day: date):
    """All 30-minute timestamps inside one session."""
    t = datetime(day.year, day.month, day.day, *SESSION_START)
    end = datetime(day.year, day.month, day.day, *SESSION_END)
    while t <= end:
        yield t
        t += timedelta(minutes=INTERVAL_MIN)


def build_rows():
    days = trading_days(START_DATE, TRADING_DAYS)
    all_rows = []

    for symbol, name, sector, start_price, drift, vol, base_vol in STOCKS:
        price = start_price
        rows = []

        for day_index, day in enumerate(days):
            # Overnight gap: small jump between yesterday's close and today's open.
            if day_index > 0:
                price *= math.exp(random.gauss(0, vol * math.sqrt(1 / 252.0) * 0.45))

            for slot, ts in enumerate(candle_times(day)):
                # First and last candle of the day are the most volatile.
                shape = 1.6 if slot == 0 else (1.3 if slot == CANDLES_PER_DAY - 1 else 1.0)
                step_vol = vol * shape

                open_p = price
                shock = (drift - 0.5 * step_vol ** 2) * DT + step_vol * math.sqrt(DT) * random.gauss(0, 1)
                close_p = open_p * math.exp(shock)

                wick = abs(random.gauss(0, step_vol * math.sqrt(DT) * 0.7))
                high_p = max(open_p, close_p) * (1 + wick)
                low_p = min(open_p, close_p) * (1 - wick)

                move = abs(close_p / open_p - 1)
                volume = int(base_vol / CANDLES_PER_DAY * shape *
                             (1 + move * 90) * random.uniform(0.62, 1.44))

                rows.append({
                    "symbol": symbol,
                    "name": name,
                    "sector": sector,
                    "date": ts.strftime("%Y-%m-%d"),
                    "time": ts.strftime("%H:%M"),
                    "timestamp": ts.strftime("%Y-%m-%d %H:%M:%S"),
                    "open": round(open_p, 2),
                    "high": round(high_p, 2),
                    "low": round(low_p, 2),
                    "close": round(close_p, 2),
                    "volume": volume,
                })
                price = close_p

        # One CSV per stock
        path = os.path.join(OUT_DIR, f"{symbol}.csv")
        with open(path, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"  {symbol:<12} {len(rows):>4} rows  ->  data/{symbol}.csv")
        all_rows.extend(rows)

    # One combined CSV, handy for loading into a DB in a single pass
    combined = os.path.join(OUT_DIR, "market_data.csv")
    with open(combined, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(all_rows[0].keys()))
        writer.writeheader()
        writer.writerows(all_rows)

    stamps = sorted({row["timestamp"] for row in all_rows})
    series = {}
    for symbol, name, sector, *_ in STOCKS:
        rows = [row for row in all_rows if row["symbol"] == symbol]
        series[symbol] = {
            "n": name,
            "s": sector,
            "o": [row["open"] for row in rows],
            "h": [row["high"] for row in rows],
            "l": [row["low"] for row in rows],
            "c": [row["close"] for row in rows],
            "v": [row["volume"] for row in rows],
        }
    embedded_path = os.path.join(os.path.dirname(OUT_DIR), "frontend", "market-data.js")
    with open(embedded_path, "w") as fh:
        fh.write("window.EMBEDDED_MARKET=")
        json.dump({"stamps": stamps, "series": series}, fh, separators=(",", ":"))
        fh.write(";\n")

    # A small reference file for the stock master table
    with open(os.path.join(OUT_DIR, "stocks.csv"), "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["symbol", "name", "sector"])
        for s in STOCKS:
            writer.writerow([s[0], s[1], s[2]])

    print(f"\n  combined     {len(all_rows):>4} rows  ->  data/market_data.csv")
    print(f"  {len(STOCKS)} stocks x {TRADING_DAYS} days x {CANDLES_PER_DAY} candles")


if __name__ == "__main__":
    print("Generating market data...\n")
    build_rows()
    print("\nDone.")
