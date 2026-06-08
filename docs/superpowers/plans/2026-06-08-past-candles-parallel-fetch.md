# past-candles 미캐시 날짜 병렬 fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/api/live/past-candles`의 미캐시 과거 날짜를 동시 5개로 병렬 fetch + (code, date) 싱글플라이트 — 콜드 캐시 3.3초 → ~0.7초, API 계약 무변경.

**Architecture:** `hoga/live/api.py`의 `_get_past_candles` 핸들러를 2-패스(1차: 캐시 분류 / 2차: Semaphore(5)+gather 병렬 fetch / 3차: today 순차 + 날짜순 조립)로 재구조화. 싱글플라이트는 `build_router` 스코프 공유 dict (ADR-0038 단일 워커 전제). Spec: `docs/superpowers/specs/2026-06-08-past-candles-parallel-fetch-design.md`.

**Tech Stack:** FastAPI + asyncio (Semaphore/Event/gather/create_task), pytest-asyncio, httpx.ASGITransport (동시 요청 테스트), 기존 `_TokenBucket`(15콜/초)은 무변경.

---

## 핵심 맥락 (구현자가 알아야 할 것)

- **핸들러 위치**: `hoga/live/api.py` `build_router()` 내부 `@router.get("/past-candles")` (현재 ~412행). 현재는 `for date_s in _date_iter(frm, too)` 루프에서 미캐시 날짜를 **하나씩 순차** `await kis.fetch_past_minute_candles(code, date_s)`.
- **레이트리밋 재시도는 이미 클라이언트 중앙화** (ADR-0050): `KisClient._get`이 4시도(1/2/4초) 후에만 `KisRateLimitError`를 표면화. 핸들러는 재시도하지 않는다.
- **`kis_blocked` 방어는 실제 장애의 수정분**: 레이트리밋 후 잔여 날짜 KIS 콜 중단 + **캐시 히트는 계속 서빙** (과거 "차트 빈 화면" 버그 — `test_past_candles_rate_limit_still_serves_later_cache_hits`가 핀).
- **⚠️ 의도된 계약 변경 1건**: 기존 테스트 `test_past_candles_rate_limit_aborts_remaining`은 순차 계약("실패 이후 날짜는 KIS 콜 0")을 핀한다. 병렬에서는 실패 시점에 이미 나간(in-flight) fetch가 존재하므로 spec §4.4가 계약을 "**미시작** fetch만 차단, in-flight는 완주"로 번역했다 — Task 1에서 이 테스트를 새 계약으로 **대체**한다(이름도 변경). 이웃 테스트(`..._still_serves_later_cache_hits`)는 1차 패스 구조상 무변경 그린.
- **테스트 인프라**: `tests/unit/live/test_api.py`의 `_past_app(tmp_path, fake_kis)` (140행 부근, `/api/live` 라우터만 마운트 — 스케줄러/캡처 부작용 없음) + `_FakeKisForPast`. 같은 파일에 추가한다.
- **today는 별도 의미론**: tri-state TTL 메모리 캐시(`cache.get_today_tri`) — 병렬화 제외, 기존 코드 그대로 3차 패스에 보존.

---

### Task 1: 병렬 fetch + kis_blocked 병렬 번역 (핸들러 재구조화)

**Files:**
- Modify: `hoga/live/api.py` (import 1줄 + 모듈 상수 + `build_router` 내 핸들러 교체)
- Test: `tests/unit/live/test_api.py` (신규 1개 + 기존 1개 대체)

- [ ] **Step 1: 동시성 테스트 작성 (신규)**

`tests/unit/live/test_api.py`의 `test_past_candles_rate_limit_aborts_remaining` 테스트 **위**에 추가:

```python
@pytest.mark.asyncio
async def test_past_candles_fetches_uncached_dates_concurrently(tmp_path) -> None:
    """spec 2026-06-08 §4: 미캐시 과거 날짜는 동시 fetch(상한 5) — 순차 구현은
    max_inflight==1이라 실패한다. 완료 순서를 의도적으로 뒤섞어(늦은 날짜가
    빨리 응답) 응답 candles의 날짜 오름차순 보장(§5 테스트 4)도 함께 핀한다."""
    import asyncio as _asyncio

    class _SlowFakeKis:
        def __init__(self):
            self.inflight = 0
            self.max_inflight = 0
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            self.calls.append(date_yyyymmdd)
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            try:
                # 늦은 날짜일수록 빨리 응답 → 완료 순서 ≠ 날짜 순서
                await _asyncio.sleep(0.05 - 0.005 * int(date_yyyymmdd[-1]))
                kst = datetime.timezone(datetime.timedelta(hours=9))
                y, m, d = (int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]),
                           int(date_yyyymmdd[6:8]))
                t_ms = int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000)
                return [KisCandle(t_ms=t_ms, open=100, high=110, low=95,
                                  close=105, volume=10)]
            finally:
                self.inflight -= 1

    fake = _SlowFakeKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260508")
        assert r.status_code == 200
        body = r.json()
    assert fake.max_inflight >= 2, "병렬화 안 됨 — 순차 fetch"
    assert fake.max_inflight <= 5, "동시 상한(_PAST_CANDLES_CONCURRENCY=5) 초과"
    t_list = [cd["t_ms"] for cd in body["candles"]]
    assert t_list == sorted(t_list), "응답 candles가 날짜 오름차순이 아님"
    assert body["fresh_dates"] == [f"2026050{i}" for i in range(1, 9)]
```

- [ ] **Step 2: 기존 abort 테스트를 새 계약으로 대체**

`test_past_candles_rate_limit_aborts_remaining` (~305행) 전체를 다음으로 **교체** (이름 변경 포함):

```python
@pytest.mark.asyncio
async def test_past_candles_rate_limit_blocks_unstarted_fetches(tmp_path) -> None:
    """병렬화(spec 2026-06-08 §4.4) 이후의 kis_blocked 계약: 레이트리밋 소진 시
    '아직 시작 안 한' fetch는 KIS를 더 두드리지 않고(rate_limit_aborted),
    이미 나간(in-flight) fetch는 완주해 결과를 서빙한다.
    (구 순차 계약 test_past_candles_rate_limit_aborts_remaining의 병렬 번역 —
    "실패 이후 날짜 KIS 콜 0"은 in-flight 회수가 불가능한 병렬에선 성립하지
    않으므로 "미시작 콜 0"으로 대체. '레이트리밋된 원격을 더 때리지 않는다'는
    원 의도는 보존된다.)

    결정성: 8날짜·슬롯 5 → D1-D5 동시 진입, D2가 0.01s에 실패(Event set은
    semaphore 해제보다 먼저 실행됨) → D6-D8은 슬롯 획득 시점에 Event를 보고
    스킵. D1·D3-D5는 0.1s sleep 중(in-flight)이라 완주."""
    from hoga.live.kis_client import KisRateLimitError
    import asyncio as _asyncio

    class _RateLimitedSlowKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            self.calls.append(date_yyyymmdd)
            if date_yyyymmdd == "20260502":
                await _asyncio.sleep(0.01)   # 첫 배치 중 가장 먼저 실패
                raise KisRateLimitError("EGW00201 rate limited")
            await _asyncio.sleep(0.1)        # 나머지 첫 배치는 실패 시점에 in-flight
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105,
                              volume=10)]

    fake = _RateLimitedSlowKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260508")
        assert r.status_code == 200
        body = r.json()
    # 미시작(D6-D8)은 KIS에 도달하지 않는다 — 원 방어의 핵심.
    assert sorted(fake.calls) == [
        "20260501", "20260502", "20260503", "20260504", "20260505",
    ]
    # in-flight 완주: 실패한 D2를 제외한 첫 배치 4건은 서빙된다.
    assert body["fresh_dates"] == [
        "20260501", "20260503", "20260504", "20260505",
    ]
    assert len(body["candles"]) == 4
    warns = {w["date"]: w["reason"] for w in body["data_warnings"]}
    assert warns["20260502"] == "kis_rate_limit"
    assert warns["20260506"] == warns["20260507"] == warns["20260508"] == "rate_limit_aborted"
```

- [ ] **Step 3: 두 테스트가 의도한 사유로 실패하는지 확인 (RED)**

Run: `uv run pytest tests/unit/live/test_api.py::test_past_candles_fetches_uncached_dates_concurrently tests/unit/live/test_api.py::test_past_candles_rate_limit_blocks_unstarted_fetches -q`

