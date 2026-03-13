#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$RUN_DIR/logs"

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
BACKEND_HTTP_ADDR_FILE="$RUN_DIR/backend.http_addr"
BACKEND_GRPC_ADDR_FILE="$RUN_DIR/backend.grpc_addr"
BACKEND_LOG="$LOG_DIR/backend.log"

DEFAULT_HTTP_ADDR="${NCHAT_HTTP_ADDR:-:8080}"
DEFAULT_GRPC_ADDR="${NCHAT_GRPC_ADDR:-:9090}"

mkdir -p "$LOG_DIR"

is_running() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

addr_port() {
  local addr="$1"
  echo "${addr##*:}"
}

is_port_bound() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" 2>/dev/null | awk 'NR>1 {print}' | grep -q .
    return $?
  fi
  return 1
}

pick_http_addr() {
  local preferred="$DEFAULT_HTTP_ADDR"
  local preferred_port
  preferred_port="$(addr_port "$preferred")"

  if ! is_port_bound "$preferred_port"; then
    echo "$preferred"
    return 0
  fi

  for port in $(seq 8081 8090); do
    if ! is_port_bound "$port"; then
      echo ":$port"
      return 0
    fi
  done

  return 1
}

pick_grpc_addr() {
  local preferred="$DEFAULT_GRPC_ADDR"
  local preferred_port
  preferred_port="$(addr_port "$preferred")"

  if ! is_port_bound "$preferred_port"; then
    echo "$preferred"
    return 0
  fi

  for port in $(seq 9091 9100); do
    if ! is_port_bound "$port"; then
      echo ":$port"
      return 0
    fi
  done

  return 1
}

read_pid_if_running() {
  if [[ -f "$BACKEND_PID_FILE" ]]; then
    local pid
    pid="$(cat "$BACKEND_PID_FILE")"
    if [[ -n "$pid" ]] && is_running "$pid"; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

wait_for_health() {
  local url="$1"
  local max_attempts=120

  for ((i=1; i<=max_attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  return 1
}

if pid="$(read_pid_if_running)"; then
  http_addr="$(cat "$BACKEND_HTTP_ADDR_FILE" 2>/dev/null || echo "$DEFAULT_HTTP_ADDR")"
  grpc_addr="$(cat "$BACKEND_GRPC_ADDR_FILE" 2>/dev/null || echo "$DEFAULT_GRPC_ADDR")"
  echo "Backend already running (PID $pid)"
  echo "HTTP: $http_addr"
  echo "gRPC: $grpc_addr"
  exit 0
fi

rm -f "$BACKEND_PID_FILE" "$BACKEND_HTTP_ADDR_FILE" "$BACKEND_GRPC_ADDR_FILE"

selected_http_addr="$(pick_http_addr)" || {
  echo "No free HTTP port found in range 8080-8090"
  exit 1
}

selected_grpc_addr="$(pick_grpc_addr)" || {
  echo "No free gRPC port found in range 9090-9100"
  exit 1
}

echo "Starting backend..."
(
  cd "$ROOT_DIR/backend"
  NCHAT_HTTP_ADDR="$selected_http_addr" NCHAT_GRPC_ADDR="$selected_grpc_addr" nohup go run ./cmd/nchatd >"$BACKEND_LOG" 2>&1 &
  echo $! >"$BACKEND_PID_FILE"
)

echo "$selected_http_addr" >"$BACKEND_HTTP_ADDR_FILE"
echo "$selected_grpc_addr" >"$BACKEND_GRPC_ADDR_FILE"

health_url="http://127.0.0.1:$(addr_port "$selected_http_addr")/healthz"
if ! wait_for_health "$health_url"; then
  echo "Backend did not become ready in time. Last log lines:"
  tail -n 20 "$BACKEND_LOG" || true
  exit 1
fi

echo "Backend started (PID $(cat "$BACKEND_PID_FILE"))"
echo "HTTP: $selected_http_addr"
echo "gRPC: $selected_grpc_addr"
echo "Health: $health_url"
