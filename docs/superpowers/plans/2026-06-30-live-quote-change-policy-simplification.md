# Live Quote Change Policy Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live quote change-rate display deterministic: if an adjusted daily baseline exists, compute display change from that baseline and ignore KIS change-rate mismatch heuristics.

**Architecture:** Keep the policy inside `QuoteChangeResolver`, the existing single backend merge point used by heatmap, watchlist, and screener via `/api/live/quotes`. Do not add new wire fields, diagnostics, or UI behavior. Preserve fallback to KIS only when no usable adjusted baseline exists.

**Tech Stack:** Python 3.11+, FastAPI/Pydantic, DuckDB-backed adjusted daily parquet, pytest via `uv run --extra dev python -m pytest`.

## Global Constraints

- No new API fields.
- No new frontend UI.
- No threshold-based display decision when an adjusted baseline exists.
- Keep `pre_open` behavior unchanged: hide change fields.
- Keep KIS fallback only for missing/unusable adjusted baseline.

---

### Task 1: Lock The Display Policy With Failing Tests

**Files:**
- Modify: `tests/unit/live/test_quote_change_resolver.py`
- Modify: `tests/unit/live/test_live_quotes_route.py`

**Interfaces:**
- Consumes: `QuoteChangeResolver.resolve_quote(q: KisQuote, *, phase: str) -> QuoteChangeResolution`
- Produces: Test coverage proving `warnings == []` for both small and large KIS mismatch when adjusted baseline exists.

- [x] **Step 1: Change resolver tests to require no KIS mismatch warnings**

```python
def test_uses_adjusted_baseline_when_kis_change_rate_disagrees(tmp_path):
    ...
    assert out.change_pct == -21.75
    assert out.change_pct_source == "adjusted_daily"
    assert out.warnings == []

def test_recomputes_change_rate_from_adjusted_baseline_even_when_kis_diff_is_small(tmp_path):
    ...
    assert out.change_pct == 5.0
    assert out.change_pct_source == "adjusted_daily"
    assert out.warnings == []
```

- [x] **Step 2: Change route tests to require no KIS mismatch warnings**

```python
def test_quotes_recomputes_change_pct_when_kis_uses_unadjusted_baseline(monkeypatch, tmp_path):
    ...
    assert q0["change_pct"] == -21.75
    assert q0["change_pct_source"] == "adjusted_daily"
    assert q0["warnings"] == []

def test_quotes_recomputes_small_stale_kis_change_pct(monkeypatch, tmp_path):
    ...
    assert q0["change_pct"] == 5.0
    assert q0["change_pct_source"] == "adjusted_daily"
    assert q0["warnings"] == []
```

- [x] **Step 3: Run tests to verify RED**

Run: `uv run --extra dev python -m pytest tests/unit/live/test_quote_change_resolver.py tests/unit/live/test_live_quotes_route.py -q`

Expected: FAIL because the current implementation still emits `kis_change_pct_rejected` or `kis_change_pct_recomputed`.

### Task 2: Simplify QuoteChangeResolver

**Files:**
- Modify: `hoga/live/quote_change_resolver.py`
- Modify: `frontend/src/api/liveQuotes.ts`

**Interfaces:**
- Consumes: `_adjusted_change_pct(q: KisQuote, baseline: _Baseline | None) -> float | None`
- Produces: `resolve_quote` returns `change_pct_source="adjusted_daily"` with empty warnings whenever baseline calculation succeeds.

- [x] **Step 1: Remove threshold constants and helper**

Delete `_REJECT_DIFF_PCT_POINTS`, `_EXTREME_KIS_ABS_PCT`, and `_should_reject_kis`.

- [x] **Step 2: Make adjusted baseline the unconditional display source**

```python
adjusted_pct = self._adjusted_change_pct(q, baseline)
if baseline is not None and adjusted_pct is not None:
    return QuoteChangeResolution(
        code=q.code,
        price=q.price,
        change_pct=adjusted_pct,
        change_won=round(q.price - baseline.close),
        baseline_price=baseline.close,
        baseline_date=baseline.date,
        change_pct_source="adjusted_daily",
        warnings=warnings,
    )
```

- [x] **Step 3: Remove recomputed warning mention from frontend type comment**

```ts
/** quote validation warnings such as adjusted_baseline_unavailable. */
warnings?: string[];
```

- [x] **Step 4: Run tests to verify GREEN**

Run: `uv run --extra dev python -m pytest tests/unit/live/test_quote_change_resolver.py tests/unit/live/test_live_quotes_route.py -q`

Expected: PASS.

### Task 3: Final Verification And Commit

**Files:**
- Modify: `docs/superpowers/plans/2026-06-30-live-quote-change-policy-simplification.md`
- Modify: `hoga/live/quote_change_resolver.py`
- Modify: `tests/unit/live/test_quote_change_resolver.py`
- Modify: `tests/unit/live/test_live_quotes_route.py`
- Modify: `frontend/src/api/liveQuotes.ts`

**Interfaces:**
- Produces: A small committed unit with deterministic live quote display policy.

- [x] **Step 1: Run diff hygiene**

Run: `git diff --check`

Expected: no output.

- [x] **Step 2: Commit the verified unit**

```bash
git add docs/superpowers/plans/2026-06-30-live-quote-change-policy-simplification.md \
  hoga/live/quote_change_resolver.py \
  tests/unit/live/test_quote_change_resolver.py \
  tests/unit/live/test_live_quotes_route.py \
  frontend/src/api/liveQuotes.ts
git commit -m "WIP: simplify live quote change policy"
```
