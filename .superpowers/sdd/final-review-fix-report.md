# Final Review Fix Report

## Changes

- Scoped `QuoteChangeResolver` baseline cache entries to the adjusted daily parquet file state using `mtime_ns` and `size`.
- Cleared the baseline cache when the adjusted daily file changes, and avoided caching absent baselines while the file is missing.
- Closed the DuckDB baseline reader with a context manager.
- Added a resolver regression proving startup-before-file-creation recovers once `daily_adjusted.parquet` appears.
- Added a route regression proving closed-mode cached quotes still emit validated adjusted `change_pct` without an extra KIS call.

## Tests

- `uv run pytest tests/unit/live/test_quote_change_resolver.py tests/unit/live/test_live_quotes_route.py -v`
- Result: 21 passed.

## Self-Review

- Write scope stayed within the requested resolver, two unit test files, and this report.
- Existing dirty files and the untracked plan file were not reverted or edited.
- Cache invalidation is intentionally simple: missing file means no cached baseline state; present file caches by stat signature.
- Closed-mode route behavior re-runs quote resolution over cached `KisQuote` objects, preserving adjusted validation while avoiding another KIS fetch.

## Concerns

- The cache signature is based on filesystem stat metadata. If a writer replaced file contents while preserving both `mtime_ns` and size, the cache would not refresh, but normal parquet rewrites should update at least one of those fields.
