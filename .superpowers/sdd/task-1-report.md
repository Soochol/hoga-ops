Status: DONE

What I implemented:
- Added `hoga/live/quote_change_resolver.py` with `QuoteChangeResolver`, `QuoteChangeResolution`, `ChangePctSource`, and adjusted-daily baseline loading.
- Resolver validates KIS `change_pct` against the most recent positive adjusted daily close for the quote code.
- Resolver rejects materially mismatched KIS rates and returns the adjusted-daily rate with `kis_change_pct_rejected`.
- Resolver accepts matching KIS rates while still exposing baseline metadata.
- Resolver hides change fields during `pre_open`.
- Resolver falls back to KIS when the adjusted file is missing without warning.
- Resolver falls back to KIS with `adjusted_baseline_unavailable` when an adjusted file exists but no valid positive baseline is available, matching the clarified task expectation.
- Added the verbatim unit tests from the task brief in `tests/unit/live/test_quote_change_resolver.py`.

Tests and results:
- `uv run pytest tests/unit/live/test_quote_change_resolver.py -v`
- Result: PASS, 5 passed in 0.12s.

RED evidence:
- After adding only the test file, `uv run pytest tests/unit/live/test_quote_change_resolver.py -v` initially failed before collection because the local uv environment did not yet include pytest.
- Reran with dev dependencies: `uv run --extra dev python -m pytest tests/unit/live/test_quote_change_resolver.py -v`.
- Expected RED result: collection error with `ModuleNotFoundError: No module named 'hoga.live.quote_change_resolver'`.

GREEN evidence:
- After implementing the resolver, `uv run --extra dev python -m pytest tests/unit/live/test_quote_change_resolver.py -v` passed: 5 passed in 0.15s.
- After dev dependencies were installed, the exact brief command `uv run pytest tests/unit/live/test_quote_change_resolver.py -v` passed: 5 passed in 0.12s.

Files changed:
- `hoga/live/quote_change_resolver.py`
- `tests/unit/live/test_quote_change_resolver.py`
- `.superpowers/sdd/task-1-report.md`

Self-review:
- Scope of product/test implementation stayed within the requested resolver and unit test files.
- The untracked plan file under `docs/superpowers/plans/` was not modified or staged.
- Baseline cache stores successful and unavailable lookups per code to avoid repeated DuckDB reads.
- Missing adjusted file and invalid adjusted baseline are intentionally distinguished to satisfy the warning contract.
- Pre-open output includes baseline metadata when available but suppresses change fields and KIS warnings.

Concerns:
- The focused test command required dev dependencies in this fresh uv environment before the exact brief command could run.
- Missing code rows in an existing adjusted file currently produce the same `adjusted_baseline_unavailable` warning as invalid zero-close baselines.
