# Backend Performance Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 코드 기준 성능 baseline을 재구축하고, 사용자 체감 지연과 프로세스 자원 위험을 계측한 뒤 근거가 통과한 병목만 독립 작업으로 개선한다.

**Architecture:** 첫 단계는 현재 깨져 있는 range profiler를 복구하고 HTTP·LiveBuffer의 저비용 관측 seam을 추가한다. 두 번째 단계는 range, 과거 분봉, LiveBuffer를 동일한 입력과 지표로 반복 측정한다. 구조 변경은 각 go/no-go gate를 통과한 경우에만 별도 ADR·구현 플랜으로 진행하며, 기존 ADR-0095(memory-only)와 ADR-0103(on-demand backfill)을 측정 없이 되돌리지 않는다.

**Tech Stack:** Python 3.14, FastAPI/ASGI, asyncio, DuckDB, Polars, PyArrow, httpx, pytest, 기존 `HOGA_PERF_DEBUG`와 `/api/live/status`.

## Global Constraints

- 프로덕션 데이터, 실제 사용자 데이터, 운영 서버에는 벤치마크 부하를 주지 않는다.
- `HOGA_BENCH_DATA_DIR`은 격리된 개발용 데이터 디렉터리만 가리킨다.
- 외부 KIS 호출이 필요한 측정은 개발 계정 사용 승인을 받은 경우에만 실행한다.
- 승인 전 과거 분봉 benchmark는 mock/recorded transport로만 실행한다.
- ADR-0095를 supersede하기 전에는 KIS 과거 분봉 디스크 캐시를 추가하지 않는다.
- ADR-0103을 supersede하기 전에는 warm/read-ahead를 재도입하지 않는다.
- 오늘 분봉은 디스크에 영속하지 않는다.
- Uvicorn worker 수, DuckDB memory limit, KIS worker/rate limit은 이번 플랜에서 변경하지 않는다.
- 성능 개선 판정은 동일 corpus의 before/after p50/p95, CPU/RSS, 응답 크기로 한다.
- 각 프로덕션 변경은 failing test를 먼저 작성한다.
- 저장소 전체 Ruff baseline 456건을 이번 작업과 섞지 않는다. 변경 파일만 `ruff check`한다.

---

## Baseline and Decision Gates

현재 알려진 수치는 방향을 정하는 참고값이며 current-head acceptance 값으로 재사용하지 않는다.

| 경로 | 기존 근거 | 이번 플랜의 gate |
|---|---|---|
| 과거 분봉 | 2026-07-07 cold 1.55~2.57s, warm 8ms. 이후 다계정 scheduler가 도입됨 | 현재 계정 구성에서 3거래일 step p95가 1,000ms를 넘을 때만 read-ahead 재검토 |
| Range sidecar | 약 2개월 2.50~2.55s / 17.5MB | 60 Stock-Date cold p95가 1,000ms를 넘거나 raw body가 5MB를 넘고, 단일 slice가 total의 35% 이상일 때만 구조 변경 |
| LiveBuffer | 합성 10k 호가가 `tracemalloc` 54.75MiB | 20분 soak에서 retention 안정 시점 이후 RSS가 계속 증가하거나 buffer가 process RSS의 30%를 넘거나 event-loop lag p99가 50ms를 넘으면 구조 변경 |
| Screener | 합성 1M rows에서 MA 4개 270.5ms | 개발 corpus p95가 500ms를 넘고 window operator가 total의 40% 이상일 때 후속 최적화 |
| Inventory | 합성 10k Stock-Date warm 119ms | 개발 corpus p95가 150ms를 넘거나 응답이 5MB를 넘을 때 manifest/pagination 후속 |
| Capture done | 합성 10k rows snapshot 22.9ms / JSON 2.56MB | 실제 세션 p95가 100ms를 넘거나 done 응답이 5MB를 넘을 때 history 분리 후속 |

Gate 수치는 이번 프로젝트의 로컬 단일 사용자 UX를 위한 초기 기준이다. 측정 보고서에는
원시 표본도 함께 남겨 기준을 변경할 수 있게 한다.

---

## File Structure

### 이번 플랜에서 직접 변경

- Modify `tools/profile_live_range.py`: 현재 함수·mode와 일치하는 range profiler, JSON 출력, 명시적 데이터 디렉터리.
- Create `tests/tools/test_profile_live_range.py`: profiler registry와 CLI contract smoke test.
- Modify `hoga/api/request_timing.py`: 일반 HTTP의 TTFB, end-of-body, body bytes를 한 로그에 기록하고 streaming은 기존 TTFB 의미 유지.
- Modify `tests/unit/api/test_request_timing.py`: 일반 응답·streaming 응답의 새 timing contract.
- Modify `hoga/live/buffer.py`: O(1) total/high-water counter와 publish/drop counters.
- Modify `tests/unit/live/test_buffer.py`: counter, eviction, code drop, subscriber overflow 검증.
- Modify `tests/unit/live/test_api.py`: `/api/live/status.cache_stats.live_buffer` wire 검증.
- Create `tools/bench_live_buffer.py`: synthetic LiveBuffer soak JSON 도구.
- Create `tests/tools/test_bench_live_buffer.py`: 작은 입력에서 benchmark output schema 검증.
- Create `docs/superpowers/measurements/2026-07-24-backend-performance/README.md`: 재현 명령과 안전 조건.

