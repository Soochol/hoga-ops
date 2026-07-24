# Backend Performance Baseline

- Never point `HOGA_BENCH_DATA_DIR` at production or user data.
- Range measurements require an isolated developer fixture.
- KIS measurements are disabled until the operator explicitly approves use of a
  development account.
- Record commit SHA, Python version, DuckDB version, CPU count, total memory, and
  configured KIS account count with every result.

## Scope and shared environment

The metadata below applies to every result in this directory.

| Field | Value |
|---|---|
| Measurement date | 2026-07-24 |
| Commit SHA | `29be81ab147a22712ad9e1dd4080c01a75bf8236` |
| Python | `3.14.4` |
| DuckDB | `1.5.2` |
| uv | `0.11.8` |
| OS/runtime | `Linux 7.0.0-28-generic x86_64` |
| CPU count | `32` |
| Total memory | `98581237760` bytes |
| Configured KIS account count | `NOT_ACCESSED_UNAPPROVED` |

The KIS account count is intentionally non-numeric: external KIS measurement was
not approved, so credentials and credential-bearing configuration were not
accessed. No KIS request was made.

Environment commands, run from the repository root:

```bash
git rev-parse HEAD
uv run python --version
uv run python -c 'import duckdb; print(duckdb.__version__)'
uv run python -c 'import os; print(os.cpu_count())'
uv --version
uname -srm
awk '/MemTotal:/ {print $2 * 1024}' /proc/meminfo
```

## Range matrix: `NEEDS_ISOLATED_FIXTURE`

No `HOGA_BENCH_*` fixture variables were configured, and no isolated fixture was
available. No repository-default, production, or user data was inspected. No
representative code or date values were invented.

To run this matrix later, the operator must provide a declared immutable,
isolated developer source fixture and configure all of the following:

```bash
export HOGA_BENCH_SOURCE_FIXTURE=/path/to/immutable/isolated/developer-fixture
export HOGA_BENCH_CODE=<fixture-code>
export HOGA_BENCH_FROM_5=<YYYYMMDD>
export HOGA_BENCH_FROM_20=<YYYYMMDD>
export HOGA_BENCH_FROM_60=<YYYYMMDD>
export HOGA_BENCH_TO=<YYYYMMDD>

test -n "$HOGA_BENCH_SOURCE_FIXTURE"
test -d "$HOGA_BENCH_SOURCE_FIXTURE"
test -n "$HOGA_BENCH_CODE"
test -n "$HOGA_BENCH_FROM_5"
test -n "$HOGA_BENCH_FROM_20"
test -n "$HOGA_BENCH_FROM_60"
test -n "$HOGA_BENCH_TO"
```

After replacing the placeholders with fixed fixture values, record those values
here and run the tested orchestrator:

```bash
set -eu
measurement_dir=docs/superpowers/measurements/2026-07-24-backend-performance
range_rerun_jsonl="$measurement_dir/range-rerun.jsonl"

uv run python tools/run_range_measurements.py run \
  --source-fixture "$HOGA_BENCH_SOURCE_FIXTURE" \
  --code "$HOGA_BENCH_CODE" \
  --window "5d:$HOGA_BENCH_FROM_5:$HOGA_BENCH_TO" \
  --window "20d:$HOGA_BENCH_FROM_20:$HOGA_BENCH_TO" \
  --window "60d:$HOGA_BENCH_FROM_60:$HOGA_BENCH_TO" \
  --request-manifest "$measurement_dir/manifests/frontend-default-sidecar.json" \
  --request-manifest \
    "$measurement_dir/manifests/volume-distribution-enabled-sidecar.json" \
  --cold-trials 3 \
  --warm-trials 0 \
  > "$range_rerun_jsonl"
```

The orchestrator never writes into or clears the declared source. Every
profiler, identity-endpoint, and gzip-endpoint evidence leg gets its own
`cp --reflink=always` clone and fresh Python child; unsupported copy-on-write
cloning and source fixtures containing symlinks fail closed instead of making
a full copy or preserving an escape path. Those three independently cold legs
share one stable `trial_group` in the joined JSONL result. Each row records a
path-free source identity, clone-initial indicator-cache state, the uncontrolled
OS-cache state, `trial_kind`, window, configuration, child exit statuses,
semantic evidence issues, gate eligibility, and commit SHA. `cold` and optional
`warm` labels are distinct, and warm or evidence-invalid rows are never inputs
to the three-cold-run gate.

Endpoint legs mount only the actual `/api/range` router, `RangeBundle` response
model, and production `GZipMiddleware`; they do not enter the production
lifespan or construct external clients/background services. Results include
TTFB, end-of-body time, status, raw/wire/gzip bytes, content encoding, response
validation, and body-frame count. The separately isolated direct-profiler leg
retains slice attribution and is joined by `trial_group`. All three legs replace
the KIS-backed holiday lookup with the recorded
`fixture-weekday-lenient-v1` policy: weekends are excluded locally and weekday
partitions declared by the fixture are accepted without credentials or network
access.

The committed manifests are the measurement contract:

- `frontend-default-sidecar.json` pins the current factory-default sidecar
  toggles (off), bin fields, broker threshold, source preference, mode, and
  explicit nullable price range.
- `volume-distribution-enabled-sidecar.json` changes the distribution bin count
  to 10 so the enabled user path and `build_volume_distribution_slice` execute.
  Its null price-range pair means the builder derives the range from fixture
  candles, matching the frontend path before a runtime range is available.

Every field that can alter `build_range_bundle` sidecar work is required;
unknown/missing fields and invalid bounds are rejected. Future frontend
request-shape or factory-default changes require updating these representative
manifests before collecting new evidence.

## LiveBuffer measurements

