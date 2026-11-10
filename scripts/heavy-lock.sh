#!/bin/sh
# Machine-wide lock for heavy checks (8 GB machine, several worktrees). Source it; it
# acquires at once and releases on exit (a script with its own EXIT trap calls heavy_release there). Skipped when WOBBLE_HEAVY_LOCK_HELD=1 (verify holds it).
heavy_release() { [ -z "${heavy_lock:-}" ] || rm -rf "$heavy_lock"; }
if [ -z "${WOBBLE_HEAVY_LOCK_HELD:-}" ]; then
	heavy_lock="${TMPDIR:-/tmp}/wobble-heavy.lock"
	heavy_waited=
	until mkdir "$heavy_lock" 2>/dev/null; do
		heavy_pid=$(cat "$heavy_lock/pid" 2>/dev/null || true)
		if [ -n "$heavy_pid" ] && ! kill -0 "$heavy_pid" 2>/dev/null; then
			rm -rf "$heavy_lock"
			continue
		fi
		if [ -z "$heavy_waited" ]; then
			echo "waiting for heavy lock held by ${heavy_pid:-unknown}"
			heavy_waited=1
		fi
		sleep "${WOBBLE_HEAVY_POLL:-10}"
	done
	echo $$ >"$heavy_lock/pid"
	trap heavy_release EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
fi