### Gate 통과 후 별도 플랜에서만 변경

- `hoga/live/past_candles_cache.py`
- `hoga/live/live_candle_backfill.py`
- `frontend/src/api/livePastCandles.ts`
- `hoga/api/bundle.py`
- `hoga/api/past_indicators_cache.py`
- `hoga/api/screener_scan.py`
- `hoga/api/queries.py`
- `hoga/api/captures.py`

이 파일들은 측정 결과 없이 이번 플랜에서 구조 변경하지 않는다.

---

### Task 1: Repair the Current-Head Range Profiler

**Files:**
- Modify: `tools/profile_live_range.py`
- Create: `tests/tools/test_profile_live_range.py`

**Interfaces:**
- Consumes: `hoga.api.bundle.build_range_bundle(engine, **request_kwargs)`.
- Produces:
  - `PROFILED_FUNCTIONS: tuple[str, ...]`
  - `SUPPORTED_MODES: tuple[str, ...] = ("hoga", "sidecar", "candles")`
  - `profile_range_case(engine: QueryEngine, *, label: str, request_kwargs: dict[str, object]) -> dict[str, object]`
  - CLI JSONL: case당 한 줄, `label`, `total_ms`, `result_counts`, `functions`.

- [ ] **Step 1: Write the failing registry tests**

```python
# tests/tools/test_profile_live_range.py
from hoga.api import bundle
from tools import profile_live_range


def test_profile_registry_matches_current_bundle() -> None:
    missing = [
        name for name in profile_live_range.PROFILED_FUNCTIONS
        if not hasattr(bundle, name)
    ]
    assert missing == []


def test_profile_modes_match_api_contract() -> None:
    assert profile_live_range.SUPPORTED_MODES == ("hoga", "sidecar", "candles")
    assert "full" not in profile_live_range.SUPPORTED_MODES
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
uv run --extra dev pytest tests/tools/test_profile_live_range.py -q
```

Expected: FAIL because `SUPPORTED_MODES` does not exist and the current registry contains
`build_volume_profile_slice` and `build_volume_profile_range`, which no longer exist.

- [ ] **Step 3: Replace the stale function and mode registries**

```python
PROFILED_FUNCTIONS = (
    "build_program_trade_series",
    "build_candles_slice",
    "build_quote_ratio_slice",
    "build_fill_strength_slice",
    "build_ask_bid_peak_slices",
    "build_trade_volume_poc_slice",
    "build_broker_late_entries_slice",
    "build_volume_distribution_slice",
    "build_depth_heatmap_slice",
    "build_depth_delta_slice",
)

SUPPORTED_MODES = ("hoga", "sidecar", "candles")
```

Remove every `mode="full"` case.

- [ ] **Step 4: Add a reusable profiler function with patch cleanup**

Use `contextlib.ExitStack` and `unittest.mock.patch.object` so one case cannot leave global
wrappers installed for the next case.

```python
def profile_range_case(
    engine: QueryEngine,
    *,
    label: str,
    request_kwargs: dict[str, object],
) -> dict[str, object]:
    rows: list[tuple[str, float]] = []
    with ExitStack() as stack:
        for name in PROFILED_FUNCTIONS:
            original = getattr(bundle_mod, name)

            @wraps(original)
            def wrapped(*args, __name=name, __original=original, **kwargs):
                started = perf_counter()
                try:
                    return __original(*args, **kwargs)
                finally:
                    rows.append((__name, (perf_counter() - started) * 1000))

            stack.enter_context(patch.object(bundle_mod, name, wrapped))

        started = perf_counter()
        result = bundle_mod.build_range_bundle(engine, **request_kwargs)
        total_ms = (perf_counter() - started) * 1000

    totals: defaultdict[str, float] = defaultdict(float)
    calls: defaultdict[str, int] = defaultdict(int)
    for name, elapsed_ms in rows:
        totals[name] += elapsed_ms
        calls[name] += 1
    return {
        "label": label,
        "total_ms": round(total_ms, 3),
        "result_counts": {
            "segments": len(result.segments),
            "candles": len(result.candles),
            "quote_ratio": len(result.quote_ratio.points),
            "fill_strength": len(result.fill_strength.points),
            "ask_peaks": len(result.ask_peaks),
            "bid_peaks": len(result.bid_peaks),
            "depth_heatmap": len(result.depth_heatmap),
            "depth_delta": len(result.depth_delta),
        },
        "functions": {
            name: {"total_ms": round(totals[name], 3), "calls": calls[name]}
            for name in sorted(totals)
        },
    }
```

