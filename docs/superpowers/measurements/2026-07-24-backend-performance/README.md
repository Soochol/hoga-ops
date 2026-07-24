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

To run this matrix later, the operator must provide an isolated developer fixture
and configure all of the following:

```bash
export HOGA_BENCH_DATA_DIR=/path/to/isolated/developer-fixture
export HOGA_BENCH_CODE=<fixture-code>
export HOGA_BENCH_FROM_5=<YYYYMMDD>
export HOGA_BENCH_FROM_20=<YYYYMMDD>
export HOGA_BENCH_FROM_60=<YYYYMMDD>
export HOGA_BENCH_TO=<YYYYMMDD>

test -n "$HOGA_BENCH_DATA_DIR"
test -d "$HOGA_BENCH_DATA_DIR"
test -n "$HOGA_BENCH_CODE"
test -n "$HOGA_BENCH_FROM_5"
test -n "$HOGA_BENCH_FROM_20"
test -n "$HOGA_BENCH_FROM_60"
test -n "$HOGA_BENCH_TO"
```

After replacing the placeholders with fixed fixture values, record those values
here and run:

```bash
for window in \
  "5d:$HOGA_BENCH_FROM_5:$HOGA_BENCH_TO" \
  "20d:$HOGA_BENCH_FROM_20:$HOGA_BENCH_TO" \
  "60d:$HOGA_BENCH_FROM_60:$HOGA_BENCH_TO"
do
  IFS=: read -r label from_date to_date <<EOF
$window
EOF
  uv run python tools/profile_live_range.py \
    --data-dir "$HOGA_BENCH_DATA_DIR" \
    --code "$HOGA_BENCH_CODE" \
    --from "$from_date" \
    --to "$to_date" \
    --bucket-ms 60000 \
    --mode hoga \
    --mode sidecar \
    --mode candles \
    --repeat 3 \
    --label-prefix "$label"
done > docs/superpowers/measurements/2026-07-24-backend-performance/range.jsonl
```

## LiveBuffer measurements

The deterministic synthetic matrix uses generated `SYNnnnnn` codes only. It does
not read files, open a WebSocket, or access KIS.

```bash
for codes in 1 50 200 800; do
  uv run python tools/bench_live_buffer.py \
    --codes "$codes" \
    --ticks-per-code 1000 \
    --levels 10 \
    --retention-ms 1000000000
done > docs/superpowers/measurements/2026-07-24-backend-performance/live-buffer.jsonl
```

The 800-code case is conditional on the documented resource guard: first measure
the 1-, 50-, and 200-code cases, inspect currently available memory, and skip the
800-code case if its projected peak memory is more than 25% of that available
memory.

### Resource guard and results

The first three cases were run as separate processes. Immediately before deciding
whether to run 800 codes, `/proc/meminfo` reported `69349429248` bytes available,
making the 25% guard `17337357312` bytes.

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

The approved test command completed with `35 passed in 0.12s`.
