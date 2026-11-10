#!/bin/sh
# Land a nightly run's report on main, whether or not its fixes merged.
# Copies .scratch/overnight/D.md, and .scratch/overnight/flakes.md when the branch has
# one, from ticket/overnight-D into the main checkout and commits only those paths, so
# your own staged and unstaged changes stay exactly as they are.
# Run it from the main checkout, on main.
# Set LAND_CO_AUTHOR to add a Co-Authored-By trailer to the commit.
# Usage: scripts/land-overnight-report.sh YYYY-MM-DD
set -eu
day=${1:?usage: land-overnight-report.sh YYYY-MM-DD}
case "$day" in
[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
*) echo "usage: land-overnight-report.sh YYYY-MM-DD" >&2; exit 1 ;;
esac
branch="ticket/overnight-$day"
report=".scratch/overnight/$day.md"
flakes=".scratch/overnight/flakes.md"
root=$(git rev-parse --show-toplevel)

if [ "$(git -C "$root" branch --show-current)" != main ]; then
	echo "Refusing: $root is not on main." >&2
	exit 1
fi
if ! git -C "$root" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
	echo "Refusing: branch $branch does not exist." >&2
	exit 1
fi
if ! git -C "$root" cat-file -e "$branch:$report" 2>/dev/null; then
	echo "Refusing: $branch has no $report." >&2
	exit 1
fi

# The report is new each night: the main checkout's copy must be absent or the branch's.
if [ -e "$root/$report" ] &&
	! git -C "$root" show "$branch:$report" | cmp -s - "$root/$report"; then
	echo "Refusing: $report in the main checkout differs from $branch." >&2
	exit 1
fi
# flakes.md is a running log: it may differ from the branch, but only as committed.
land_flakes=false
if git -C "$root" cat-file -e "$branch:$flakes" 2>/dev/null; then
	if [ -e "$root/$flakes" ] && ! git -C "$root" diff --quiet HEAD -- "$flakes" 2>/dev/null; then
		echo "Refusing: $flakes has uncommitted changes in the main checkout." >&2
		exit 1
	fi
	if [ -e "$root/$flakes" ] && ! git -C "$root" ls-files --error-unmatch "$flakes" >/dev/null 2>&1; then
		echo "Refusing: $flakes in the main checkout is untracked." >&2
		exit 1
	fi
	land_flakes=true
fi

mkdir -p "$root/.scratch/overnight"
paths="$report"
git -C "$root" show "$branch:$report" >"$root/$report"
if [ "$land_flakes" = true ]; then
	git -C "$root" show "$branch:$flakes" >"$root/$flakes"
	paths="$paths $flakes"
fi

# shellcheck disable=SC2086
if [ -z "$(git -C "$root" status --porcelain -- $paths)" ]; then
	echo "Already on main: $paths"
	exit 0
fi
# shellcheck disable=SC2086
git -C "$root" add -- $paths
if [ -n "${LAND_CO_AUTHOR:-}" ]; then
	# shellcheck disable=SC2086
	git -C "$root" commit -m "docs(overnight): $day report" -m "Co-Authored-By: $LAND_CO_AUTHOR" -- $paths
else
	# shellcheck disable=SC2086
	git -C "$root" commit -m "docs(overnight): $day report" -- $paths
fi
echo "Landed $paths from $branch as $(git -C "$root" rev-parse --short HEAD)."
