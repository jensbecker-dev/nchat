#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$RUN_DIR/logs"

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
FRONTEND_PID_FILE="$RUN_DIR/frontend.pid"
BACKEND_HTTP_ADDR_FILE="$RUN_DIR/backend.http_addr"
BACKEND_GRPC_ADDR_FILE="$RUN_DIR/backend.grpc_addr"
FRONTEND_URL_FILE="$RUN_DIR/frontend.url"

BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

DEFAULT_HTTP_ADDR="${NCHAT_HTTP_ADDR:-:8080}"
DEFAULT_GRPC_ADDR="${NCHAT_GRPC_ADDR:-:9090}"
DEFAULT_FRONTEND_PORT="${NCHAT_FRONTEND_PORT:-5173}"
DEFAULT_FRONTEND_HOST="${NCHAT_FRONTEND_HOST:-0.0.0.0}"

mkdir -p "$LOG_DIR"

STARTED_BACKEND=0
STARTED_FRONTEND=0
BACKEND_READY_EXTERNALLY=0
FRONTEND_READY_EXTERNALLY=0

SELECTED_HTTP_ADDR=""
SELECTED_GRPC_ADDR=""
SELECTED_FRONTEND_PORT=""
BACKEND_HEALTH_URL=""
CHAT_URL=""
CHAT_URL_LAN=""

is_running() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

read_pid_if_running() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file")"
    if [[ -n "$pid" ]] && is_running "$pid"; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

is_url_ready() {
  local url="$1"
  curl -fsS "$url" >/dev/null 2>&1
}

addr_port() {
  local addr="$1"
  echo "${addr##*:}"
}

url_for_http_port() {
  local port="$1"
  echo "http://127.0.0.1:${port}"
}

lan_url_for_http_port() {
  local port="$1"
  local lan_ip
  lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -z "$lan_ip" ]]; then
    echo "http://127.0.0.1:${port}"
    return
  fi
  echo "http://${lan_ip}:${port}"
}

health_url_for_http_port() {
  local port="$1"
  echo "http://127.0.0.1:${port}/healthz"
}

is_port_bound() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -E -q "(^|[\[\]:\.])${port}$"
    return $?
  fi
  return 1
}

is_port_bound_externally() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    # Consider a port externally reachable only when bound to wildcard or a non-loopback address.
    ss -ltn 2>/dev/null \
      | awk 'NR>1 {print $4}' \
      | grep -E "(^|[\[\]:\.])${port}$" \
      | grep -E -q '^(\*|0\.0\.0\.0|\[::\]|(?!127\.0\.0\.1)([0-9]{1,3}\.){3}[0-9]{1,3}|\[[0-9a-fA-F:]+\]):'
    return $?
  fi
  return 1
}