Expected: **2 failed** —
- concurrency 테스트: `AssertionError: 병렬화 안 됨 — 순차 fetch` (max_inflight==1)
- blocks_unstarted 테스트: `assert sorted(fake.calls) == [...]` 실패 — 순차 구현은 D2 실패 후 전부 abort라 `calls == ["20260501", "20260502"]`, `fresh_dates == ["20260501"]`

다른 사유(ImportError, fixture 오류 등)로 실패하면 테스트를 고친 뒤 재실행.

- [ ] **Step 4: 구현 — import + 상수**

`hoga/live/api.py` 4행 `import logging` 위에:

```python
import asyncio
```

`_PAST_MAX_DAYS = 250` (~30행) 아래에:

```python
# past-candles 미캐시 날짜 병렬 fetch 동시 상한 (spec 2026-06-08 §4.1).
# 산식: RTT ~200ms → 슬롯당 ~5콜/초 → 3슬롯이 토큰버킷(15콜/초, kis_client.
# _TokenBucket — 동시 acquirer 안전 설계) 포화점, +2는 RTT 변동 흡수 여유.
# 6+는 처리량 무이득(버킷이 천장)이고 EGW00201 시 동시 재시도(최대 동시수×4,
# ADR-0050)만 증폭. 운용: 로그에 kis_rate_limit/rate_limit_aborted가 자주
# 보이면 3으로 하향. 8 초과 금지 — 버킷 가득 시작이라 첫 순간 15콜 버스트
# 가능, KIS 통상 한도(인용 20/초) 대비 여유 25% 보존.
_PAST_CANDLES_CONCURRENCY = 5
```

- [ ] **Step 5: 구현 — build_router 스코프 세마포어**

`hoga/live/api.py`의 `cache_instance: PastCandlesCache | None = (...)` 블록 (~400행) 바로 아래에:

```python
    # past-candles 병렬 fetch의 총량 제어 — 라우터(=프로세스, ADR-0038 단일
    # 워커) 수준 공유: 동시 요청 2건이 떠도 KIS in-flight 합계 ≤ 5.
    _past_fetch_sem = asyncio.Semaphore(_PAST_CANDLES_CONCURRENCY)
```

