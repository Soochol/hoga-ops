#!/usr/bin/env bash
# Recreate the isolated diagnostic harness; never change product source.
set -euo pipefail
EVIDENCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$EVIDENCE_DIR/../../.." && pwd)"
cd "$REPO_DIR"
# Build output and port are deliberately shared by these serial diagnostic runs.
exec 9>/tmp/hoga-hover-perf.lock
flock -n 9 || { echo 'Another hover diagnostic is running.' >&2; exit 1; }
FILES=(frontend/hover-perf.config.ts frontend/hover-build.config.ts frontend/hover-perf-entry.ts frontend/tests/e2e/hover-perf.spec.ts)
for path in "${FILES[@]}"; do
  [[ ! -e "$path" ]] || { echo "Refusing to overwrite $path" >&2; exit 1; }
done
cleanup() { for path in "${FILES[@]}"; do rm -f -- "$REPO_DIR/$path"; done; }
trap cleanup EXIT
for path in "${FILES[@]}"; do cp "$EVIDENCE_DIR/$(basename "$path").txt" "$path"; done
cd frontend
# Install dependencies beforehand with npm ci if this checkout has none.
npx vite build --config hover-build.config.ts
HOVER_PROD=1 HOVER_OUTPUT="${HOVER_OUTPUT:-rerun}" npx playwright test --config hover-perf.config.ts
cd "$REPO_DIR"
python3 "$EVIDENCE_DIR/summarize.py" "$EVIDENCE_DIR/${HOVER_OUTPUT:-rerun}.json" > "$EVIDENCE_DIR/${HOVER_OUTPUT:-rerun}-summary.json"
