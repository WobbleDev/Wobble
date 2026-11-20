#!/usr/bin/env bash
# Data-safety checks. Prints counts and file paths only, never matched text.
#   data-safety.sh files [base-ref]   fail if the repo (or the diff vs base-ref) holds database,
#                                     recording or evidence files outside the allowlist
#   data-safety.sh emails <dir>...    fail if text files (and zip traces) under the dirs contain an email address
#                                     outside the synthetic domains
#   data-safety.sh redact <dir>...    in the *.json files under the dirs, replace every non-synthetic address with
#                                     "[redacted-email]" in place, and name the key paths that held one (never the
#                                     value). Run it before `emails` so a report keeps explaining a failure.
set -euo pipefail

# Synthetic fixtures that are known safe.
ALLOW_FILES='^contract/fixtures/[a-z0-9.-]+\.sqlite$|^e2e/evidence\.ts$'
FILE_RE='\.(db|sqlite3?|db-wal|db-shm|wav|mp3|m4a|aac|ogg|webm|mov|mp4|har)$|(^|/)evidence[^/]*\.json$'
EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
SAFE_DOMAIN='@([a-z0-9.-]*example\.(com|org|net|test)|[a-z]\.(com|test)|localhost|users\.noreply\.github\.com)$|^noreply@github\.com$'
# GitHub's own address, the committer of every commit made in its web UI. Only this exact address:
# any other @github.com address is a person's.
# A Playwright trace's action log names its screenshot resources like
# "page@<hex>.jpeg", which EMAIL_RE reads as an address. Skip only that exact shape: a broader
# suffix list would also hide a real address on a real TLD (.zip is one).
TRACE_RESOURCE='^page@[0-9a-f]+\.(jpeg|jpg|png|webp)$'

mode="${1:-}"; shift || true
case "$mode" in
  files)
    base="${1:-}"
    if [ -n "$base" ]; then
      list=$(git diff --name-only --diff-filter=AM "$base"...HEAD)
    else
      list=$(git ls-files)
    fi
    bad=$(printf '%s\n' "$list" | grep -E "$FILE_RE" | grep -Ev "$ALLOW_FILES" || true)
    if [ -n "$bad" ]; then
      echo "Blocked data-like files ($(printf '%s\n' "$bad" | wc -l | tr -d ' ')):"
      printf '%s\n' "$bad"
      echo "Add only synthetic fixtures, and allowlist them in scripts/data-safety.sh."
      exit 1
    fi
    echo "files: clean"
    ;;
  emails)
    [ "$#" -ge 1 ] || { echo "usage: $0 emails <dir>..." >&2; exit 2; }
    hits=0
    for d in "$@"; do
      [ -e "$d" ] || continue
      while IFS= read -r f; do
        case "$f" in
          *.zip) src() { unzip -p "$f" 2>/dev/null | grep -aEoh "$EMAIL_RE" || true; } ;;
          *)     src() { grep -IEoh "$EMAIL_RE" "$f" 2>/dev/null || true; } ;;
        esac
        n=$(src | { grep -Eiv "$SAFE_DOMAIN" || true; } | { grep -Ev "$TRACE_RESOURCE" || true; } | wc -l | tr -d ' ')
        if [ "$n" -gt 0 ]; then echo "$f: $n non-synthetic address(es)"; hits=$((hits+n)); fi
      done < <(find "$d" -type f)
    done
    if [ "$hits" -gt 0 ]; then echo "emails: $hits hit(s)"; exit 1; fi
    echo "emails: clean"
    ;;
  redact)
    [ "$#" -ge 1 ] || { echo "usage: $0 redact <dir>..." >&2; exit 2; }
    total=0
    for d in "$@"; do
      [ -e "$d" ] || continue
      while IFS= read -r f; do
        # Only key paths and counts leave this step; array indexes collapse to [] so one field is one line.
        paths=$(jq -r --arg re "$EMAIL_RE" --arg safe "$SAFE_DOMAIN" --arg trace "$TRACE_RESOURCE" '
          def bad: test($safe; "i") or test($trace);
          [ paths(type == "string") as $p
            | (getpath($p) | [match($re; "g").string | select(bad | not)] | length) as $n
            | select($n > 0)
            | {path: ($p | map(if type == "number" then "[]" else . end) | join(".")), n: $n} ]
          | group_by(.path) | .[] | "\(.[0].path): \(map(.n) | add)"' "$f" 2>/dev/null) || { echo "$f: not valid JSON, left for the scan"; continue; }
        [ -n "$paths" ] || continue
        tmp="$f.redacted"
        jq --arg re "(?<e>$EMAIL_RE)" --arg safe "$SAFE_DOMAIN" --arg trace "$TRACE_RESOURCE" '
          def bad: test($safe; "i") or test($trace);
          walk(if type == "string" then gsub($re; if (.e | bad) then .e else "[redacted-email]" end) else . end)' "$f" > "$tmp" && mv "$tmp" "$f"
        n=$(printf '%s\n' "$paths" | awk -F': ' '{s+=$NF} END{print s}')
        total=$((total+n))
        echo "::warning file=$f::redacted $n non-synthetic address(es) in key path(s):"
        printf '%s\n' "$paths" | sed 's/^/  /'
      done < <(find "$d" -type f -name '*.json')
    done
    echo "redact: $total address(es) redacted"
    ;;
  *) echo "usage: $0 files [base-ref] | emails <dir>... | redact <dir>..." >&2; exit 2 ;;
esac
