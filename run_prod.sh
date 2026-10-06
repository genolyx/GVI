#!/usr/bin/env bash
# Production server. Default port is 3010.
exec "$(cd "$(dirname "$0")" && pwd)/run.sh" prod "$@"
