#!/usr/bin/env bash
set -euo pipefail
diagnostic_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$diagnostic_dir/../../.." && pwd)"
cd "$repo_dir/frontend"
diagnostic_test="$(mktemp "$PWD/src/live/update-depth-diagnostic-XXXXXX.test.tsx")"
trap 'rm -f "$diagnostic_test"' EXIT
cp "$diagnostic_dir/repro.tsx" "$diagnostic_test"
DIAG_MODE="${1:-sync}" ./node_modules/.bin/vitest run "$diagnostic_test"
