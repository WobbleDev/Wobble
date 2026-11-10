#!/bin/sh
# Run every e2e suite against one build: build the SPA and the dev shim once, then serve
# the prebuilt shim for each suite in turn (one fresh DB per suite) instead of letting each
# Playwright run rebuild everything. Chromium only; add WOBBLE_E2E_WEBKIT=1 for WebKit.
# Each invocation keeps its evidence under one private run directory.
# Usage: scripts/e2e-all.sh [suite ...]   (default: all eight; `ui` replays recordings on its own vite preview, no shim)
set -eu
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-1}
export RUST_TEST_THREADS=${RUST_TEST_THREADS:-1}
# shellcheck source=heavy-lock.sh
. "$(dirname "$0")/heavy-lock.sh"
started_ms=$(($(date +%s) * 1000))
started_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
suites=${*:-boot-lifecycle onboarding settings delete-worksite regular mapping no-scroll-density ui}
if [ "$suites" = mapping ] && [ -z "${WOBBLE_E2E_PORT:-}" ]; then
 # A focused map check must not require stopping the organizer's running app.
 port=$(node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
else
 port=${WOBBLE_E2E_PORT:-4173}
fi

known="boot-lifecycle onboarding settings delete-worksite regular no-scroll-density ui benchmark mapping"
for suite in $suites; do
	case " $known " in
	*" $suite "*) ;;
	*) echo "Unknown e2e suite \"$suite\". Use one of: $known." >&2; exit 1 ;;
	esac
done

# Refuse a port someone else owns: adopting a foreign server would test the wrong build.
if node -e 'const net=require("node:net");const s=net.connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' "$port"; then
	echo "Port $port is already in use; refusing to adopt the existing server." >&2
	exit 1
fi

run_dir=${WOBBLE_E2E_RUN_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/wobble-e2e-run.XXXXXX")}
mkdir -p "$run_dir"
export WOBBLE_E2E_RUN_DIR="$run_dir"
echo "Run directory: $run_dir"

db_prefix=${WOBBLE_E2E_DB:-}
if [ -n "$db_prefix" ]; then
	db_prefix=${db_prefix%.*}
fi
mkdir -p "$run_dir/db"

npm run build
cargo build -p wobble-dev-shim
target_dir=$(cargo metadata --format-version 1 --no-deps | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).target_directory)')
shim="$target_dir/debug/wobble-dev-shim"
export WOBBLE_E2E_SHIM="$shim"

shim_pid=
stop_shim() {
	if [ -n "$shim_pid" ]; then
		kill "$shim_pid" 2>/dev/null || true
		wait "$shim_pid" 2>/dev/null || true
		shim_pid=
	fi
}
trap 'stop_shim; heavy_release' EXIT INT TERM

