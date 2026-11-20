#!/usr/bin/env bash
# Start the portfolio editor and print the address to open in a browser.
# Usage: ./start-editor.sh [--no-ffmpeg]
#        (PORT=8080 ./start-editor.sh for another port)
#   --no-ffmpeg   start even without ffmpeg (video uploads will then fail)
# Ctrl+C stops the server.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

PORT="${PORT:-4321}"
URL="http://127.0.0.1:${PORT}/editor/"
export PORT

CHECK_FFMPEG=1
for arg in "$@"; do
  case "$arg" in
    --no-ffmpeg) CHECK_FFMPEG=0 ;;
    *) echo "Unknown option: $arg (use --no-ffmpeg)" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "Node.js is not installed (need 22.12+)." >&2; exit 1; }

# Video uploads are converted with ffmpeg; without it they would only fail
# later, inside the editor.
if [ "$CHECK_FFMPEG" = 1 ]; then
  if ! "${FFMPEG_PATH:-ffmpeg}" -version >/dev/null 2>&1 || ! "${FFPROBE_PATH:-ffprobe}" -version >/dev/null 2>&1; then
    {
      echo "ffmpeg/ffprobe not found — needed to convert video uploads."
      echo "  Debian/Ubuntu:  sudo apt install ffmpeg"
      echo "  Windows:        winget install Gyan.FFmpeg"
      echo "Or set FFMPEG_PATH / FFPROBE_PATH, or start without video support:"
      echo "  ./start-editor.sh --no-ffmpeg"
    } >&2
    exit 1
  fi
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (npm ci)..."
  npm ci
fi

is_up() {
  node -e "fetch('$URL').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null
}

# Already running (e.g. another terminal)? Just say where.
if is_up; then
  echo "Editor already running at $URL"
  exit 0
fi

node server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

# Wait up to ~15s for the server to answer.
for _ in $(seq 1 30); do
  if is_up; then
    echo
    echo "Open $URL in your browser. Ctrl+C stops the editor."
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited before it was ready." >&2
    exit 1
  fi
  sleep 0.5
done

is_up || echo "Server did not respond at $URL yet; open it when ready." >&2

wait "$SERVER_PID"
