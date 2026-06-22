# Index Minute Source Units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve index minute chart candle depth by using the best supported KIS source unit for each display timeframe, while documenting and testing that KIS index minute data is not date-pageable like stock minute candles.

**Architecture:** Keep the existing single-call KIS index minute endpoint. Change only the source-unit selection so 5m uses KIS `300`, 15m uses KIS `300` and aggregates to 15m, 10m/30m keep KIS `600`, and 1m/3m keep KIS `60`. Add regression tests that prevent anyone from reintroducing unsupported date/time cursor assumptions.

**Tech Stack:** Python 3.14, FastAPI route already in `hoga/live/api.py`, existing `KisClient.fetch_index_minute_candles`, pytest, existing Node measurement script `scripts/measure_index_minute_fetch_depth.mjs`.

## Global Constraints

- TDD required: write failing pytest first, verify red, then implement minimal code.
- Do not add direct production calls to `openapi.koreainvestment.com`; keep all KIS access through `KisClient`.
- Do not claim index minute historical page-walk support unless KIS exposes a real date/cursor parameter.
- Preserve existing exact-range minute cache behavior.
- No frontend change is needed for this plan unless backend response shape changes, which it should not.

---

## File Structure

- Modify: `hoga/live/kis_client.py`
  - Responsibility: choose KIS source unit and aggregate returned index minute candles.
- Modify: `tests/unit/live/test_kis_client.py`
  - Responsibility: lock the KIS source-unit mapping and aggregation behavior.
- Modify: `docs/superpowers/plans/2026-06-23-index-minute-candle-cache.md`
  - Responsibility: append the verified limitation and follow-up source-unit improvement, if docs are kept current during implementation.
- Use existing: `scripts/measure_index_minute_fetch_depth.mjs`
  - Responsibility: live measurement after implementation; no edit expected.

## Task 1: Lock Source-Unit Mapping With Tests

**Files:**
- Modify: `tests/unit/live/test_kis_client.py`

**Interfaces:**
- Consumes: `KisClient.fetch_index_minute_candles(index, from_yyyymmdd, to_yyyymmdd, *, bucket_seconds, foreground=False)`
- Produces: pytest coverage for `_kis_index_minute_unit_seconds(bucket_seconds)`

- [ ] **Step 1: Write the failing test**

Replace the current parametrization in `test_fetch_index_minute_candles_uses_kis_10m_source_for_supported_longer_buckets` with this broader mapping:

```python
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("display_bucket_seconds", "kis_input_hour"),
    [
        (60, "60"),
        (180, "60"),
        (300, "300"),
        (600, "600"),
        (900, "300"),
        (1800, "600"),
    ],
)
async def test_fetch_index_minute_candles_uses_best_kis_source_for_display_bucket(
    display_bucket_seconds: int,
    kis_input_hour: str,
) -> None:
    captured: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["params"] = dict(req.url.params)
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "0",
                "msg1": "OK",
                "output2": [
                    {
                        "stck_bsop_date": "20260619",
                        "stck_cntg_hour": "090000",
                        "bstp_nmix_oprc": "2850.10",
                        "bstp_nmix_hgpr": "2852.34",
                        "bstp_nmix_lwpr": "2849.87",
                        "bstp_nmix_prpr": "2851.67",
                        "cntg_vol": "123456",
                    },
                ],
            },
        )

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        await client.fetch_index_minute_candles(
            get_representative_index("KOSPI"),
            "20260619",
            "20260619",
            bucket_seconds=display_bucket_seconds,
            foreground=True,
        )
    finally:
        await client.aclose()

    assert (captured["params"] or {})["FID_INPUT_HOUR_1"] == kis_input_hour
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py::test_fetch_index_minute_candles_uses_best_kis_source_for_display_bucket -q
```

Expected: FAIL for `bucket_seconds=300` and `bucket_seconds=900`, because current code sends `"60"`.

- [ ] **Step 3: Implement minimal source-unit mapping**