- [ ] **Step 5: Require an explicit benchmark data directory**

Add CLI options:

```text
--data-dir PATH   required
--code CODE       required
--from YYYYMMDD   required
--to YYYYMMDD     required
--bucket-ms INT   default 60000
--mode MODE       repeatable; default hoga,sidecar,candles
--repeat INT      default 3
--label-prefix TEXT default range
```

Do not call `resolve_data_dir()` implicitly. Reject a missing directory with exit code 2.
Print one JSON object per run using `json.dumps(..., ensure_ascii=False)`. Build each
result label as `<label-prefix>:<mode>:<repeat-index>` so multiple window runs remain
distinguishable after appending to one JSONL file.

- [ ] **Step 6: Add CLI parser tests**

```python
def test_parser_requires_explicit_data_dir() -> None:
    parser = profile_live_range.build_parser()
    with pytest.raises(SystemExit) as exc:
        parser.parse_args([
            "--code", "005930", "--from", "20260701", "--to", "20260724",
        ])
    assert exc.value.code == 2
```

- [ ] **Step 7: Run tests and current-head smoke check**

Run:

```bash
uv run --extra dev pytest tests/tools/test_profile_live_range.py -q
uv run --extra dev ruff check tools/profile_live_range.py tests/tools/test_profile_live_range.py
uv run python tools/profile_live_range.py --help
```

Expected: all tests and Ruff pass; help lists only `hoga`, `sidecar`, `candles`.

- [ ] **Step 8: Commit**

```bash
git add tools/profile_live_range.py tests/tools/test_profile_live_range.py
git commit -m "perf: repair range profiling harness"
```

---

### Task 2: Record End-of-Body Time and Response Bytes

**Files:**
- Modify: `hoga/api/request_timing.py`
- Modify: `tests/unit/api/test_request_timing.py`

**Interfaces:**
- Consumes: ASGI `http.response.start` and `http.response.body`.
- Produces one log line:
  - normal response: `ttfb_ms`, `duration_ms`, `body_bytes`
  - streaming response: existing TTFB-only line with `streaming=1`
- Preserves `HOGA_SLOW_REQUEST_MS=0` disable behavior and `HOGA_PERF_DEBUG`.

- [ ] **Step 1: Write failing normal-response assertions**

Extend `test_perf_debug_logs_every_request`:

```python
msg = record.getMessage()
assert "ttfb_ms=" in msg
assert "duration_ms=" in msg
assert "body_bytes=" in msg
assert "streaming=1" not in msg
```

Add:

```python
def test_regular_response_logs_once_at_final_body(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("HOGA_PERF_DEBUG", "1")
    client = _make_client()
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        response = client.get("/ping")
    [record] = _timing_records(caplog)
    assert f"body_bytes={len(response.content)}" in record.getMessage()
```

- [ ] **Step 2: Write the streaming compatibility assertion**

In `_make_client`, make the streaming test route identify its actual wire contract:

```python
return StreamingResponse(_gen(), media_type="text/event-stream")
```

Extend `test_streaming_measures_ttfb_not_stream_lifetime`:

```python
msg = record.getMessage()
assert "streaming=1" in msg
assert "body_bytes=" not in msg
```

- [ ] **Step 3: Run tests and confirm RED**

Run:

```bash
uv run --extra dev pytest tests/unit/api/test_request_timing.py -q
```

Expected: FAIL because the current middleware logs only `duration_ms` at
`http.response.start`.

- [ ] **Step 4: Implement the two response modes**

At request start keep:

```python
t0 = time.perf_counter()
status = 0
ttfb_ms: float | None = None
body_bytes = 0
streaming = False
logged = False
```

At `http.response.start`:

```python
status = int(message["status"])
ttfb_ms = (time.perf_counter() - t0) * 1000
headers = {
    key.lower(): value.lower()
    for key, value in message.get("headers", [])
}
content_type = headers.get(b"content-type", b"")
streaming = content_type.startswith(b"text/event-stream")
if streaming:
    _log_timing(
        scope=scope,
        status=status,
        ttfb_ms=ttfb_ms,
        duration_ms=ttfb_ms,
        body_bytes=None,
        streaming=True,
    )
    logged = True
```

At each `http.response.body`:

```python
body_bytes += len(message.get("body", b""))
if not message.get("more_body", False) and not logged:
    duration_ms = (time.perf_counter() - t0) * 1000
    _log_timing(
        scope=scope,
        status=status,
        ttfb_ms=ttfb_ms or duration_ms,
        duration_ms=duration_ms,
        body_bytes=body_bytes,
        streaming=False,
    )
    logged = True
```

