#!/usr/bin/env bash
# Data-safety checks. Prints counts and file paths only, never matched text.
#   data-safety.sh files [base-ref]   fail if the repo (or the diff vs base-ref) holds database,
#                                     recording or evidence files outside the allowlist
#   data-safety.sh emails <dir>...    fail if text files (and zip traces) under the dirs contain an email address
#                                     outside the synthetic domains
set -euo pipefail

# Synthetic fixtures that are known safe.
ALLOW_FILES='^contract/fixtures/[a-z0-9.-]+\.sqlite$|^e2e/evidence\.ts$'
FILE_RE='\.(db|sqlite3?|db-wal|db-shm|wav|mp3|m4a|aac|ogg|webm|mov|mp4|har)$|(^|/)evidence[^/]*\.json$'
EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
SAFE_DOMAIN='@([a-z0-9.-]*example\.(com|org|net|test)|[a-z]\.(com|test)|localhost|users\.noreply\.github\.com)$'

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
        n=$(src | { grep -Eiv "$SAFE_DOMAIN" || true; } | wc -l | tr -d ' ')
        if [ "$n" -gt 0 ]; then echo "$f: $n non-synthetic address(es)"; hits=$((hits+n)); fi
      done < <(find "$d" -type f)
    done
    if [ "$hits" -gt 0 ]; then echo "emails: $hits hit(s)"; exit 1; fi
    echo "emails: clean"
    ;;
  *) echo "usage: $0 files [base-ref] | emails <dir>..." >&2; exit 2 ;;
esac
