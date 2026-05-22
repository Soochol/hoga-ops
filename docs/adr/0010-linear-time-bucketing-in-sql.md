# 0010 — Bucket series-builder SQL on linear ms-from-midnight, never on raw HHMMSSmmm

**Status:** Accepted (2026-05-22)
**Related:** ADR-0003 (`Api*` exposes Unix epoch ms; Parquet keeps native HHMMSSmmm)

## Context

`/api/session` returns several time-series slices that the frontend feeds into
`lightweight-charts` via `setData`. The library enforces a hard contract:

> Data must be **strictly ascending and unique** by time. Violations throw
> `Assertion failed: data must be asc ordered by time, index=N, time=A, prev time=B`,
> which propagates synchronously through React render and unmounts the
> entire subtree (was previously crashing the whole replay viewer until
> the `ChartErrorBoundary` landed).

The three series builders in `hoga/api/bundle.py`
(`build_quote_ratio_slice`, `build_depth_intensity_slice`,
`build_fill_strength_slice`) all bucket trades / snapshots by time. Their
original SQL pattern was:

```sql
(ts_ms / {bucket_ms})::BIGINT * {bucket_ms}  AS bucket
```

…where `ts_ms` is hogaplay's native HHMMSSmmm packed-decimal time.

This pattern produces wrong outputs for two independent reasons.

### Failure mode 1 — DuckDB `/` is float, `::BIGINT` rounds half-to-even

`INTEGER / INTEGER` in DuckDB returns `DOUBLE`. `::BIGINT` then rounds, not
truncates. For `bucket_ms = 1000`:

* `ts_ms = 85_059_500` (`08:50:59.500` KST) → `85_059.5` → `85_060`
* `bucket * 1000 = 85_060_000` = HHMMSSmmm `"08:50:60.000"` — **invalid**
  (seconds field overflows 59)
* `hhmmssms_to_unix_ms` does no validation; it adds
  `(h*3600 + m*60 + s) * 1000 + ms` directly, so seconds=60 folds into
  the next minute. Result: `08:51:00.000` KST — **colliding with the next
  valid bucket**.

Observed in the 003490 / 2026-05-11 fixture: 178 duplicate Unix-ms outputs
in `quote_ratio.points` (~0.85% of 20,326 points), all at minute boundaries.

### Failure mode 2 — `bucket * bucket_ms` is not aligned for `bucket_ms >= 60_000`

HHMMSSmmm has **gaps**: the integer values `xx_x60_000` through `xx_x99_999`
are not valid times (seconds field). For `bucket_ms = 60_000`:

* `ts_ms = 110_059_000` (`11:00:59.000` KST) → `1834.317` → `1834`
* `bucket * 60_000 = 110_040_000` = HHMMSSmmm `"11:00:40.000"`
* `hhmmssms_to_unix_ms` decodes that into `11:00:40 KST` — **40 seconds
  earlier than the source data**.

For larger raw `ts_ms` values whose bucket happens to multiply to a value
with overflowing minutes field (e.g. `1900 * 60_000 = 114_000_000` →
`"11:40:00.000"`, fine), the next bucket `1834 * 60_000 = 110_040_000`
decodes as `"11:00:40"` — a **39-minute backward jump in output time**
relative to its predecessor. Observed in the same fixture: 4 backward
jumps of up to 39 minutes in `fill_strength.points`.

## Decision

Series builders **MUST**:

1. **Decode HHMMSSmmm to linear ms-from-midnight FIRST**, using the helper
   `hhmmssms_to_intra_ms_sql(col)` from `hoga/api/timeenc.py`. The helper
   expands a single column reference to a SQL expression that uses
   integer division (`//`) and modulo to extract `h`, `m`, `s`, `ms` and
   reassemble as linear ms.

2. **Bucket on the linear axis** using DuckDB's integer-division operator
   `//` (NOT `/`, which returns DOUBLE):

   ```sql
   (intra_ms // {bucket_ms}) * {bucket_ms}  AS bucket_intra_ms
   ```

3. **Convert the bucket back to Unix ms via
   `ms_from_midnight_to_unix_ms(date, bucket_intra_ms)`** in Python, NOT
   via `hhmmssms_to_unix_ms`. The bucket key is already linear.

This guarantees strictly-ascending unique outputs for any positive
`bucket_ms`, with no special-case branches per bucket size.

## Consequences

**Wins:**

* `quote_ratio`, `fill_strength`, `depth_intensity` all emit
  lightweight-charts-compliant series. The 178/4/N defects observed in
  the 003490 fixture are zero after the fix.
* One pattern, one helper. `build_volume_profile_slice` already used
  `FLOOR(... / bin_width)::BIGINT` correctly; it doesn't need the time
  helper because it buckets price, not time.

**Costs:**

* Each affected query gets a CTE / nested expression. Negligible
  DuckDB overhead — the same fixture runs in <2 ms after the change.
* `hhmmssms_to_unix_ms` remains in `timeenc.py` for the rare cases that
  need the full HHMMSSmmm → Unix decode (e.g. emitting a candle's exact
  `ts_ms` rather than a bucket alignment). Per ADR-0003, the goal is
  still to expose Unix epoch ms at the API boundary.

**Frontend implication:**

* The `sortAndDedupeByTime` helper added to `frontend/src/util/time.ts`
  during the initial discovery is no longer called by any chart pane.
  It remains exported and tested as defense-in-depth — if a future
  backend regression reintroduces duplicates or out-of-order points,
  rewrap the affected pane's `setData` input in a single line.

## Alternatives considered

* **Frontend sort+dedupe only.** Hides the backend bug from anyone who
  consumes `/api/session` from a non-frontend client (CLI, notebooks,
  third parties). Rejected.

* **`FLOOR(ts_ms / N)::BIGINT` without the linear decode.** Fixes the
  `bucket_ms = 1000` case (no minute-boundary dups) but **does not** fix
  `bucket_ms = 60_000` — the bucket × N output is still in HHMMSSmmm
  space and still overflows seconds field. Rejected as half-measure.

* **Store linear ms in Parquet.** Would obviate the SQL helper entirely
  but rewrites every captured Stock-Date file. Too invasive for a fix
  that is contained to three SQL queries. Revisit if more builders are
  added.
