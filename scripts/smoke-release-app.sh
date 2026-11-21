#!/usr/bin/env bash
# Launch the built release app, check it stays up, then quit it.
#   scripts/smoke-release-app.sh [path/to/Wobble.app]
# The app starts locked, so nothing is opened or read beyond its own window state. The database
# path points at a throwaway directory anyway, so the run never touches a real database.
# SMOKE_SECONDS (default 15) is how long the app must survive after launch.
set -euo pipefail
cd "$(dirname "$0")/.."

app="${1:-target/release/bundle/macos/Wobble.app}"
seconds="${SMOKE_SECONDS:-15}"

if [ ! -d "$app/Contents/MacOS" ]; then
	echo "No app bundle at $app (build it first: npx tauri build --bundles app)."
	exit 1
fi
bins=("$app"/Contents/MacOS/*)
if [ "${#bins[@]}" -ne 1 ] || [ ! -x "${bins[0]}" ]; then
	echo "Expected exactly one executable in $app/Contents/MacOS, found ${#bins[@]}."
	exit 1
fi

work=$(mktemp -d)
log="$work/app.log"
pid=""
cleanup() {
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
	rm -rf "$work"
}
trap cleanup EXIT

WOBBLE_DB_PATH="$work/smoke.sqlite" "${bins[0]}" >"$log" 2>&1 &
pid=$!
echo "Launched the release app (pid $pid); it must stay up for ${seconds}s."

for ((i = 1; i <= seconds; i++)); do
	sleep 1
	if ! kill -0 "$pid" 2>/dev/null; then
		status=0
		wait "$pid" || status=$?
		pid=""
		echo "The app exited after ${i}s with status $status. Last output:"
		tail -n 40 "$log"
		exit 1
	fi
done

if grep -qE "panicked at|thread '.*' panicked" "$log"; then
	echo "The app is still running but its output reports a panic:"
	tail -n 40 "$log"
	exit 1
fi

kill -TERM "$pid" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
	kill -0 "$pid" 2>/dev/null || break
	sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
	echo "The app ignored SIGTERM and had to be killed."
	exit 1
fi
wait "$pid" 2>/dev/null || true
pid=""
echo "Smoke test passed: the release app stayed up for ${seconds}s and quit."
