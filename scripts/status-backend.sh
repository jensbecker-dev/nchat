#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
BACKEND_HTTP_ADDR_FILE="$RUN_DIR/backend.http_addr"
BACKEND_GRPC_ADDR_FILE="$RUN_DIR/backend.grpc_addr"

if [[ ! -f "$BACKEND_PID_FILE" ]]; then
  echo "Backend status: stopped"
  exit 0
fi

pid="$(cat "$BACKEND_PID_FILE")"
if kill -0 "$pid" >/dev/null 2>&1; then
  http_addr="$(cat "$BACKEND_HTTP_ADDR_FILE" 2>/dev/null || echo ":8080")"
  grpc_addr="$(cat "$BACKEND_GRPC_ADDR_FILE" 2>/dev/null || echo ":9090")"
  echo "Backend status: running"
  echo "PID: $pid"
  echo "HTTP: $http_addr"
  echo "gRPC: $grpc_addr"
  exit 0
fi

rm -f "$BACKEND_PID_FILE" "$BACKEND_HTTP_ADDR_FILE" "$BACKEND_GRPC_ADDR_FILE"
echo "Backend status: stopped (cleaned stale PID $pid)"
exit 0
