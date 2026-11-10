#!/bin/sh
# Build once and serve the app for Playwright, so runs skip the webServer
# build and its timeout. Stop with Ctrl-C.
# Usage: WOBBLE_E2E_PORT=4300 WOBBLE_E2E_DB=/path/to/test.sqlite scripts/e2e-server.sh
set -eu
port=${WOBBLE_E2E_PORT:-4173}
db=${WOBBLE_E2E_DB:-${TMPDIR:-/tmp}/wobble-e2e-$(basename "$PWD").sqlite}
rm -f "$db" "$db-shm" "$db-wal" "$db-journal"
npm run build
echo "Run tests with:"
echo "  WOBBLE_E2E_REUSE=1 WOBBLE_E2E_PORT=$port WOBBLE_E2E_SUITE=regular WOBBLE_E2E_DB=$db npx playwright test e2e/<file> --project=chromium --workers=1"
WOBBLE_DB_PATH="$db" WOBBLE_SHIM_PORT=$port WOBBLE_STATIC_DIR=build exec cargo run -p wobble-dev-shim
