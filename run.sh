#!/bin/bash
# Local scheduled scraper for empty-legs.
# Pulls latest, runs the crawler + injector, commits and pushes any data changes.
# Run daily via launchd (see com.kevin.empty-legs.plist).

set -euo pipefail

REPO_DIR="/Users/kevinmonahan/dev/empty-legs"
cd "$REPO_DIR"

# Keep PATH sane under launchd (which starts with a minimal environment).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') : starting run ====="

# Sync with remote so we don't push a stale tree.
git pull --ff-only origin main

python3 crawler.py
python3 inject.py

git add empty_legs.json index.html
if git diff --cached --quiet; then
  echo "No changes to commit."
else
  git commit -m "chore: update empty legs data [$(date -u '+%Y-%m-%d')]"
  git push origin main
  echo "Pushed updated data."
fi

echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') : run complete ====="