The deterministic synthetic matrix uses generated `SYNnnnnn` codes only. It does
not read files, open a WebSocket, or access KIS.

```bash
set -eu
measurement_dir=docs/superpowers/measurements/2026-07-24-backend-performance
live_buffer_rerun_jsonl="$measurement_dir/live-buffer-rerun.jsonl"
mkdir -p "$measurement_dir"

uv run python tools/run_live_buffer_scales.py \
  --scale 1 \
  --scale 50 \
  --scale 200 \
  --scale 800 \
  --ticks-per-code 1000 \
  --levels 10 \
  --retention-ms 1000000000 \
  > "$live_buffer_rerun_jsonl"
```

Before every scale, the runner recomputes usable headroom as the smaller of host
`MemAvailable` and finite cgroup v2 remaining memory
(`memory.max - memory.current`), with cgroup v1 memory limit/usage as a safe
fallback. Completed smaller samples project the next peak conservatively from
the highest observed per-code peak. A candidate above 25% of current usable
headroom is never launched.

Every accepted case runs in a fresh child with a verified `RLIMIT_AS` derived
from that same guard. If the limit cannot be established, or at the first
rejected projection, the runner emits one valid `SKIPPED_RESOURCE_GUARD` row
with scale, host/cgroup headroom, projection, guard/child limit, and deferred
command, then considers no larger scale. The initial one-code bootstrap has no
smaller sample, so its projection is explicitly null and it can run only under
the verified child limit.

### Resource guard and results

The committed historical rows below are preserved exactly. They predate the
every-scale runner: the first three cases were separate processes, but the
earlier guard was evaluated only before 800. Immediately before that historical
800 decision, `/proc/meminfo` reported `69349429248` bytes available, making the
25% guard `17337357312` bytes.

The projection used the observed 50-to-200-code peak-RSS slope:

```text
projected_800_max_rss_bytes
  = rss_200 + ((800 - 200) / (200 - 50)) * (rss_200 - rss_50)
  = 3277889536 + 4 * (3277889536 - 835854336)
  = 13046030336
```

The projection was `18.8120%` of available memory, below the 25% guard, so the
800-code case was permitted. It completed with `13046259712` peak RSS bytes.

| Codes | Entries | Elapsed ms | Publishes/s | tracemalloc peak bytes | Peak RSS bytes |
|---:|---:|---:|---:|---:|---:|
| 1 | 1000 | 34.397 | 29072.678 | 5741252 | 39092224 |
| 50 | 50000 | 2261.084 | 22113.291 | 286872949 | 835854336 |
| 200 | 200000 | 9339.668 | 21414.038 | 1147485819 | 3277889536 |
| 800 | 800000 | 37932.852 | 21089.898 | 4589936851 | 13046259712 |

All four cases reported `published_total == high_water_entries == entries` and
`subscriber_drops == 0`. These are standalone deterministic synthetic results,
not a substitute for the missing 20-minute real-mix plateau and event-loop-lag
measurements.

The 20-minute real-mix soak is `NEEDS_RECORDED_TICK_FIXTURE`. No recorded real
tick fixture exists, and a production WebSocket must not be used.

## Past-candle measurements

Only the unit/mock tests are approved:

```bash
uv run --extra dev pytest \
  tests/unit/live/test_live_candle_backfill.py \
  tests/unit/live/test_kis_capacity_scheduler.py \
  tests/unit/live/test_kis_runtime_accounts.py \
  -q
```

The 10 cold and 10 warm external measurements are
`NEEDS_APPROVED_EXTERNAL_MEASUREMENT`. A future run requires explicit operator
approval for a development KIS account and a fresh isolated development process.
It must record only duration, candle count, configured account count, scheduler
queue wait, and `fresh_past_fetches`; it must not record bodies or credentials.

### Unit/mock result

The approved test command completed with `35 passed in 0.12s`.

## Final verification

Commit under test: `2e4cc284e308d7b4369b1250673ef9eca1b5b191`.

Commands and results:

```bash
uv run --extra dev pytest \
  tests/tools/test_profile_live_range.py \
  tests/tools/test_bench_live_buffer.py \
  tests/unit/api/test_request_timing.py \
  tests/unit/live/test_buffer.py \
  tests/unit/live/test_api.py \
  tests/unit/live/test_live_candle_backfill.py \
  tests/api/test_screener_scan.py \
  tests/test_api_stock_dates_cache.py \
  tests/test_api_captures_queue.py \
  -q
# 269 passed, 1 warning

uv run --extra dev pytest -q
# 2705 passed, 2 skipped, 9 warnings

uv run --extra dev ruff check \
  tools/profile_live_range.py \
  tools/bench_live_buffer.py \
  tests/tools/test_profile_live_range.py \
  tests/tools/test_bench_live_buffer.py \
  hoga/api/request_timing.py \
  hoga/live/buffer.py \
  tests/unit/api/test_request_timing.py \
  tests/unit/live/test_buffer.py \
  tests/unit/live/test_api.py
# All checks passed!
```

No structural `GO` is supported and no structural follow-up plan is approved.
The three core gates remain pending approved KIS measurement, a recorded tick
fixture, and an isolated range fixture. The three medium-priority gates remain
pending isolated screener and inventory fixtures and a recorded normal capture
session. The raw results reconcile with the reported values, all measurement
JSONL files parse, and the repository and artifact scans found no temporary
benchmark files, credential-bearing content, or host-specific absolute paths in
raw artifacts.

Known warnings are eight Polars sortedness warnings from
`hoga/api/screener_factors.py` in the full suite and one Python 3.16-targeted
`asyncio.iscoroutinefunction` deprecation warning from
`tests/test_api_captures_queue.py`; the latter also appears in the targeted
suite.
