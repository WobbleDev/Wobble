#!/bin/sh
# Leak checks for commits about to be pushed. Called by .githooks/pre-push.
# Usage: check-pushed-leaks.sh <revision-range-args...>   (e.g. "<sha> --not --remotes")
# - gitleaks scan of the range (skipped with a warning if gitleaks is missing)
# - denylist check against a private local file, never committed. Path comes from
#   WOBBLE_DENYLIST, default ~/wobble-archive/move-denylist/denylist.txt.
#   Output is commit and file names plus counts only, never matched text.
rc=0

if command -v gitleaks >/dev/null 2>&1; then
	opts="$*"
	if ! gitleaks git --help >/dev/null 2>&1; then
		gitleaks detect --redact --no-banner --log-opts="$opts" || rc=1
	else
		gitleaks git --redact --no-banner --log-opts="$opts" || rc=1
	fi
else
	echo "pre-push: WARNING gitleaks not installed, skipping local secret scan (CI still runs it)." >&2
fi

deny="${WOBBLE_DENYLIST:-$HOME/wobble-archive/move-denylist/denylist.txt}"
if [ ! -f "$deny" ]; then
	echo "pre-push: WARNING denylist not found, skipping real-string check. Set WOBBLE_DENYLIST to enable." >&2
else
	hits=0
	for c in $(git rev-list "$@"); do
		short=$(git rev-parse --short "$c")
		if git log -1 --format=%B "$c" | grep -aiqF -f "$deny"; then
			echo "pre-push: denylist hit in commit message of $short" >&2
			hits=$((hits + 1))
		fi
		for f in $(git diff-tree --no-commit-id --name-only -r --diff-filter=AM "$c"); do
			if git show "$c:$f" 2>/dev/null | grep -aiqF -f "$deny"; then
				echo "pre-push: denylist hit in $f (commit $short)" >&2
				hits=$((hits + 1))
			fi
		done
	done
	if [ "$hits" -gt 0 ]; then
		echo "pre-push: $hits denylist hit(s). Matched text is intentionally not printed." >&2
		rc=1
	fi
fi
exit $rc
