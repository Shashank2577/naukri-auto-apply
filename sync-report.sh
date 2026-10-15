#!/bin/bash
# Rebuilds docs/ from the run logs and pushes to the repo. Run every 15 min during a live run.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
LOGS="$REPO/../naukri_update"
cd "$REPO" || exit 1
node make-report.js "$LOGS/naukri-live.attempt1.log" "$LOGS/naukri-live.attempt2.log" "$LOGS/naukri-live.log" || exit 1
git add docs && if ! git diff --cached --quiet; then
  git -c user.name="Shashank2577" -c user.email="shash2577@gmail.com" commit -q -m "Report update $(date '+%d %b %H:%M')

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git push -q origin main && echo "pushed $(date '+%H:%M')"
else echo "no change $(date '+%H:%M')"; fi
