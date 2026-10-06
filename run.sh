#!/usr/bin/env bash
# GVI local helper — background dev or production server.
#
# Usage:
#   ./run_dev.sh  start|stop|restart|status
#   ./run_prod.sh start|stop|restart|status
#   ./run.sh status
#
# dev  listens on DEV_PORT (else 3012) and runs `pnpm dev`.
# prod listens on PROD_PORT (else 3010) and runs `pnpm start`.
# Each mode has its own pid file and log, so both can stay up.
#
# Env: DEV_PORT, PROD_PORT
#      GVI_LOG, GVI_PIDFILE, GVI_MODEFILE (optional overrides)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

MODE="${1:-}"
ACTION="${2:-}"
LOG=""
PIDFILE=""
MODEFILE=""

usage() {
  sed -n '2,14p' "$0" >&2
  exit 1
}

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

apply_mode_paths() {
  local mode="$1"
  case "$mode" in
    dev)
      PORT="${DEV_PORT:-3012}"
      LOG="${GVI_LOG:-$ROOT/logs/server-dev.log}"
      PIDFILE="${GVI_PIDFILE:-$ROOT/pids/server-dev.pid}"
      MODEFILE="${GVI_MODEFILE:-$ROOT/pids/server-dev.mode}"
      # .env.local turns Google on for the production build. This process
      # must keep Dev Login, and must not send OAuth back to the prod host.
      export VITE_GOOGLE_AUTH=false
      export VITE_DEV_AUTH=true
      unset GOOGLE_REDIRECT_URI
      ;;
    prod)
      PORT="${PROD_PORT:-3010}"
      LOG="${GVI_LOG:-$ROOT/logs/server-prod.log}"
      PIDFILE="${GVI_PIDFILE:-$ROOT/pids/server-prod.pid}"
      MODEFILE="${GVI_MODEFILE:-$ROOT/pids/server-prod.mode}"
      ;;
  esac
  export PORT
}

pids_on_port() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

stop_pidfile() {
  [[ -f "$PIDFILE" ]] || return 0
  local pid
  pid="$(tr -d '[:space:]' < "$PIDFILE" || true)"
  rm -f "$PIDFILE"
  [[ -n "$pid" ]] || return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  echo "  Killing process group: $pid"
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  sleep 0.3
  if kill -0 "$pid" 2>/dev/null; then
    echo "  Force killing process group: $pid"
    kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    sleep 0.2
  fi
}

stop_legacy_dev() {
  [[ "$MODE" == "dev" && -f "$ROOT/pids/server.pid" ]] || return 0
  local saved="$PIDFILE"
  PIDFILE="$ROOT/pids/server.pid"
  stop_pidfile
  PIDFILE="$saved"
  rm -f "$ROOT/pids/server.mode"
}

stop_app() {
  echo "→ Stopping GVI ($MODE) on port $PORT..."
  stop_legacy_dev
  stop_pidfile
  local pids
  pids="$(pids_on_port)"
  if [[ -z "$pids" ]]; then
    echo "  Port $PORT is already free"
    rm -f "$MODEFILE"
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
  rm -f "$MODEFILE"
  echo "  Stopped"
}

wait_until_listening() {
  local pid="$1"
  local i
  for i in $(seq 1 50); do
    if [[ -n "$(pids_on_port)" ]]; then
      echo "  Listening (pid $pid)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "error: process exited before binding port $PORT" >&2
      tail -n 40 "$LOG" >&2 || true
      rm -f "$PIDFILE" "$MODEFILE"
      exit 1
    fi
    sleep 0.2
  done
  echo "error: timed out waiting for port $PORT" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
}

start_app() {
  local mode="$1"
  if [[ -n "$(pids_on_port)" ]]; then
    echo "→ Port $PORT already in use. Use './run_${mode}.sh restart' or './run_${mode}.sh stop' first."
    exit 1
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "error: pnpm not found" >&2
    exit 1
  fi

  local launch=()
  case "$mode" in
    dev)
      launch=(pnpm dev)
      ;;
    prod)
      if [[ ! -f "$ROOT/dist/index.js" ]]; then
        echo "error: dist/index.js not found. Run 'pnpm build' first." >&2
        exit 1
      fi
      launch=(pnpm start)
      ;;
    *)
      echo "error: unknown mode $mode" >&2
      exit 1
      ;;
  esac

  mkdir -p "$(dirname "$LOG")" "$(dirname "$PIDFILE")"
  echo "→ Starting GVI on http://localhost:$PORT/ (background, $mode)"
  echo "  log: $LOG"
  {
    echo ""
    echo "----- $(date -Is) $mode -----"
  } >>"$LOG"
  setsid nohup "${launch[@]}" >>"$LOG" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  echo "$mode" > "$MODEFILE"
  wait_until_listening "$pid"
}

status_app() {
  echo "PORT=$PORT"
  local pids mode="unknown"
  pids="$(pids_on_port)"
  if [[ -f "$MODEFILE" ]]; then
    mode="$(tr -d '[:space:]' < "$MODEFILE")"
  fi
  if [[ -n "$pids" ]]; then
    echo "app: listening (mode: $mode, pids: $pids)"
  else
    echo "app: not running"
  fi
  if [[ -f "$PIDFILE" ]]; then
    echo "pidfile: $PIDFILE ($(tr -d '[:space:]' < "$PIDFILE"))"
  else
    echo "pidfile: none"
  fi
  echo "log: $LOG"
}

case "$MODE" in
  -h|--help|help|"")
    usage
    ;;
  status)
    apply_mode_paths dev
    status_app
    echo
    apply_mode_paths prod
    status_app
    exit 0
    ;;
  dev|prod)
    apply_mode_paths "$MODE"
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage
    ;;
esac

case "$ACTION" in
  start)
    start_app "$MODE"
    ;;
  stop)
    stop_app
    ;;
  restart)
    stop_app
    start_app "$MODE"
    ;;
  status)
    status_app
    ;;
  *)
    echo "Unknown action: ${ACTION:-} (try: start|stop|restart)" >&2
    usage
    ;;
esac