In `hoga/live/kis_client.py`, replace `_kis_index_minute_unit_seconds` with:

```python
def _kis_index_minute_unit_seconds(bucket_seconds: int) -> int:
    if bucket_seconds in {600, 1800}:
        return 600
    if bucket_seconds in {300, 900}:
        return 300
    return 60
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py::test_fetch_index_minute_candles_uses_best_kis_source_for_display_bucket -q
```

Expected: PASS.

## Task 2: Prove 15m Aggregates Correctly From 5m KIS Rows

**Files:**
- Modify: `tests/unit/live/test_kis_client.py`

**Interfaces:**
- Consumes: `_aggregate_index_minute_candles` through public `fetch_index_minute_candles`
- Produces: regression coverage that KIS `300` rows become display `900` rows with correct OHLCV

- [ ] **Step 1: Write the failing-or-protective test**

Add this test near the existing index minute tests:

```python
@pytest.mark.asyncio
async def test_fetch_index_minute_candles_aggregates_5m_source_to_15m_display_bucket() -> None:
    captured: dict[str, object] = {}

    def row(hhmmss: str, open_s: str, high_s: str, low_s: str, close_s: str, volume_s: str) -> dict[str, str]:
        return {
            "stck_bsop_date": "20260619",
            "stck_cntg_hour": hhmmss,
            "bstp_nmix_oprc": open_s,
            "bstp_nmix_hgpr": high_s,
            "bstp_nmix_lwpr": low_s,
            "bstp_nmix_prpr": close_s,
            "cntg_vol": volume_s,
        }

    def handler(req: httpx.Request) -> httpx.Response:
        captured["params"] = dict(req.url.params)
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "0",
                "msg1": "OK",
                "output2": [
                    row("090000", "100", "105", "99", "104", "10"),
                    row("090500", "104", "108", "103", "106", "20"),
                    row("091000", "106", "109", "101", "102", "30"),
                    row("091500", "102", "103", "100", "101", "40"),
                ],
            },
        )

    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    try:
        result = await client.fetch_index_minute_candles(
            get_representative_index("KOSPI"),
            "20260619",
            "20260619",
            bucket_seconds=900,
            foreground=True,
        )
    finally:
        await client.aclose()

    assert (captured["params"] or {})["FID_INPUT_HOUR_1"] == "300"
    assert len(result.candles) == 2
    first = result.candles[0]
    assert first.open == 100.0
    assert first.high == 109.0
    assert first.low == 99.0
    assert first.close == 102.0
    assert first.volume == 60
```

- [ ] **Step 2: Run test to verify behavior**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py::test_fetch_index_minute_candles_aggregates_5m_source_to_15m_display_bucket -q
```

Expected after Task 1: PASS. If it fails, fix only `_aggregate_index_minute_candles` bucket grouping; do not change API shape.

- [ ] **Step 3: Run the focused KIS client suite**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py -q
```

Expected: PASS.

## Task 3: Preserve Cache Contract

**Files:**
- No production change expected.
- Test: `tests/unit/live/test_index_minute_candles_cache.py`
- Test: `tests/api/test_live_indices_routes.py`

**Interfaces:**
- Consumes: `IndexMinuteCandlesCache`, route-level cache collector in `hoga/live/api.py`
- Produces: confidence that changing KIS source unit does not break exact-range cache keys

- [ ] **Step 1: Run cache and route tests**

Run:

```bash
uv run pytest tests/unit/live/test_index_minute_candles_cache.py tests/api/test_live_indices_routes.py -q
```

Expected: PASS.

- [ ] **Step 2: If a route test fails due to expected KIS source unit**

Only update the expected request parameter for `5m` or `15m` route cases to `"300"`. Do not remove cache assertions.

Expected replacement assertion shape:

```python
assert captured_params["FID_INPUT_HOUR_1"] == "300"
```

## Task 4: Measure Live Cold/Warm Depth

