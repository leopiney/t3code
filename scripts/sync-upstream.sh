#!/usr/bin/env bash
# Fetch official t3code main, rebase the current branch onto it, and build.
#
#   pnpm sync:upstream
#
# Stops if the working tree is dirty or the rebase hits conflicts. Does not push.
set -euo pipefail

cd "$(dirname "$0")/.."

upstream_url="https://github.com/pingdotgg/t3code.git"
if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$upstream_url"
fi

upstream_actual=$(git remote get-url upstream)
case "$upstream_actual" in
  "$upstream_url" | "git@github.com:pingdotgg/t3code.git") ;;
  *)
    echo "The upstream remote is ${upstream_actual}, not the official t3code repo." >&2
    exit 1
    ;;
esac

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit or stash your changes before syncing. Rebase needs a clean working tree." >&2
  exit 1
fi

branch=$(git branch --show-current)
if [ -z "$branch" ]; then
  echo "Check out a branch before syncing." >&2
  exit 1
fi

echo "Fetching official main..."
git fetch upstream main

echo "Rebasing ${branch} onto upstream/main..."
git rebase upstream/main

echo "Building..."
pnpm build
