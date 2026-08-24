#!/usr/bin/env bash
# GVI local dev helper — start / stop / restart the app (and optional Docker deps).
#
# Usage:
#   ./run.sh              # restart (default): free PORT, start pnpm dev
#   ./run.sh start        # start only if port is free
#   ./run.sh stop         # kill process listening on PORT
#   ./run.sh restart      # stop then start
#   ./run.sh status       # show port / docker status
#   ./run.sh up           # docker compose up -d (db + minio), then restart app
#
# Env: PORT (default from .env / .env.local, else 3010)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

CMD="${1:-restart}"

read_port() {
  local port="${PORT:-}"
  if [[ -z "$port" && -f .env ]]; then
    port="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  fi
  if [[ -z "$port" && -f .env.local ]]; then
    port="$(grep -E '^PORT=' .env.local 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  fi
  echo "${port:-3010}"
}

PORT="$(read_port)"
export PORT
export NODE_ENV="${NODE_ENV:-development}"

# Prefer .env then .env.local for other vars (tsx/vite also load .env).
load_dotenv_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$file" | sed 's/\r$//')
  set +a
}
load_dotenv_file .env
load_dotenv_file .env.local
PORT="$(read_port)"
export PORT

pids_on_port() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

stop_app() {
  echo "→ Stopping GVI on port $PORT..."
  local pids
  pids="$(pids_on_port)"
  if [[ -z "$pids" ]]; then
    echo "  Port $PORT is already free"
    return 0
  fi
  echo "  Killing: $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.5
  local still
  still="$(pids_on_port)"
  if [[ -n "$still" ]]; then
    echo "  Force killing: $still"
    # shellcheck disable=SC2086
    kill -9 $still 2>/dev/null || true
    sleep 0.3
  fi
  echo "  Stopped"
}

start_app() {
  if [[ -n "$(pids_on_port)" ]]; then
    echo "→ Port $PORT already in use. Use './run.sh restart' or './run.sh stop' first."
    exit 1
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "error: pnpm not found" >&2
    exit 1
  fi
  echo "→ Starting GVI on http://localhost:$PORT/"
  exec pnpm dev
}

status_app() {
  echo "PORT=$PORT"
  local pids
  pids="$(pids_on_port)"
  if [[ -n "$pids" ]]; then
    echo "app: listening (pids: $pids)"
  else
    echo "app: not running"
  fi
  if command -v docker >/dev/null 2>&1; then
    docker compose ps 2>/dev/null || docker-compose ps 2>/dev/null || echo "docker: compose status unavailable"
  else
    echo "docker: not installed"
  fi
}

docker_up() {
  echo "→ Starting Docker services (db, minio)..."
  if docker compose version >/dev/null 2>&1; then
    docker compose up -d
  else
    docker-compose up -d
  fi
  echo "  Waiting for MySQL health..."
  local i
  for i in $(seq 1 30); do
    if docker exec gvi-db mysqladmin ping -h localhost -u root -pgvi_root_password --silent 2>/dev/null; then
      echo "  MySQL ready"
      break
    fi
    sleep 1
    if [[ "$i" -eq 30 ]]; then
      echo "  warning: MySQL health check timed out (continuing anyway)"
    fi
  done
}

case "$CMD" in
  start)
    start_app
    ;;
  stop)
    stop_app
    ;;
  restart|"")
    stop_app
    start_app
    ;;
  status)
    status_app
    ;;
  up)
    docker_up
    stop_app
    start_app
    ;;
  -h|--help|help)
    sed -n '2,14p' "$0"
    ;;
  *)
    echo "Unknown command: $CMD (try: start|stop|restart|status|up)" >&2
    exit 1
    ;;
esac