(py3.11에서 `asyncio.Semaphore()`는 생성 시점에 루프를 바인딩하지 않고 첫
`acquire()`에서 lazy-bind한다 — 앱 생성 시점(루프 밖) 생성이 안전한 이유.
**주의**: `TestClient`는 핸들러를 자체 portal-스레드 루프에서 돌리므로 첫
사용이 그 루프가 된다. 만약 Step 3/7에서 "is bound to a different event
loop" 오류가 나면, 세마포어를 `build_router` 스코프 변수 `_past_fetch_sem:
asyncio.Semaphore | None = None`으로 두고 핸들러 안에서
`if _past_fetch_sem is None: _past_fetch_sem = asyncio.Semaphore(...)`로
lazy-init하는 폴백을 적용한다 — 라우터당 1회 생성이라 의미는 동일하다.)

- [ ] **Step 6: 구현 — 핸들러 본문 교체**

`_get_past_candles`의 본문 중 가드 3개(`get_kis_client is None` / `kis is None` / `cache_instance is None`)와 `cache = cache_instance`까지는 그대로 두고, 그 아래 `candles_all: list[dict] = []`부터 `return {...}` 직전까지(기존 날짜 루프 전체)를 다음으로 교체:

```python
        # ── 1차 패스(동기, KIS 콜 없음): 캐시 히트 수집 + 병렬 fetch 대상 분류.
        # 레이트리밋이 떠도 캐시 히트는 항상 서빙된다("차트 빈 화면" 방어가
        # KIS 경로와 분리된 이 패스에서 구조적으로 보존됨).
        rows: dict[str, list[dict]] = {}
        cached_dates: list[str] = []
        pending: list[str] = []           # 과거 미캐시 — 2차 패스(병렬) 대상
        warnings_by_date: dict[str, dict] = {}
        fresh: set[str] = set()

        for date_s in _date_iter(frm, too):
            if date_s >= today_s:
                continue  # today는 3차 패스에서 기존 의미론(순차 tri-state) 유지
            bars = cache.get_past(code, date_s)
            if bars is None:
                pending.append(date_s)
            else:
                rows[date_s] = bars
                cached_dates.append(date_s)

        # ── 2차 패스(병렬): Semaphore(5) + gather (spec 2026-06-08 §4) ──
        blocked = asyncio.Event()  # per-request — 레이트리밋 후 미시작 fetch 차단

        async def _one(date_s: str) -> None:
            async with _past_fetch_sem:
                # 슬롯 획득 후 확인: 레이트리밋 소진 시 '아직 시작 안 한' fetch는
                # KIS를 더 두드리지 않는다(구 kis_blocked의 병렬 번역, spec §4.4).
                # 이미 나간(in-flight) fetch는 완주 — 회수 불가한 요청이고 결과를
                # 버리는 것이 낭비다(spec §6). blocked.set()은 semaphore 해제보다
                # 먼저 실행되므로 후속 슬롯 획득자는 반드시 set 상태를 본다.
                if blocked.is_set():
                    warnings_by_date[date_s] = {
                        "date": date_s, "reason": "rate_limit_aborted",
                        "msg": "previous date hit rate limit",
                    }
                    return
                try:
                    raw = await kis.fetch_past_minute_candles(code, date_s)
                except KisRateLimitError as e:
                    blocked.set()
                    warnings_by_date[date_s] = {
                        "date": date_s, "reason": "kis_rate_limit", "msg": str(e),
                    }
                    return
                except KisApiError as e:
                    warnings_by_date[date_s] = {
                        "date": date_s, "reason": "kis_api_error", "msg": e.msg_cd,
                    }
                    return
                bars = [_candle_to_dict(c) for c in raw]
                rows[date_s] = bars
                fresh.add(date_s)
                try:
                    cache.store_past(code, date_s, bars)
                except OSError as e:
                    # 디스크 쓰기 실패(가득참/권한 등): bars는 메모리로 서빙하되
                    # warning으로 표면화(기존 의미론 유지).
                    warnings_by_date[date_s] = {
                        "date": date_s, "reason": "cache_write_failed", "msg": str(e),
                    }

        await asyncio.gather(*(_one(d) for d in pending))

        # ── 3차 패스: 날짜순 조립 + today(기존 코드 그대로 — 순차·tri-state) ──
        candles_all: list[dict] = []
        fresh_dates: list[str] = []
        warnings: list[dict] = []
        kis_blocked = blocked.is_set()

        for date_s in _date_iter(frm, too):
            if date_s < today_s:
                if date_s in rows:
                    candles_all.extend(rows[date_s])
                    if date_s in fresh:
                        fresh_dates.append(date_s)
                if date_s in warnings_by_date:
                    warnings.append(warnings_by_date[date_s])
                continue
            # today (date_s == today_s) — 과거 날짜의 레이트리밋이 막는 것 포함
            # 기존 의미론 그대로.
            try:
                state, today_bars = cache.get_today_tri(code)
                if state == "hit":
                    # tri-state invariant: "hit" implies today_bars is not None
                    assert today_bars is not None
                    bars = today_bars
                    cached_dates.append(date_s)
                elif state == "negative":
                    # Known non-trading day; skip KIS, no row to add.
                    bars = []
                else:  # miss
                    if kis_blocked:
                        warnings.append({
                            "date": date_s, "reason": "rate_limit_aborted",
                            "msg": "previous date hit rate limit",
                        })
                        continue
                    raw = await kis.fetch_past_minute_candles(code, date_s)
                    bars = [_candle_to_dict(c) for c in raw]
                    if bars:
                        cache.store_today(code, bars)
                        fresh_dates.append(date_s)
                    else:
                        # Negative cache: known non-trading day for today.
                        # Skip KIS for the TTL window.
                        cache.store_today(code, None)
                candles_all.extend(bars)
            except KisRateLimitError as e:
                warnings.append({"date": date_s, "reason": "kis_rate_limit", "msg": str(e)})
                kis_blocked = True
            except KisApiError as e:
                warnings.append({"date": date_s, "reason": "kis_api_error", "msg": e.msg_cd})
```

`return` dict는 무변경 (`code/from/to/candles/cached_dates/fresh_dates/data_warnings`).

- [ ] **Step 7: GREEN 확인 + 파일 전체 회귀**

Run: `uv run pytest tests/unit/live/test_api.py -q`
Expected: 전부 PASS — 특히 `test_past_candles_rate_limit_still_serves_later_cache_hits`(캐시 히트 서빙)와 `test_past_candles_today_memory_cache`(today tri-state)가 무수정 그린이어야 한다. 실패 시 구현을 고친다(테스트를 고치지 않는다).

추가 점검: `grep -n "fake.calls ==" tests/unit/live/test_api.py`로 **순서
있는 calls 단언**을 전수 확인한다. 병렬화는 fetch '시작' 순서(=생성 순서)만
보존하므로, fake가 `calls.append` **전에** await하는 테스트가 있다면 그
단언은 동작이 옳아도 순서가 뒤집힐 수 있다 — 그런 테스트만 `sorted(...)`
비교로 바꾼다(2026-06-08 advisor 검증에서 기존 2건은 안전 확인됨: 둘 다
append가 await보다 먼저다).

- [ ] **Step 8: 린트**

Run: `uv run ruff check hoga/live/api.py tests/unit/live/test_api.py`
Expected: 신규 위반 0 (기존 baseline 외).

- [ ] **Step 9: 커밋**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "feat(api): past-candles 미캐시 날짜 병렬 fetch (동시 5) — spec 2026-06-08 §4

순차 RTT 누적(콜드 3.3s)을 Semaphore(5)+gather로 병렬화. kis_blocked는
'미시작 fetch 차단 + in-flight 완주'로 번역(§4.4) — 기존 abort 테스트를
새 계약으로 대체. 캐시 히트 서빙·today tri-state 경로는 무변경.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: (code, date) 싱글플라이트

**Files:**
- Modify: `hoga/live/api.py` (`build_router` 스코프 dict + 공유 fetch 헬퍼, `_one`의 fetch 1줄 교체)
- Test: `tests/unit/live/test_api.py`

- [ ] **Step 1: 싱글플라이트 테스트 작성**

Task 1에서 추가한 concurrency 테스트 아래에:

```python
@pytest.mark.asyncio
async def test_past_candles_singleflight_dedups_concurrent_same_date(tmp_path) -> None:
    """spec 2026-06-08 §4.3: 같은 (code, date)의 동시 요청 2건 → KIS 콜 1회
    공유(두 탭/60초 refetch 경합의 쿼터 절약). 두 응답 모두 동일 bars를 받고
    후발 요청도 fresh로 보고한다(캐시가 아니라 공유 fetch 결과이므로)."""
    import asyncio as _asyncio
    import httpx

    class _SlowFakeKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            self.calls.append(date_yyyymmdd)
            await _asyncio.sleep(0.05)   # 두 요청의 fetch 창을 겹치게 한다
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105,
                              volume=10)]

    fake = _SlowFakeKis()
    app = _past_app(tmp_path, fake)
    transport = httpx.ASGITransport(app=app)
    url = "/api/live/past-candles?code=005930&from=20260501&to=20260501"
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r1, r2 = await _asyncio.gather(ac.get(url), ac.get(url))
    assert r1.status_code == 200 and r2.status_code == 200
    assert fake.calls == ["20260501"], "싱글플라이트 미동작 — 같은 날짜 중복 KIS 콜"
    assert r1.json()["candles"] == r2.json()["candles"]
    assert r1.json()["fresh_dates"] == r2.json()["fresh_dates"] == ["20260501"]
