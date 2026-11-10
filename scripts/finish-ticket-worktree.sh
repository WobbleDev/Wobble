#!/bin/sh
# Merge a ticket branch into the current branch and remove its worktree.
# Refuses while the worktree has uncommitted work, or when a check fails in it:
# npm run verify.
# A ticket that changes only .scratch/ skips the checks, as the pre-commit hook does;
# --skip-checks skips them by hand.
# Pass --e2e to gate this merge on the full Chromium suite; no nightly run is assumed.
# Usage: scripts/finish-ticket-worktree.sh NN-slug [--e2e] [--skip-checks]
set -eu
usage="usage: finish-ticket-worktree.sh NN-slug [--e2e] [--skip-checks]"
ticket=${1:?$usage}
shift
run_e2e=false
skip_checks=false
for arg in "$@"; do
	case "$arg" in
	--e2e) run_e2e=true ;;
	--skip-checks) skip_checks=true ;;
	*) echo "$usage" >&2; exit 1 ;;
	esac
done
root=$(git rev-parse --show-toplevel)
dir="$root/.claude/worktrees/${ticket#*-}"

if [ -n "$(git -C "$dir" status --porcelain)" ]; then
	echo "Refusing: $dir has uncommitted changes. Commit them first." >&2
	exit 1
fi

changed=$(git -C "$root" diff --name-only "main...ticket/$ticket")
if [ -z "$(printf '%s\n' "$changed" | grep -v '^\.scratch/' | grep .)" ]; then
	skip_checks=true
	echo "Only .scratch/ changed; skipping the checks."
fi

run_step() {
	echo "Running $* in $dir."
	if ! (cd "$dir" && "$@"); then
		echo "Refusing merge: $* failed." >&2
		exit 1
	fi
}

if [ "$skip_checks" = true ]; then
	echo "Skipping verify."
else
	# A fresh worktree has no compiled messages, and lint and check import them.
	run_step npm run i18n:compile
	run_step npm run verify
fi

if [ "$run_e2e" = true ]; then
	echo "Running npm run test:e2e in $dir."
	started=$(date +%s)
	if (cd "$dir" && npm run test:e2e); then
		echo "Chromium e2e passed in $(($(date +%s) - started))s."
	else
		echo "Refusing merge: Chromium e2e failed after $(($(date +%s) - started))s." >&2
		exit 1
	fi
else
	echo "Skipping e2e; use --e2e when this merge requires the full Chromium gate."
fi

git -C "$root" merge --ff-only "ticket/$ticket" ||
	git -C "$root" merge --no-ff --no-edit -m "merge: ticket $ticket" "ticket/$ticket"
git -C "$root" worktree remove --force "$dir"
echo "Merged ticket/$ticket and removed $dir"