Move threshold/debug policy into `_log_timing`. For normal responses, slow 판정은
`duration_ms`; streaming은 `ttfb_ms`를 사용한다. Query string 200자 제한은 유지한다.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
uv run --extra dev pytest tests/unit/api/test_request_timing.py tests/test_api_gzip.py -q
uv run --extra dev ruff check hoga/api/request_timing.py tests/unit/api/test_request_timing.py
```

Expected: all pass. GZip response도 body completion을 막지 않는다.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/request_timing.py tests/unit/api/test_request_timing.py
git commit -m "perf: measure response completion and bytes"
```

---

### Task 3: Add O(1) LiveBuffer High-Water Observability

**Files:**
- Modify: `hoga/live/buffer.py`
- Modify: `tests/unit/live/test_buffer.py`
- Modify: `tests/unit/live/test_api.py`

**Interfaces:**
- Consumes: existing `LiveBuffer.publish`, time eviction, `drop_codes_except`.
- Produces additive `stats_snapshot()` fields:
  - `published_total: int`
  - `subscriber_drops: int`
  - `high_water_entries: int`
  - `total_entries: int` backed by an O(1) counter

- [ ] **Step 1: Write failing counter tests**

```python
@pytest.mark.asyncio
async def test_stats_track_publish_high_water_and_drop() -> None:
    buf = LiveBuffer(retention_ms=100)
    await buf.publish("005930", [
        _snap(100, SnapshotKind.OB, {"x": 1}),
        _snap(100, SnapshotKind.TRADE, {"trades": []}),
    ], now_ms=100)
    first = await buf.stats_snapshot()
    assert first["published_total"] == 2
    assert first["total_entries"] == 2
    assert first["high_water_entries"] == 2

    await buf.publish(
        "005930",
        [_snap(1_000, SnapshotKind.OB, {"x": 2})],
        now_ms=1_000,
    )
    second = await buf.stats_snapshot()
    assert second["published_total"] == 3
    assert second["total_entries"] == 1
    assert second["high_water_entries"] == 2
```

Add a subscriber overflow test with `q = buf.subscribe("005930")`, publish 1,025 entries
without draining, and assert `subscriber_drops == 1`.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_buffer.py -q
```

Expected: FAIL because the new stats fields do not exist.

- [ ] **Step 3: Add constant-time counters**

Initialize:

```python
self._total_entries = 0
self._published_total = 0
self._subscriber_drops = 0
self._high_water_entries = 0
```

Inside `publish`, account for deque maxlen and time eviction without scanning all buffers:

```python
before = len(d)
d.append(entry)
self._total_entries += len(d) - before
self._published_total += 1
while d and d[0]["t_ms"] < cutoff:
    d.popleft()
    self._total_entries -= 1
self._high_water_entries = max(
    self._high_water_entries,
    self._total_entries,
)
```

On `asyncio.QueueFull`:

```python
self._subscriber_drops += 1
```

In `drop_codes_except`, subtract each removed deque length before deletion:

```python
for key in [k for k in self._buf if k[0] not in keep]:
    self._total_entries -= len(self._buf[key])
    del self._buf[key]
```

Return counters from `stats_snapshot` while retaining `per_kind`, `codes`, `subscribers`,
`retention_ms`, and `max_entries_per_deque`.

- [ ] **Step 4: Verify the `/api/live/status` wire**

Extend `test_get_live_status_includes_cache_stats`:

```python
live_buffer = cache_stats["live_buffer"]
assert live_buffer["published_total"] == 0
assert live_buffer["subscriber_drops"] == 0
assert live_buffer["high_water_entries"] == 0
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
uv run --extra dev pytest \
  tests/unit/live/test_buffer.py \
  tests/unit/live/test_api.py::test_get_live_status_includes_cache_stats \
  -q
uv run --extra dev ruff check \
  hoga/live/buffer.py \
  tests/unit/live/test_buffer.py \
  tests/unit/live/test_api.py
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add hoga/live/buffer.py tests/unit/live/test_buffer.py tests/unit/live/test_api.py
git commit -m "perf: expose live buffer high-water metrics"
```

---

### Task 4: Add a Reproducible LiveBuffer Soak Tool

**Files:**
- Create: `tools/bench_live_buffer.py`
- Create: `tests/tools/test_bench_live_buffer.py`

**Interfaces:**
- Produces:
  - `run_benchmark(*, codes: int, ticks_per_code: int, levels: int, retention_ms: int) -> dict[str, int | float]`
  - CLI options `--codes`, `--ticks-per-code`, `--levels`, `--retention-ms`
  - one JSON result containing elapsed, publish rate, `tracemalloc`, `ru_maxrss`, buffer stats.

- [ ] **Step 1: Write the output-contract test**

```python
from tools.bench_live_buffer import run_benchmark


def test_small_benchmark_returns_stable_schema() -> None:
    result = run_benchmark(
        codes=2,
        ticks_per_code=3,
        levels=2,
        retention_ms=1_000_000,
    )
    assert result["entries"] == 6
    assert result["codes"] == 2
    assert result["published_total"] == 6
    assert result["elapsed_ms"] >= 0
    assert result["tracemalloc_peak_bytes"] > 0
    assert result["max_rss_bytes"] > 0
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
uv run --extra dev pytest tests/tools/test_bench_live_buffer.py -q
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic payload generation**