failed=
for suite in $suites; do
	suite_dir="$run_dir/$suite"
	mkdir -p "$suite_dir"
	case $suite in
	settings) spec=e2e/settings.spec.ts ;;
	*) spec= ;;
	esac
	if [ "$suite" = ui ]; then
		# Recorded responses, no shim and no database: Playwright serves the static SPA itself
		# on the ui port (4174 unless WOBBLE_E2E_UI_PORT is set).
		db=
		printf '{}\n' >"$suite_dir/database.json"
		echo "== e2e suite: $suite"
		suite_started=$(date +%s)
		set +e
		WOBBLE_E2E_PORT=${WOBBLE_E2E_UI_PORT:-4174} WOBBLE_E2E_SUITE=ui npx playwright test
		status=$?
		set -e
	else
	if [ -n "$db_prefix" ]; then
		db="$db_prefix-$suite.sqlite"
	else
		db="$run_dir/db/$suite.sqlite"
	fi
	mkdir -p "$(dirname "$db")"
	rm -f "$db" "$db-shm" "$db-wal" "$db-journal"
	printf '{"path":"%s"}\n' "$db" >"$suite_dir/database.json"
	WOBBLE_DB_PATH="$db" WOBBLE_SHIM_PORT=$port WOBBLE_STATIC_DIR=build "$shim" >"$suite_dir/server.log" 2>&1 &
	shim_pid=$!
	tries=0
	until curl -fs "http://127.0.0.1:$port/workers" >/dev/null 2>&1; do
		tries=$((tries + 1))
		if [ "$tries" -gt 60 ] || ! kill -0 "$shim_pid" 2>/dev/null; then
			echo "dev shim did not start for suite $suite" >&2
			tail -n 40 "$suite_dir/server.log" >&2 || true
			exit 1
		fi
		sleep 0.5
	done
	echo "== e2e suite: $suite"
	suite_started=$(date +%s)
	set +e
	# The @flaky set is empty when no spec is tagged; that is a pass, not "No tests found".
	if [ -n "${WOBBLE_E2E_FLAKY:-}" ]; then flaky_flag=--pass-with-no-tests; else flaky_flag=; fi
	# shellcheck disable=SC2086
	WOBBLE_E2E_REUSE=1 WOBBLE_E2E_PORT=$port WOBBLE_E2E_SUITE=$suite WOBBLE_E2E_DB=$db npx playwright test $flaky_flag $spec
	status=$?
	set -e
	fi
	suite_finished=$(date +%s)
	if [ -f "$suite_dir/results.json" ]; then
		node -e 'const fs=require("node:fs");const [resultsFile,summaryFile]=process.argv.slice(1);let summary={discovered:0,executed:0,skipped:0,failed:0,durationMs:0,status:"failed"};try{const stats=JSON.parse(fs.readFileSync(resultsFile,"utf8")).stats;summary={discovered:stats.expected+stats.unexpected+stats.flaky+stats.skipped,executed:stats.expected+stats.unexpected+stats.flaky,skipped:stats.skipped,failed:stats.unexpected,durationMs:stats.duration,status:stats.unexpected>0?"failed":"passed"};}catch{}fs.writeFileSync(summaryFile,JSON.stringify(summary)+"\n");' "$suite_dir/results.json" "$suite_dir/summary.json"
	else
		printf '{"discovered":0,"executed":0,"skipped":0,"failed":0,"durationMs":0,"status":"failed"}\n' >"$suite_dir/summary.json"
	fi
	if [ "$status" -ne 0 ]; then
		failed="$failed $suite"
	fi
	echo "== e2e suite: $suite exit=$status duration=$((suite_finished - suite_started))s"
	stop_shim
done

finished_ms=$(($(date +%s) * 1000))
finished_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
export RUN_DIR="$run_dir" RUN_SELECTION="$suites" RUN_STARTED_AT="$started_at" RUN_FINISHED_AT="$finished_at" RUN_STARTED_MS="$started_ms" RUN_FINISHED_MS="$finished_ms" RUN_PORT="$port" RUN_NODE_VERSION="$(node --version)" RUN_PLAYWRIGHT_VERSION="$(npx playwright --version 2>/dev/null | tr -d '\n')" RUN_REVISION="$(git rev-parse HEAD)"
node -e 'const fs=require("node:fs");const path=require("node:path");const env=process.env;const runDir=env.RUN_DIR;const selection=env.RUN_SELECTION.split(/\s+/).filter(Boolean);const suites=selection.map((suite)=>{const dir=path.join(runDir,suite);const read=(name,fallback)=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name),"utf8"));}catch{return fallback;}};const summary=read("summary.json",{discovered:0,executed:0,skipped:0,failed:0,durationMs:0,status:"failed"});return{suite,status:summary.status,discovered:summary.discovered,executed:summary.executed,skipped:summary.skipped,failed:summary.failed,durationMs:summary.durationMs,database:read("database.json",{}).path||null,serverLog:path.join(dir,"server.log"),results:path.join(dir,"results.json"),summary:path.join(dir,"summary.json")};});const manifest={revision:env.RUN_REVISION,selection,startedAt:env.RUN_STARTED_AT,finishedAt:env.RUN_FINISHED_AT,durationMs:Number(env.RUN_FINISHED_MS)-Number(env.RUN_STARTED_MS),versions:{node:env.RUN_NODE_VERSION,playwright:env.RUN_PLAYWRIGHT_VERSION},workers:1,port:Number(env.RUN_PORT),databases:Object.fromEntries(suites.map((entry)=>[entry.suite,entry.database])),suites,verdict:suites.every((entry)=>entry.status==="passed")?"passed":"failed"};const manifestFile=path.join(runDir,"manifest.json");fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+"\n");console.log("Manifest: "+manifestFile);'

if [ -n "$failed" ]; then
	echo "Failed suites:$failed" >&2
	exit 1
fi
