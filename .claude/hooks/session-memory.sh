#!/bin/bash
# SessionStart: sessions do not remember each other, so hand the next one
# what this one paid for. Everything printed here lands in the session's
# context before the first prompt. Keep it SHORT - a digest and a pointer,
# not the whole file. Runs synchronously and must stay instant: no network,
# no installs, no test runs.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

echo "=== EZ Clock In - carried over from previous sessions ==="
echo
echo "Where the work is:"
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
echo "  branch $branch, $(git rev-list --count HEAD ^main 2>/dev/null || echo '?') commits not on main"
echo "  last:   $(git log -1 --pretty='%s (%ad)' --date=short 2>/dev/null)"
echo
echo "docs/lessons.md is the log of bugs this app has ALREADY had, with the"
echo "cause and the rule that came out of each. Read the relevant entry"
echo "before changing an area, and add one (plus a test) after fixing a bug."
echo "Its recurring failure shapes:"
echo
sed -n '/^## Failure shapes/,/^---/p' docs/lessons.md 2>/dev/null \
  | sed '1,3d;/^---/d;/^$/d;s/\*\*//g;s/`//g' | sed 's/^/  /'
echo
echo "Entries on file (open docs/lessons.md for the detail):"
awk '/^## Entries/,0' docs/lessons.md 2>/dev/null \
  | grep -oE '^\*\*[^*]+\*\*' | sed 's/\*\*//g;s/`//g;s/^/  - /'
echo
echo "=== end ==="
