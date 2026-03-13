#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
BACKEND_HTTP_ADDR_FILE="$RUN_DIR/backend.http_addr"
BACKEND_GRPC_ADDR_FILE="$RUN_DIR/backend.grpc_addr"

if [[ ! -f "$BACKEND_PID_FILE" ]]; then
  echo "Backend not running (no PID file)."
  exit 0
fi

pid="$(cat "$BACKEND_PID_FILE")"
if kill -0 "$pid" >/dev/null 2>&1; then
  kill "$pid"
  echo "Stopped backend (PID $pid)"
else
  echo "Backend PID file was stale (PID $pid)"
fi

rm -f "$BACKEND_PID_FILE" "$BACKEND_HTTP_ADDR_FILE" "$BACKEND_GRPC_ADDR_FILE"