Use a payload with `levels` ask/bid dictionaries:

```python
def orderbook_payload(code: str, tick: int, levels: int) -> dict:
    base = 70_000 + tick % 100
    return {
        "code": code,
        "phase": "regular",
        "current_price": base,
        "asks": [
            {"price": base + level, "qty": 1_000 + tick + level}
            for level in range(1, levels + 1)
        ],
        "bids": [
            {"price": base - level, "qty": 1_200 + tick + level}
            for level in range(1, levels + 1)
        ],
        "total_ask_qty": 10_000 + tick,
        "total_bid_qty": 12_000 + tick,
    }
```

Use `tracemalloc.start()`, `resource.getrusage(resource.RUSAGE_SELF).ru_maxrss`, and
`time.perf_counter()`. Convert Linux KiB `ru_maxrss` to bytes. Run the async publish loop
with `asyncio.run`.

- [ ] **Step 4: Add CLI and validation**

Reject non-positive `codes`, `ticks-per-code`, `levels`, or `retention-ms` with exit code 2.
Print exactly one JSON object.

- [ ] **Step 5: Run tests and a bounded smoke benchmark**

Run:

```bash
uv run --extra dev pytest tests/tools/test_bench_live_buffer.py -q
uv run --extra dev ruff check tools/bench_live_buffer.py tests/tools/test_bench_live_buffer.py
uv run python tools/bench_live_buffer.py \
  --codes 20 \
  --ticks-per-code 500 \
  --levels 10 \
  --retention-ms 1000000000
```

Expected: 10,000 entries and a single JSON result. Do not extrapolate this result to
800 live codes without the timed soak in Task 5.

- [ ] **Step 6: Commit**

```bash
git add tools/bench_live_buffer.py tests/tools/test_bench_live_buffer.py
git commit -m "perf: add live buffer soak harness"
```

---

### Task 5: Capture the Current-Head Baseline

**Files:**
- Create: `docs/superpowers/measurements/2026-07-24-backend-performance/README.md`
- Create during execution:
  - `docs/superpowers/measurements/2026-07-24-backend-performance/range.jsonl`
  - `docs/superpowers/measurements/2026-07-24-backend-performance/live-buffer.jsonl`
  - `docs/superpowers/measurements/2026-07-24-backend-performance/http.log`
  - `docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md`

**Interfaces:**
- Consumes: Task 1 profiler, Task 2 request log, Task 3 status metrics, Task 4 soak tool.
- Produces: raw measurements plus one decision table with `GO`, `NO-GO`, or
  `NEEDS_APPROVED_EXTERNAL_MEASUREMENT`.

- [ ] **Step 1: Write the safety and reproduction README**

The README must state:

```markdown
# Backend Performance Baseline

- Never point HOGA_BENCH_DATA_DIR at production or user data.
- Range measurements require an isolated developer fixture.
- KIS measurements are disabled until the operator explicitly approves use of a
  development account.
- Record commit SHA, Python version, DuckDB version, CPU count, total memory, and
  configured KIS account count with every result.
```

- [ ] **Step 2: Record environment metadata**

Run:

```bash
mkdir -p docs/superpowers/measurements/2026-07-24-backend-performance
git rev-parse HEAD
uv run python --version
uv run python -c 'import duckdb; print(duckdb.__version__)'
uv run python -c 'import os; print(os.cpu_count())'
```

Append output to `README.md`. Do not record secrets, data paths, account identifiers, or
query-string values.

- [ ] **Step 3: Run the range matrix**

Require the operator to set:

```bash
test -n "$HOGA_BENCH_DATA_DIR"
test -d "$HOGA_BENCH_DATA_DIR"
test -n "$HOGA_BENCH_CODE"
test -n "$HOGA_BENCH_FROM_5"
test -n "$HOGA_BENCH_FROM_20"
test -n "$HOGA_BENCH_FROM_60"
test -n "$HOGA_BENCH_TO"
```

For a fixed developer-fixture code and three fixed windows representing 5, 20, and
60 Stock-Dates, run each mode three times. The exact code/date values are written into
the measurement README before execution so subsequent runs reuse the same corpus.

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

`HOGA_BENCH_CODE`, the three `HOGA_BENCH_FROM_*` values, and `HOGA_BENCH_TO` are
benchmark configuration, not secrets. Store their chosen values in `README.md`.

- [ ] **Step 4: Run the LiveBuffer scale matrix**

Run:

```bash
for codes in 1 50 200 800; do
  uv run python tools/bench_live_buffer.py \
    --codes "$codes" \
    --ticks-per-code 1000 \
    --levels 10 \
    --retention-ms 1000000000
done > docs/superpowers/measurements/2026-07-24-backend-performance/live-buffer.jsonl
```