pick_backend_http_addr() {
  local preferred="$DEFAULT_HTTP_ADDR"
  local preferred_port
  preferred_port="$(addr_port "$preferred")"
  local preferred_health
  preferred_health="$(health_url_for_http_port "$preferred_port")"

  if is_url_ready "$preferred_health"; then
    BACKEND_READY_EXTERNALLY=1
    echo "$preferred"
    return 0
  fi

  if ! is_port_bound "$preferred_port"; then
    echo "$preferred"
    return 0
  fi

  for port in $(seq 8081 8090); do
    local candidate_health
    candidate_health="$(health_url_for_http_port "$port")"

    if is_url_ready "$candidate_health"; then
      BACKEND_READY_EXTERNALLY=1
      echo ":$port"
      return 0
    fi

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

pick_frontend_port() {
  local preferred="$DEFAULT_FRONTEND_PORT"

  if is_url_ready "$(url_for_http_port "$preferred")" && is_port_bound_externally "$preferred"; then
    FRONTEND_READY_EXTERNALLY=1
    echo "$preferred"
    return 0
  fi

  if ! is_port_bound "$preferred"; then
    echo "$preferred"
    return 0
  fi

  for port in $(seq 5174 5180); do
    if is_url_ready "$(url_for_http_port "$port")" && is_port_bound_externally "$port"; then
      FRONTEND_READY_EXTERNALLY=1
      echo "$port"
      return 0
    fi

    if ! is_port_bound "$port"; then
      echo "$port"
      return 0
    fi
  done

  return 1
}

stop_if_started() {
  if [[ "$STARTED_BACKEND" -eq 1 ]] && [[ -f "$BACKEND_PID_FILE" ]]; then
    local pid
    pid="$(cat "$BACKEND_PID_FILE")"
    if [[ -n "$pid" ]] && is_running "$pid"; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$BACKEND_PID_FILE"
  fi

  if [[ "$STARTED_FRONTEND" -eq 1 ]] && [[ -f "$FRONTEND_PID_FILE" ]]; then
    local pid
    pid="$(cat "$FRONTEND_PID_FILE")"
    if [[ -n "$pid" ]] && is_running "$pid"; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$FRONTEND_PID_FILE"
  fi
}

start_backend() {
  SELECTED_HTTP_ADDR="$(pick_backend_http_addr)" || {
    echo "No usable backend HTTP port found in range 8080-8090"
    return 1
  }
  BACKEND_HEALTH_URL="$(health_url_for_http_port "$(addr_port "$SELECTED_HTTP_ADDR")")"

  if [[ "$BACKEND_READY_EXTERNALLY" -eq 1 ]]; then
    echo "Backend already available on ${BACKEND_HEALTH_URL}"
    echo "$SELECTED_HTTP_ADDR" >"$BACKEND_HTTP_ADDR_FILE"
    return
  fi

  local pid
  if pid="$(read_pid_if_running "$BACKEND_PID_FILE")"; then
    echo "Backend already running (PID $pid) on $SELECTED_HTTP_ADDR"
    echo "$SELECTED_HTTP_ADDR" >"$BACKEND_HTTP_ADDR_FILE"
    return
  fi

  echo "Starting backend..."
  SELECTED_GRPC_ADDR="$(pick_grpc_addr)" || {
    echo "No free gRPC port found in range 9090-9100"
    return 1
  }

  if [[ "$SELECTED_HTTP_ADDR" != "$DEFAULT_HTTP_ADDR" ]]; then
    echo "HTTP port 8080 is in use, using fallback $SELECTED_HTTP_ADDR"
  fi

  if [[ "$SELECTED_GRPC_ADDR" != "$DEFAULT_GRPC_ADDR" ]]; then
    echo "gRPC port 9090 is in use, using fallback $SELECTED_GRPC_ADDR"
  fi

  (
    cd "$ROOT_DIR/backend"
    NCHAT_HTTP_ADDR="$SELECTED_HTTP_ADDR" NCHAT_GRPC_ADDR="$SELECTED_GRPC_ADDR" nohup go run ./cmd/nchatd >"$BACKEND_LOG" 2>&1 &
    echo $! >"$BACKEND_PID_FILE"
  )
  echo "$SELECTED_HTTP_ADDR" >"$BACKEND_HTTP_ADDR_FILE"
  echo "$SELECTED_GRPC_ADDR" >"$BACKEND_GRPC_ADDR_FILE"
  STARTED_BACKEND=1
  echo "Backend started (PID $(cat "$BACKEND_PID_FILE"))"
}

start_frontend() {
  SELECTED_FRONTEND_PORT="$(pick_frontend_port)" || {
    echo "No usable frontend port found in range 5173-5180"
    return 1
  }
  CHAT_URL="$(url_for_http_port "$SELECTED_FRONTEND_PORT")"
  CHAT_URL_LAN="$(lan_url_for_http_port "$SELECTED_FRONTEND_PORT")"

  if [[ "$FRONTEND_READY_EXTERNALLY" -eq 1 ]]; then
    echo "Frontend already available on ${CHAT_URL}"
    echo "$CHAT_URL_LAN" >"$FRONTEND_URL_FILE"
    return
  fi

  local pid
  if pid="$(read_pid_if_running "$FRONTEND_PID_FILE")"; then
    echo "Frontend already running (PID $pid) on $CHAT_URL"
    echo "$CHAT_URL_LAN" >"$FRONTEND_URL_FILE"
    return
  fi

  echo "Starting frontend..."
  local backend_api_base
  backend_api_base="$(url_for_http_port "$(addr_port "$SELECTED_HTTP_ADDR")")"

  (
    cd "$ROOT_DIR/frontend"
    VITE_NCHAT_API_BASE="$backend_api_base" VITE_NCHAT_WS_URL="ws://127.0.0.1:$(addr_port "$SELECTED_HTTP_ADDR")/ws" nohup npm run dev -- --host "$DEFAULT_FRONTEND_HOST" --port "$SELECTED_FRONTEND_PORT" --strictPort >"$FRONTEND_LOG" 2>&1 &
    echo $! >"$FRONTEND_PID_FILE"
  )
  echo "$CHAT_URL_LAN" >"$FRONTEND_URL_FILE"
  STARTED_FRONTEND=1
  echo "Frontend started (PID $(cat "$FRONTEND_PID_FILE"))"
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local max_attempts=120

  for ((i=1; i<=max_attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$label is ready"
      return 0
    fi
    sleep 0.5
  done

  echo "$label did not become ready in time"
  return 1
}

open_browser() {
  local url="$1"

  if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo "No desktop session detected. Open manually: $url"
    return 0
  fi

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
    echo "Opening chat interface: $url"
    return 0
  fi

  if command -v gio >/dev/null 2>&1; then
    gio open "$url" >/dev/null 2>&1 || true
    echo "Opening chat interface: $url"
    return 0
  fi

  echo "No browser opener found. Open manually: $url"
}

start_backend
start_frontend

if ! wait_for_url "$BACKEND_HEALTH_URL" "Backend"; then
  echo "Backend log (last 20 lines):"
  tail -n 20 "$BACKEND_LOG" || true
  stop_if_started
  exit 1
fi

if ! wait_for_url "$CHAT_URL" "Frontend"; then
  echo "Frontend log (last 20 lines):"
  tail -n 20 "$FRONTEND_LOG" || true
  stop_if_started
  exit 1
fi

open_browser "$CHAT_URL"

echo "Launcher finished. Logs:"
echo "  $BACKEND_LOG"
echo "  $FRONTEND_LOG"
if [[ -f "$BACKEND_HTTP_ADDR_FILE" ]]; then
  echo "Backend HTTP addr: $(cat "$BACKEND_HTTP_ADDR_FILE")"
fi
if [[ -f "$BACKEND_GRPC_ADDR_FILE" ]]; then
  echo "Backend gRPC addr: $(cat "$BACKEND_GRPC_ADDR_FILE")"
fi
if [[ -f "$FRONTEND_URL_FILE" ]]; then
  echo "Frontend URL (LAN): $(cat "$FRONTEND_URL_FILE")"
  echo "Frontend URL (local): $CHAT_URL"
fi
