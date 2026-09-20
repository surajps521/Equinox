#!/usr/bin/env bash
# End-to-end API check. Starts the server, exercises every endpoint, stops it.
set -e
cd "$(dirname "$0")/../backend"
node src/server.js > /tmp/vtrade.log 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null" EXIT
sleep 3
B=http://localhost:4000/api
echo "--- boot"        && cat /tmp/vtrade.log
echo "--- health"      && curl -s $B/health; echo
echo "--- stocks"      && curl -s "$B/stocks?at=2026-09-08%2011:30" | head -c 300; echo
echo "--- buy"         && curl -s -X POST $B/trades -H 'Content-Type: application/json' -d '{"symbol":"TCS","side":"BUY","quantity":10,"at":"2026-09-08 11:30"}'; echo
echo "--- portfolio"   && curl -s "$B/portfolio?at=2026-09-14%2015:30" | head -c 400; echo
echo "--- oversell"    && curl -s -X POST $B/trades -H 'Content-Type: application/json' -d '{"symbol":"TCS","side":"SELL","quantity":99,"at":"2026-09-14 15:30"}'; echo
echo "--- sell"        && curl -s -X POST $B/trades -H 'Content-Type: application/json' -d '{"symbol":"TCS","side":"SELL","quantity":10,"at":"2026-09-14 15:30"}'; echo
echo "--- history"     && curl -s "$B/transactions"; echo
echo "OK"
