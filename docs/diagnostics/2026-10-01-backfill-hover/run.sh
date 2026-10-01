#!/usr/bin/env bash
set -euo pipefail
EVIDENCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$EVIDENCE_DIR/../../.." && pwd)"
cd "$REPO_DIR"
exec 9>/tmp/hoga-backfill-perf.lock
flock -n 9 || { echo 'Another backfill diagnostic is running.' >&2; exit 1; }
FILES=(frontend/backfill-build.config.ts frontend/backfill-perf-entry.ts frontend/backfill-perf.config.ts frontend/tests/e2e/backfill-perf.spec.ts)
for path in "${FILES[@]}"; do
  [[ ! -e "$path" ]] || { echo "Refusing to overwrite $path" >&2; exit 1; }
done
export BF_OUTPUT="${BF_OUTPUT:-rerun}"
[[ ! -e "$EVIDENCE_DIR/$BF_OUTPUT.json" ]] || { echo 'Choose a fresh BF_OUTPUT.' >&2; exit 1; }
cleanup() { for path in "${FILES[@]}"; do rm -f -- "$REPO_DIR/$path"; done; }
trap cleanup EXIT
for path in "${FILES[@]}"; do cp "$EVIDENCE_DIR/$(basename "$path").txt" "$path"; done
cd frontend
./node_modules/.bin/vite build --config backfill-build.config.ts
./node_modules/.bin/playwright test --config backfill-perf.config.ts
