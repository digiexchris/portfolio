#!/usr/bin/env bash
# Start the portfolio editor and open it in Firefox.
# Usage: ./start-editor.sh          (PORT=8080 ./start-editor.sh for another port)
# Ctrl+C stops the server.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

PORT="${PORT:-4321}"
URL="http://127.0.0.1:${PORT}/editor/"
export PORT

command -v node >/dev/null || { echo "Node.js is not installed (need 20+)." >&2; exit 1; }

if [ ! -d node_modules ]; then
  echo "Installing dependencies (npm ci)..."
  npm ci
fi

is_up() {
  node -e "fetch('$URL').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null
}

open_firefox() {
  if command -v firefox >/dev/null; then
    firefox --new-window "$URL" >/dev/null 2>&1 &
  else
    echo "Firefox not found; open $URL manually." >&2
  fi
}

# Already running (e.g. another terminal)? Just open the browser.
if is_up; then
  echo "Editor already running at $URL"
  open_firefox
  exit 0
fi

node server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

# Wait up to ~15s for the server to answer.
for _ in $(seq 1 30); do
  if is_up; then
    open_firefox
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited before it was ready." >&2
    exit 1
  fi
  sleep 0.5
done

is_up || echo "Server did not respond at $URL yet; open it manually when ready." >&2

wait "$SERVER_PID"