**Files:**
- Use: `scripts/measure_index_minute_fetch_depth.mjs`

**Interfaces:**
- Consumes: running backend at `HOGA_API_BASE`, default `http://127.0.0.1:8000`
- Produces: before/after proof for 5m and 15m candle depth

- [ ] **Step 1: Start or reuse the backend**

If no server is running, start the existing app command used in this repo:

```bash
uv run uvicorn hoga.api.app:app --host 127.0.0.1 --port 8000
```

Expected: server listens on `http://127.0.0.1:8000`.

- [ ] **Step 2: Run focused measurement**

Run:

```bash
HOGA_TIMEFRAMES=1m,3m,5m,10m,15m,30m node scripts/measure_index_minute_fetch_depth.mjs
```

Expected:
- `1m` and `3m`: still limited to latest KIS `60` rows; no fake page-walk.
- `5m`: uses KIS `300`, should cover more days than the previous `60` source.
- `15m`: uses KIS `300` and aggregates to 15m, should cover more days than the previous `60` source.
- `10m` and `30m`: no regression from existing `600` source.
- second exact request remains much faster because exact minute cache is reused.

## Task 5: Document The Verified Limitation

**Files:**
- Modify: `docs/superpowers/plans/2026-06-23-index-minute-candle-cache.md`

**Interfaces:**
- Consumes: live probe findings
- Produces: durable note for future implementation/review

- [ ] **Step 1: Append a limitation note**

Add this section near the end of the plan:

```markdown
## Verified KIS Index Minute Limitation

2026-06-23 live probes confirmed that domestic index minute endpoint
`/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice`
does not behave like stock `inquire-time-dailychartprice`.

- Stock minute supports `FID_INPUT_DATE_1` plus `FID_INPUT_HOUR_1=HHMMSS` cursor.
- Index minute uses `FID_INPUT_HOUR_1` as a source unit such as `30`, `60`, `300`, `600`, `3600`.
- Adding `FID_INPUT_DATE_1` to index minute requests is ignored by KIS.
- Forcing `tr_cont=N` or `tr_cont=M` returns the same page, not an older page.
- Therefore cache improves repeated requests, and better source-unit selection improves 5m/15m depth, but KIS REST cannot create stock-like 1-year index minute scrollback.
```

- [ ] **Step 2: Run markdown diff check**

Run:

```bash
git diff -- docs/superpowers/plans/2026-06-23-index-minute-candle-cache.md
```

Expected: only documentation text changed.

## Task 6: Final Verification And Commit

**Files:**
- Modify: `hoga/live/kis_client.py`
- Modify: `tests/unit/live/test_kis_client.py`
- Modify: `docs/superpowers/plans/2026-06-23-index-minute-candle-cache.md`

**Interfaces:**
- Produces: one focused commit

- [ ] **Step 1: Run backend tests**

Run:

```bash
uv run pytest tests/unit/live/test_kis_client.py tests/unit/live/test_index_minute_candles_cache.py tests/api/test_live_indices_routes.py -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend API contract tests**

Run:

```bash
cd frontend && npx vitest run src/live/LivePage.test.tsx src/api/liveIndices.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd frontend && npx tsc -b --pretty false
```

Expected: PASS.

- [ ] **Step 4: Check whitespace**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Commit**

Run:

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_client.py docs/superpowers/plans/2026-06-23-index-minute-candle-cache.md docs/superpowers/plans/2026-06-23-index-minute-source-units.md
git commit -m "fix: use wider KIS source units for index minutes"
```

Expected: commit succeeds with only the files above staged.

## Self-Review

- Spec coverage: Plan addresses the verified KIS limitation, improves the only safe backend lever (`300` source for 5m/15m), keeps cache intact, and includes live measurement.
- Placeholder scan: No TBD/TODO/fill-later placeholders remain.
- Type consistency: Existing public method signatures are unchanged. Tests use existing `IndexCandleFetchResult` path through `KisClient.fetch_index_minute_candles`.
