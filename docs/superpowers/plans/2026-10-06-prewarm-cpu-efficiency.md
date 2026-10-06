# Historical indicator CPU efficiency

## Goal and constraints

Reduce repeated work in historical peak/depth prewarming while preserving
indicator results and foreground performance. Do not impose new thread limits,
fixed sleep intervals, or computation timeouts. Work in the isolated checkout;
the user's live server must remain running.

## Evidence

The 2026-10-06 daily pass scanned 15,666 Stock-Dates, warmed 2,000, skipped
13,245, and reported 420 failures in 2,245 seconds. Sampled warm checks parsed
1.65–1.71 MB each; sampled peak computations made 158 Polars collect calls.
See `docs/diagnostics/2026-10-06-cpu-heat/diagnosis.json` for scope and limitations.

## Execution plan

1. Classify the reported failures using read-only metadata and logs. Audit
   existing single-flight protection before adding another synchronization layer.
2. Make unchanged cache checks cheap, retaining source-generation, schema-version,
   corruption and deletion invalidation. Legacy cache files must remain readable.
3. Reduce repeated peak-frame operations. Compare complete outputs against the
   original implementation, including tie ordering, empty frames and coarse bars.
4. Evaluate changed-data scheduling and cross-process deduplication using the
   findings. Preserve recovery after missed events, original daily priorities,
   retries for transient failures, and generation changes. Introduce these only
   where the measured benefit justifies the extra state and failure modes.
5. Run targeted correctness tests, isolated before/after measurements, Ruff and
   the required non-wallclock backend suite. Record implemented changes, measured
   benefit, and any deferred architecture work explicitly.

## Acceptance

No changed indicator values. Unchanged warm checks must avoid decoding large
payloads after validation. Changed/deleted/corrupt caches must fall back to normal
validation or recomputation. Report CPU time and wall time separately; do not
infer electrical savings or laptop temperature improvement from CPU time alone.

## Findings and implementation

- Failure classification complete: current metadata reproduces exactly 420
  exclusions in the original candidate prefix: 412 invalid session boundaries
  (sample: close time is zero), 8 archived cumulative-volume monotonicity errors.
  These already exit before peak/depth computation. Do not hide them with a
  retry blacklist or manufacture replacement metadata.
- Added persistent validation receipts for peak/depth cache completeness. The
  receipt binds schema versions, source capture generation and all three cache
  files' device/inode/size/mtime/ctime. Missing or changed receipts use the full
  existing model validators; unchanged ones avoid large JSON/model allocations.
  A read-only dry run does not write receipts. Receipt write errors are nonfatal.
- Combined filter/sort/dedup pipelines into lazy Polars plans. Kept classification
  and record-sequence logic unchanged. No schema bump or cache purge is needed.
- Existing code already computes only missing/stale results. An event queue
  would mainly replace discovery, not eliminate the 2,000 genuinely cold items.
  Deferred that additional persistent state until post-deployment profiling shows
  filesystem discovery remains material after receipt adoption.
- Same-process single-flight already exists. Cross-process sharing and foreground
  priority require a shared job owner with cancellation/recovery semantics; their
  benefit is not established by this incident. Deferred them, along with dedicated
  process lifecycle changes, rather than introducing locks on foreground requests.

## Measurements (isolated samples, not deployed laptop telemetry)

Three historical Stock-Dates, four interleaved repetitions; Polars retains 32
threads for both variants, DuckDB uses four in this diagnostic process only.
The calculation comparison supplies identical SQL-produced frames to both
variants. This avoids existing unspecified same-timestamp input ordering; all
peak output fields match and representative-row multisets match. All 96 tested
3m/5m/60m/240m derived outputs also match.

| Operation | Before | After | Scope |
|---|---:|---:|---|
| Warm-check CPU | 1,419 ms | 16 ms | 90 checks, receipts already validated |
| Warm-check elapsed | 1,418 ms | 16 ms | Same checks, cold in-memory models |
| Peak transform CPU | 16,378 ms | 15,847 ms | 12 computations; excludes SQL scans |
| Peak transform elapsed | 1,728 ms | 1,612 ms | Same computations |
| Polars collect calls | 156 | 86 | Per transform; excludes two SQL conversions |

Warm-check CPU reduction is ~98.9%. Peak transform CPU reduction is only ~3.2%
(elapsed ~6.7%) and should not be generalized beyond these samples. Receipts
require a one-time full validation/write for existing files; that migration cost
is excluded from the repeated warm-check numbers. There is no new thread cap,
fixed pause, timeout, or user-request admission policy.

Artifacts: `failure-analysis.json`, `optimization-comparison.json`, and
`compare_optimization.py` under `docs/diagnostics/2026-10-06-cpu-heat/`.

## Validation status

- Cache receipt tests cover deletion, corrupt JSON, invalid envelope/model,
  version changes, same-mtime recapture, concurrent replacement, write failure,
  cross-instance reuse and read-only dry run.
- Full non-wallclock backend suite: 5,417 passed, 2 skipped, 13 deselected.
  Final dry-run safeguard and receipt/prewarm tests: 29 passed after the last edit.
  Earlier peak/oracle checks: 245 passed, 1 skipped; cache checks: 106 passed.
- Ruff and diff whitespace checks pass.
- The user's main checkout and live server have not been modified. Consequently
  actual API latency, daily-run completion time and laptop temperature after
  deployment have not yet been measured.
