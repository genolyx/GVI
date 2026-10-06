#!/usr/bin/env bash
# Development server. Default port is 3012.
exec "$(cd "$(dirname "$0")" && pwd)/run.sh" dev "$@"
