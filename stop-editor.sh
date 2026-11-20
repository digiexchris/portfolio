#!/usr/bin/env bash
# Stop the portfolio editor, however it was started.
# Usage: ./stop-editor.sh          (PORT=8080 ./stop-editor.sh for another port)
#        ./stop-editor.sh --all    stop every editor started from this folder
#
# A running editor records itself in .cache/editor-<port>.json. This asks it
# to shut down; if it doesn't answer, it is killed by PID -- but only after
# checking that PID is still this folder's server.js, so a stale file can
# never take some other process down with it.
set -uo pipefail

cd "$(dirname "$(readlink -f "$0")")"
ROOT="$(pwd -P)"

files=()
if [ "${1:-}" = "--all" ]; then
  for f in .cache/editor-*.json; do [ -e "$f" ] && files+=("$f"); done
  [ ${#files[@]} -gt 0 ] || { echo "No editor is running."; exit 0; }
elif [ -n "${1:-}" ]; then
  echo "Unknown option: $1 (use --all)" >&2; exit 2
else
  PORT="${PORT:-4321}"
  f=".cache/editor-${PORT}.json"
  [ -e "$f" ] || { echo "No editor found on port $PORT."; exit 1; }
  files=("$f")
fi

field() { node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]] ?? ''))" "$1" "$2"; }
alive() { kill -0 "$1" 2>/dev/null; }

# Is this PID this folder's editor server?
ours() {
  local pid=$1
  [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'server\.js' || return 1
  [ "$(readlink "/proc/$pid/cwd")" = "$ROOT" ]
}

status=0
for f in "${files[@]}"; do
  pid=$(field "$f" pid); port=$(field "$f" port)

  if ! alive "$pid" || ! ours "$pid"; then
    echo "Port $port: not running (removed a stale record)."
    rm -f "$f"
    continue
  fi

  # Ask nicely first: the server saves nothing on the way out, but it
  # cleans up its record and closes its connections.
  node -e "
    fetch('http://127.0.0.1:' + process.argv[1] + '/api/shutdown',
      { method: 'POST', headers: { 'X-Portfolio-Editor': '1' }, signal: AbortSignal.timeout(3000) })
      .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));" "$port" 2>/dev/null

  for _ in $(seq 1 20); do alive "$pid" || break; sleep 0.25; done

  if alive "$pid"; then
    echo "Port $port: editor (PID $pid) did not answer; stopping it."
    kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 8); do alive "$pid" || break; sleep 0.25; done
    alive "$pid" && kill -KILL "$pid" 2>/dev/null
    sleep 0.2
  fi

  if alive "$pid"; then
    echo "Port $port: could not stop PID $pid." >&2
    status=1
  else
    rm -f "$f"
    echo "Port $port: editor stopped."
  fi
done
exit $status
