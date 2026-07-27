#!/usr/bin/env bash
# Start GVI dev server on PORT (default 3010), killing any existing listener first.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="${PORT:-}"
if [[ -z "$PORT" ]]; then
  if [[ -f .env ]]; then
    PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  fi
  if [[ -z "$PORT" && -f .env.local ]]; then
    PORT="$(grep -E '^PORT=' .env.local 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  fi
fi
PORT="${PORT:-3010}"

echo "→ Freeing port $PORT (if occupied)..."
pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  echo "  Killing: $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.5
  still="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$still" ]]; then
    echo "  Force killing: $still"
    # shellcheck disable=SC2086
    kill -9 $still 2>/dev/null || true
    sleep 0.3
  fi
else
  echo "  Port $PORT is free"
fi

export PORT
echo "→ Starting GVI on http://localhost:$PORT/"
exec pnpm dev
