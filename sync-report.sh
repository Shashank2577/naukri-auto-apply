#!/bin/bash
# Rebuilds docs/ from the run logs and pushes to the repo.
# Called by ../naukri_update/watch-report.sh after every 5 new job attempts.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
LOGS="$REPO/../naukri_update"
cd "$REPO" || exit 1
SUMMARY=$(node make-report.js "$LOGS/results.debug.jsonl" "$LOGS/results.jsonl") || exit 1
printf '%s\n' "$SUMMARY"
git add docs
if ! git diff --cached --quiet; then
  NUMS="$(printf '%s' "$SUMMARY" | sed -n 's/^.*index\.html[^0-9]*//p')"
  MSG="Report update $(date '+%d %b %H:%M')"
  [ -n "$NUMS" ] && MSG="$MSG — $NUMS"
  git -c user.name="Shashank2577" -c user.email="shash2577@gmail.com" commit -q -m "$MSG

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git push -q origin main && echo "pushed $(date '+%H:%M')"
else echo "no change $(date '+%H:%M')"; fi