```

- [ ] **Step 2: RED 확인**

Run: `uv run pytest tests/unit/live/test_api.py::test_past_candles_singleflight_dedups_concurrent_same_date -q`
Expected: FAIL — `assert fake.calls == ["20260501"]`에서 `calls == ["20260501", "20260501"]` (Task 1 구현은 요청별로 각자 fetch).

- [ ] **Step 3: 구현 — 공유 fetch 헬퍼**

`hoga/live/api.py`의 `_past_fetch_sem = ...` (Task 1 Step 5) 아래에:

```python
    # 싱글플라이트(spec 2026-06-08 §4.3): 같은 (code, date)의 동시 fetch를 한
    # KIS 콜로 공유 — 두 탭/60초 refetch 경합의 쿼터 절약(파일 안전성은
    # atomic_write_json이 이미 보장하므로 목적이 아님). ADR-0038 단일 워커라
    # in-process dict로 충분. done_callback이 항상 entry를 회수한다.
    _past_inflight: dict[tuple[str, str], "asyncio.Task[tuple[list[dict], str | None]]"] = {}

    async def _fetch_past_shared(
        kis: "KisClient", code: str, date_s: str
    ) -> tuple[list[dict], str | None]:
        """(bars, cache_write_failed_msg) 반환. 진행 중인 동일 키 fetch가 있으면
        그 결과를 공유한다. 예외(KisRateLimitError 등)는 공유자 전원에 동일
        전파 — 각 요청의 except 분기가 각자 warning을 만든다."""
        key = (code, date_s)
        task = _past_inflight.get(key)
        if task is None:
            async def _do() -> tuple[list[dict], str | None]:
                raw = await kis.fetch_past_minute_candles(code, date_s)
                bars = [_candle_to_dict(c) for c in raw]
                try:
                    cache_instance.store_past(code, date_s, bars)  # type: ignore[union-attr]
                except OSError as e:
                    return bars, str(e)
                return bars, None

            task = asyncio.create_task(_do())
            _past_inflight[key] = task
            task.add_done_callback(lambda _t, k=key: _past_inflight.pop(k, None))
        return await task
