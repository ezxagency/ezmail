#!/bin/bash
# SessionStart: install the test dependencies in the background.
# Sessions start from a fresh clone, and `tests/` is the only place with
# dependencies - without this, the first `npm test` of a session waits.
set -euo pipefail

echo '{"async": true, "asyncTimeout": 300000}'

cd "${CLAUDE_PROJECT_DIR:-.}/tests" || exit 0
npm install --silent --no-audit --no-fund >/dev/null 2>&1 || true
