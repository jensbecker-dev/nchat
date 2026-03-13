#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
FRONTEND_PID_FILE="$RUN_DIR/frontend.pid"
BACKEND_HTTP_ADDR_FILE="$RUN_DIR/backend.http_addr"
BACKEND_GRPC_ADDR_FILE="$RUN_DIR/backend.grpc_addr"
FRONTEND_URL_FILE="$RUN_DIR/frontend.url"

stop_pid_file() {
  local file="$1"
  local name="$2"

  if [[ ! -f "$file" ]]; then
    echo "$name not running (no PID file)"
    return
  fi

  local pid
  pid="$(cat "$file")"

  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid"
    echo "Stopped $name (PID $pid)"
  else
    echo "$name PID file was stale (PID $pid)"
  fi

  rm -f "$file"
}

stop_pid_file "$BACKEND_PID_FILE" "backend"
stop_pid_file "$FRONTEND_PID_FILE" "frontend"

# Clean up orphaned binaries started via `go run` and Vite child processes that may outlive PID files.
if pgrep -x nchatd >/dev/null 2>&1; then
  pkill -x nchatd || true
  echo "Stopped stale nchatd processes"
fi

if pgrep -f "$ROOT_DIR/frontend/node_modules/.bin/vite" >/dev/null 2>&1; then
  pkill -f "$ROOT_DIR/frontend/node_modules/.bin/vite" || true
  echo "Stopped stale frontend vite processes"
fi

rm -f "$BACKEND_HTTP_ADDR_FILE"
rm -f "$BACKEND_GRPC_ADDR_FILE"
rm -f "$FRONTEND_URL_FILE"