```

(주의: `cache_instance`는 이 시점에 None일 수 있는 타입이지만, 핸들러가
503 가드 후에만 `_fetch_past_shared`를 호출하므로 type: ignore가 정확하다.
리더 요청이 취소돼도 `create_task`로 분리된 공유 task는 완주한다 — 후발
공유자가 영향받지 않는다.)

- [ ] **Step 4: 구현 — `_one`에서 헬퍼 사용**

Task 1 Step 6의 `_one` 내부에서 이 부분을:

```python
                try:
                    raw = await kis.fetch_past_minute_candles(code, date_s)
```

다음으로 교체하고:

```python
                try:
                    bars, write_err = await _fetch_past_shared(kis, code, date_s)
```

성공 경로의 이 부분을:

```python
                bars = [_candle_to_dict(c) for c in raw]
                rows[date_s] = bars
                fresh.add(date_s)
                try:
                    cache.store_past(code, date_s, bars)
                except OSError as e:
                    # 디스크 쓰기 실패(가득참/권한 등): bars는 메모리로 서빙하되
                    # warning으로 표면화(기존 의미론 유지).
                    warnings_by_date[date_s] = {
                        "date": date_s, "reason": "cache_write_failed", "msg": str(e),
                    }
```

다음으로 교체:

```python
                rows[date_s] = bars
                fresh.add(date_s)
                if write_err is not None:
                    # 디스크 쓰기 실패(가득참/권한 등): bars는 메모리로 서빙하되
                    # warning으로 표면화(기존 의미론 유지 — 공유 fetch라 공유자
                    # 전원이 같은 warning을 받는다).
                    warnings_by_date[date_s] = {
                        "date": date_s, "reason": "cache_write_failed", "msg": write_err,
                    }
```

- [ ] **Step 5: GREEN + 파일 전체 회귀**

Run: `uv run pytest tests/unit/live/test_api.py -q`
Expected: 전부 PASS.

- [ ] **Step 6: 커밋**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "feat(api): past-candles (code,date) 싱글플라이트 — spec 2026-06-08 §4.3

동시 요청(두 탭·60초 refetch 경합)의 같은 날짜 중복 KIS 콜을 공유 task로
제거. ADR-0038 단일 워커 전제의 in-process dict, done_callback 회수.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 전체 회귀 + spec 상태 갱신

**Files:**
- Modify: `docs/superpowers/specs/2026-06-08-past-candles-parallel-fetch-design.md` (Status 1줄)

- [ ] **Step 1: 전체 테스트 스위트**

Run: `uv run pytest -q`
Expected: 전부 PASS (기준선: 1305 passed, 4 skipped — 스킵 4건은 기존 WS 녹화 fixture skipif로 본 작업과 무관).

- [ ] **Step 2: 린트 최종 확인**

Run: `uv run ruff check hoga/live/api.py tests/unit/live/test_api.py`
Expected: 신규 위반 0.

- [ ] **Step 3: spec 상태 갱신**

spec 파일의 `- **Status**: Approved ...` 줄을 다음으로 교체:

```markdown
- **Status**: Implemented (2026-06-08) — 성능 목표(3.3s→~0.7s)는 실서버 콜드 캐시 1회 실측 후 PR 본문에 기록
```

- [ ] **Step 4: 커밋**

```bash
git add docs/superpowers/specs/2026-06-08-past-candles-parallel-fetch-design.md
git commit -m "docs(spec): past-candles 병렬 fetch Status → Implemented

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
