#!/usr/bin/env bash
# App code must behave the same in CI and on a Mac. CI and test accommodations live in
# e2e/, *.spec.* files, playwright.config.ts and .github/, never in the app.
set -euo pipefail
cd "$(dirname "$0")/.."
pattern='process\.env\.(CI|WOBBLE_E2E)|import\.meta\.env\.(CI|VITE_E2E|VITE_CI)|WOBBLE_E2E|navigator\.webdriver|__playwright|env::var\("(CI|WOBBLE_E2E[A-Z_]*)"\)'
hits=$(grep -rnE "$pattern" src src-tauri/src crates static \
	--include='*.ts' --include='*.js' --include='*.svelte' --include='*.css' --include='*.rs' 2>/dev/null \
	| grep -vE '\.(spec|test)\.' || true)
if [ -n "$hits" ]; then
	echo "Test or CI switches found in app code (move the accommodation into e2e/ or CI config):"
	echo "$hits"
	exit 1
fi
echo "No test or CI switches in app code."
