#!/bin/sh
# Nightly run on a clean checkout of local main, in a dedicated worktree ($HOME/wobble-nightly):
# test:rust, test:e2e (all suites), test:e2e:flaky; on Sundays (or with --weekly) also
# test:e2e:webkit and the benchmark suite. All with one Playwright worker.
# Writes .scratch/overnight/YYYY-MM-DD.md in the main checkout (same shape as the
# overnight reports; scripts/check-overnight-fresh.mjs reads the file name). Never commits
# or pushes; land the report yourself. Refuses to run if the worktree has tracked changes.
# Scheduling: scripts/launchd/com.wobble.nightly.plist.
# Usage: scripts/nightly.sh [--weekly]
set -eu
PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# launchd has no shell profile: add the newest nvm Node.
for bin in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$bin" ] && PATH="$bin:$PATH"; done
main=$(cd "$(dirname "$0")/.." && pwd)
nightly=${WOBBLE_NIGHTLY_DIR:-$HOME/wobble-nightly}
day=$(date +%Y-%m-%d)
weekly=false
if [ "${1:-}" = --weekly ] || [ "$(date +%u)" = 7 ]; then weekly=true; fi

if [ -d "$nightly" ]; then
	git -C "$nightly" checkout --detach main
else
	git -C "$main" worktree add --detach "$nightly" main
fi
if [ -n "$(git -C "$nightly" status --porcelain --untracked-files=no)" ]; then
	echo "Refusing: $nightly has tracked changes." >&2
	exit 1
fi
for dir in node_modules target; do
	[ -e "$nightly/$dir" ] || cp -Rc "$main/$dir" "$nightly/$dir"
done

cd "$nightly"
export WOBBLE_E2E_WORKERS=1
export WOBBLE_E2E_PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
revision=$(git rev-parse --short HEAD)
work=$(mktemp -d "${TMPDIR:-/tmp}/wobble-nightly.XXXXXX")
rows="$work/rows.tsv"
: >"$rows"

# step <name> <command...>: run it, log it, record "name<TAB>result<TAB>seconds<TAB>run dir".
step() {
	name=$1
	shift
	dir="$work/$(echo "$name" | tr ' :/' '---')"
	mkdir -p "$dir"
	echo "== $name"
	started=$(date +%s)
	set +e
	WOBBLE_E2E_RUN_DIR="$dir" "$@" >"$dir/output.log" 2>&1
	status=$?
	set -e
	if [ "$status" -eq 0 ]; then result=pass; else result="fail ($status)"; fi
	printf '%s\t%s\t%s\t%s\n' "$name" "$result" "$(($(date +%s) - started))" "$dir" >>"$rows"
}

step "npm run test:rust" npm run test:rust
step "npm run test:e2e" npm run test:e2e
step "npm run test:e2e:flaky" npm run test:e2e:flaky
if [ "$weekly" = true ]; then
	step "npm run test:e2e:webkit" npm run test:e2e:webkit
	step "scripts/e2e-all.sh benchmark" scripts/e2e-all.sh benchmark
fi

mkdir -p "$main/.scratch/overnight"
report="$main/.scratch/overnight/$day.md"
REVISION=$revision DAY=$day ROWS=$rows node -e '
const fs = require("node:fs");
const path = require("node:path");
const { REVISION, DAY, ROWS } = process.env;
const rows = fs.readFileSync(ROWS, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const find = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
	e.isDirectory() ? find(path.join(dir, e.name)) : e.name === "results.json" ? [path.join(dir, e.name)] : []);
const failures = (file) => {
	const out = [];
	const walk = (suite, titles) => {
		const here = suite.title ? [...titles, suite.title] : titles;
		for (const spec of suite.specs ?? [])
			for (const t of spec.tests ?? [])
				if (t.status === "unexpected") out.push(`${suite.file ?? ""} ${spec.title}`.trim());
		for (const child of suite.suites ?? []) walk({ file: suite.file, ...child }, here);
	};
	try { for (const s of JSON.parse(fs.readFileSync(file, "utf8")).suites ?? []) walk(s, []); } catch {}
	return out;
};
const lines = [`# Overnight ${DAY}`, "", `Revision \`${REVISION}\` (main, detached worktree, 1 worker). Report only; nothing committed.`, "", "## Steps", "| command | result | time |", "| --- | --- | --- |"];
for (const [name, result, secs] of rows) lines.push(`| ${name} | ${result} | ${secs}s |`);
const e2e = [];
for (const [name, , , dir] of rows) {
	const manifest = path.join(dir, "manifest.json");
	if (!fs.existsSync(manifest)) continue;
	for (const s of JSON.parse(fs.readFileSync(manifest, "utf8")).suites)
		e2e.push(`| ${name} | ${s.suite} | ${s.status} | ${s.executed}/${s.discovered} run, ${s.failed} failed | ${(s.durationMs / 1000).toFixed(0)}s |`);
}
if (e2e.length) lines.push("", "## E2E suites", "| step | suite | result | tests | duration |", "| --- | --- | --- | --- | --- |", ...e2e);
const failed = [];
for (const [name, , , dir] of rows) for (const f of find(dir)) for (const t of failures(f)) failed.push(`- ${t} (${name})`);
if (failed.length) lines.push("", "## Failing tests", ...failed);
fs.writeFileSync(process.argv[1], lines.join("\n") + "\n");
' "$report"
echo "Report: $report"
echo "Logs: $work"
! grep -q "	fail" "$rows"
