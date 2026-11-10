#!/bin/sh
# Create a ticket worktree; the post-checkout hook prepares it.
# Usage: scripts/new-ticket-worktree.sh NN-slug [base-branch]
set -eu
ticket=${1:?usage: new-ticket-worktree.sh NN-slug [base-branch]}
base=${2:-$(git branch --show-current)}
root=$(git rev-parse --show-toplevel)
dir="$root/.claude/worktrees/${ticket#*-}"

git -C "$root" worktree add -b "ticket/$ticket" "$dir" "$base"
echo "Ready: $dir (branch ticket/$ticket from $base)"