Then run a 20-minute replay/soak only in the isolated dev process using the measured
real tick mix. Poll `/api/live/status` every 10 seconds and record:

```text
timestamp, total_entries, high_water_entries, published_total,
subscriber_drops, process_rss_bytes, event_loop_lag_ms
```

If no recorded tick fixture exists, mark the 20-minute result
`NEEDS_APPROVED_EXTERNAL_MEASUREMENT`; do not use a production WebSocket.

- [ ] **Step 5: Measure past-candle cold behavior without unauthorized KIS calls**

First run the relevant tests and a recorded/mock transport benchmark:

```bash
uv run --extra dev pytest \
  tests/unit/live/test_live_candle_backfill.py \
  tests/unit/live/test_kis_capacity_scheduler.py \
  tests/unit/live/test_kis_runtime_accounts.py \
  -q
```

If a development KIS measurement is approved, run exactly 10 three-trading-day cold
steps after a fresh process and 10 warm repeats. Record only duration, candle count,
configured account count, scheduler queue wait, and `fresh_past_fetches`; do not store
response bodies or credentials. Otherwise mark the gate
`NEEDS_APPROVED_EXTERNAL_MEASUREMENT`.

- [ ] **Step 6: Write the decision table**

`DECISION.md` must use this exact shape:

```markdown
| Workstream | Evidence | Gate | Decision | Next action |
|---|---|---|---|---|
| Past candles | cold/warm p50/p95, fresh fetches | p95 > 1000ms | GO/NO-GO/NEEDS_APPROVED_EXTERNAL_MEASUREMENT | ADR-0103 review or close |
| LiveBuffer | RSS plateau, buffer/RSS %, loop lag p99 | growth, >30%, or >50ms | GO/NO-GO/NEEDS_APPROVED_EXTERNAL_MEASUREMENT | display-plane spec or close |
| Range sidecar | 60-day p95/body/top-slice share | >1000ms or >5MB and slice >=35% | GO/NO-GO | slice-specific plan or close |
```

Every `GO` row links its raw result line. Every `NO-GO` row explains which threshold was
not crossed.

- [ ] **Step 7: Commit the reproducible artifacts**

Before committing, scan for secrets and absolute user paths:

```bash
rg -n 'KIS_APP|KIS_SECRET|Authorization|Bearer|/home/|Cookie' \
  docs/superpowers/measurements/2026-07-24-backend-performance
```

Expected: no matches containing secrets or local absolute paths.

```bash
git add docs/superpowers/measurements/2026-07-24-backend-performance
git commit -m "perf: record backend performance baseline"
```

---

### Task 6: Apply the Past-Candle Decision Gate

**Files:**
- Read: `docs/adr/0095-kis-past-minute-candle-disk-cache-reaffirm-memory-only.md`
- Read: `docs/adr/0103-live-minute-backfill-remove-warm-and-read-ahead.md`
- Read: `docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md`
- Create only on GO: a new ADR under `docs/adr/`
- Create only after ADR acceptance: a separate implementation plan under
  `docs/superpowers/plans/`

**Interfaces:**
- Consumes: current-head cold/warm p95 and KIS quota evidence.
- Produces one of two terminal outcomes:
  - `NO-GO`: memory-only/on-demand 유지, finding closed with evidence.
  - `GO`: accepted ADR plus a new implementation plan; no production cache change in this task.

- [ ] **Step 1: Enforce the gate**

Use the following decision order:

```text
1. No approved real KIS measurement -> NEEDS_APPROVED_EXTERNAL_MEASUREMENT; stop.
2. Three-day cold p95 <= 1000ms -> NO-GO; keep ADR-0095/0103 unchanged.
3. Three-day cold p95 > 1000ms but restart duplicate fetches are not a quota problem
   -> consider prior-span read-ahead only; disk cache remains rejected.
4. Restart duplicate fetches consume >=20% of past-minute calls in three separate
   measured sessions, or development quota is materially constrained
   -> ADR-0095 disk-cache reversal may be proposed.
```

- [ ] **Step 2: For NO-GO, document the accepted latency**

Append to `DECISION.md`:

```markdown
### Past-candle decision

NO-GO. Current-head cold p95 is within the 1,000ms interaction budget. ADR-0095
memory-only and ADR-0103 on-demand behavior remain unchanged. Re-open only when a
trigger condition in ADR-0095 is observed.
```

- [ ] **Step 3: For read-ahead GO, write an ADR before code**

The ADR must explicitly supersede the read-ahead portion of ADR-0103, retain
memory-only cache, cap read-ahead at the immediately preceding request span and
15 calendar days, use background priority, and abort on scheduler pressure/rate-limit.
It must include a rollback switch and KIS-call budget.

- [ ] **Step 4: For disk-cache GO, write an ADR before code**

The ADR must explicitly supersede ADR-0095 and reuse its documented reversal namespace:

```text
data_dir/kis-past-minute-candles/<venue>/<code>/<date>.json
```

It must decide the disk cap/pruning policy, prohibit today persistence, prohibit legacy
`kis-past-candles` reuse, preserve bypass semantics, and require stale/empty non-KRX
invalidation.

- [ ] **Step 5: Stop and request approval**

Do not modify `PastCandlesCache` or `LiveMinuteCandleBackfill` in this task. Present the
new ADR and measurement result for explicit approval, then create a dedicated TDD plan
for the accepted design.

- [ ] **Step 6: Commit the decision**

```bash
git add docs/adr docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md
git commit -m "docs: decide past candle performance path"
```

---

### Task 7: Apply the LiveBuffer Decision Gate

**Files:**
- Read: `hoga/live/buffer.py`
- Read: `docs/adr/0116-*.md` if present
- Read: `docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md`
- Create only on GO:
  - `docs/superpowers/specs/2026-07-24-live-buffer-display-plane-design.md`
  - `docs/superpowers/plans/2026-07-24-live-buffer-display-plane-plan.md`

**Interfaces:**
- Consumes: 20-minute RSS plateau, buffer/RSS share, loop lag p99, first-view coverage.
- Produces: NO-GO closure or a separate display-plane design and implementation plan.

- [ ] **Step 1: Enforce the gate**

```text
GO if any condition is true:
- RSS continues rising after retention_ms + 120 seconds.
- LiveBuffer estimated/attributed memory exceeds 30% of process RSS.
- event-loop lag p99 exceeds 50ms while publish load is active.
- the process approaches the host/container memory limit during 200/800-code soak.

Otherwise: NO-GO.
```

- [ ] **Step 2: For NO-GO, retain only the new metrics**

Document that current per-deque cap, retention, and `drop_codes_except` are adequate for
the measured workload. Keep Task 3 observability so later scale changes are visible.

- [ ] **Step 3: For GO, lock the design boundary**

The new design spec must define:

```text
- Full-fidelity 15-minute ring: viewed/subscribed codes only.
- Non-viewed active codes: latest-value latch only.
- Storage writer/downsampler path: unchanged.
- First view: promoted parquet + latch/backfill merge.
- Global high-water policy: observable soft alert before any hard drop.
- No silent loss for the currently viewed code.
```

The spec must measure and state the maximum first-view tail gap before choosing a hard
global cap.

- [ ] **Step 4: Create a separate TDD implementation plan**

The plan must cover `hoga/live/buffer.py`, `hoga/live/stream.py`, lifecycle viewed-code
wiring, first-view backfill, and frontend coverage tests. Do not implement it inside this
master plan.

- [ ] **Step 5: Commit the decision/spec**

```bash
git add docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md \
  docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: decide live buffer scaling path"
```

---

### Task 8: Apply the Range Sidecar Decision Gate

**Files:**
- Read: `tools/profile_live_range.py`
- Read: `hoga/api/bundle.py`
- Read: `frontend/src/api/range.ts`
- Read: `docs/superpowers/measurements/2026-07-24-backend-performance/range.jsonl`
- Create only on GO:
  - `docs/superpowers/specs/2026-07-24-range-dominant-slice-performance-design.md`
  - `docs/superpowers/plans/2026-07-24-range-dominant-slice-performance-plan.md`

**Interfaces:**
- Consumes: 60 Stock-Date sidecar p95, raw/gzip bytes, function-level share.
- Produces: NO-GO closure or one slice-specific optimization plan.

- [ ] **Step 1: Enforce the gate**

```text
NO-GO when:
- sidecar cold p95 <= 1000ms, and
- raw response <= 5MB.

GO when:
- either threshold is exceeded, and
- one profiled function accounts for >=35% of total time in at least two of
  three cold runs.

NEEDS_MORE_BREAKDOWN when thresholds are exceeded but no function reaches 35%.
```

- [ ] **Step 2: For NO-GO, preserve current delta architecture**

Document that `frontend/src/api/range.ts` delta merge and current caches meet the measured
budget. Do not introduce a new endpoint or cache.

- [ ] **Step 3: For GO, plan only the dominant slice**

Choose exactly one strategy based on evidence:

```text
- Repeated immutable computation -> versioned per-Stock-Date materialization.
- Large response with cheap compute -> chunk/lazy endpoint or field omission.
- Today-only recompute -> single-flight/TTL consistent with today freshness.
- Serialization dominates -> response-shape or encoder experiment with before/after.
```

The follow-up plan must preserve source preference, capture-mtime invalidation, today
freshness, date ordering, frontend delta merge, and `RangeBundle` compatibility unless
the design explicitly versions the wire contract.

- [ ] **Step 4: For NEEDS_MORE_BREAKDOWN, add nested timing before optimization**

Add a profiler wrapper only around the unmeasured internal stages, rerun the same corpus,
and update `range.jsonl`. Do not select an optimization by intuition.

