#!/usr/bin/env bash
# Start the task tracker. First run creates .venv and installs Flask;
# later runs just start the server and open the browser.
#   ./run.sh              start on http://localhost:5001
#   PORT=8080 ./run.sh    start on a different port
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "First run: creating .venv and installing Flask..."
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
  echo "Done."
fi

PORT="${PORT:-5001}"
export PORT

.venv/bin/python server.py &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT INT TERM

# Wait for the server to answer, then open it in the browser.
for _ in $(seq 1 25); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then
    open "http://localhost:$PORT/" 2>/dev/null || true
    break
  fi
  sleep 0.2
done

wait $PID