- [ ] **Step 5: Commit the decision/spec**

```bash
git add docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md \
  docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: decide range sidecar performance path"
```

---

### Task 9: Triage the Medium-Priority Workstreams

**Files:**
- Read: `hoga/api/screener_scan.py`
- Read: `hoga/api/queries.py`
- Read: `hoga/api/captures.py`
- Modify: `docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md`
- Create separate specs/plans only for gates that pass.

**Interfaces:**
- Consumes: development-corpus p95 and response/operator breakdowns.
- Produces: ranked follow-up backlog for screener, inventory, and capture history.

- [ ] **Step 1: Measure screener condition scaling**

Run 0/1/2/4/8 window conditions on the same development corpus, both full market and
watchlist scope. Capture DuckDB `EXPLAIN ANALYZE`.

Open a follow-up plan only if p95 exceeds 500ms and window operators account for at
least 40% of total. The plan should combine MA periods into one projection while keeping
row-by-row differential tests against the existing compiler.

- [ ] **Step 2: Measure inventory cardinality**

Record Stock-Date count, `/api/stock-dates` duration, response bytes, and filesystem
stat/open count. Open a manifest/pagination plan only if p95 exceeds 150ms or response
bytes exceed 5MB.

- [ ] **Step 3: Measure capture terminal history**

Record `_done` count, queue response p95, and bytes during normal sessions. Open a
history-separation plan only if p95 exceeds 100ms or response bytes exceed 5MB.

The follow-up design must keep retry/dedupe state separate from UI history; do not replace
`_done` with `deque(maxlen=...)` directly because current code deletes by index and
re-enqueues `pause_origin` rows.

- [ ] **Step 4: Rank passed gates by user impact**

Append:

```markdown
## Medium-priority backlog

| Rank | Workstream | User-visible symptom | Measured p95 | Cost driver | Next plan |
|---:|---|---|---:|---|---|
```

Only rows whose gates pass receive a next-plan link.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/measurements/2026-07-24-backend-performance/DECISION.md \
  docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: prioritize measured backend follow-ups"
```

---

### Task 10: Final Regression and Performance Review

**Files:**
- Verify all files changed by Tasks 1-4.
- Verify measurement and decision artifacts from Tasks 5-9.

**Interfaces:**
- Consumes: all completed tasks.
- Produces: green test suite, clean diff, and explicit list of approved follow-up plans.

- [ ] **Step 1: Run targeted backend tests**

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
```

Expected: all pass.

- [ ] **Step 2: Run the full backend suite**

```bash
uv run --extra dev pytest -q
```

Expected: at least the current baseline of 2,686 passed and 2 skipped, with no new
failures.

- [ ] **Step 3: Run Ruff only on changed Python files**

```bash
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
```

Expected: pass. Do not run automatic fixes across all `hoga/`.

- [ ] **Step 4: Verify the report contains no unsupported claims**

For each `GO`, verify:

```text
- raw result exists
- corpus and commit SHA are recorded
- p50 and p95 are present
- user-visible impact is stated
- rollback/NO-GO alternative is stated
- no unmeasured percentage improvement is promised
```

- [ ] **Step 5: Check the worktree**

```bash
git diff --check
git status --short
git log --oneline -10
```

Expected: no whitespace errors, no temporary benchmark files, no secret-bearing logs.

- [ ] **Step 6: Commit final documentation adjustments**

```bash
git add docs/superpowers/measurements docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: finalize backend performance improvement decisions"
```

Skip this commit if Task 10 produced no documentation changes.

---

## Expected User Experience Outcomes

이 플랜 자체가 약속하는 직접 개선은 다음과 같다.

1. 느린 요청은 TTFB뿐 아니라 실제 응답 완료 시간과 크기로 추적된다.
2. 장시간 사용 후 느려지는 현상이 LiveBuffer high-water, publish, drop 지표로 드러난다.
3. 과거 차트 콜드 지연은 현재 다계정 scheduler 조건에서 다시 측정되어, 이미 폐기한
   워밍·디스크 캐시를 습관적으로 되살리지 않는다.
4. 초기 보조지표 지연은 실제로 가장 비싼 slice 하나에만 개선 비용을 집중한다.
5. 기준을 넘지 않는 경로는 변경하지 않아 정합성·유지보수성 회귀를 피한다.

구조 개선 gate가 통과하면 후속 플랜의 UX acceptance는 다음을 포함해야 한다.

- 과거 팬: three-day cold p95 1,000ms 이하 또는 진행 UI가 1초 이상 정지하지 않음.
- 초기 sidecar: 60 Stock-Date p95 1,000ms 이하, 또는 캔들 first paint를 차단하지 않음.
- Live soak: retention 안정 뒤 RSS plateau, event-loop lag p99 50ms 이하.
- 오류·rate-limit·cache corruption에서도 빈 차트가 영구 고정되지 않음.
