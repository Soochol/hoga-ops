# /live 분봉 과거 백필 성능 개선 (실측 → 워밍 → read-ahead) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /live 분봉 차트에서 과거로 팬할 때 캔들이 뜨는 체감 속도를, 인터랙션 시점의 KIS 왕복을 캐시 히트로 바꾸는 두 겹(종목 선택 시 선행 워밍 + 요청 시 read-ahead)으로 개선한다.

**Architecture:** 기존 뼈대(날짜 단위 불변 캐시, KIS 캐퍼시티 스케줄러의 background 우선순위 레인, 프론트 델타 fetch)는 그대로 두고, `LiveMinuteCandleBackfill`에 background 우선순위로 도는 단일 비행(single-flight) 워밍 경로를 추가한다. ① 프론트가 종목 활성화 시 `POST /api/live/warm-past-candles`를 fire-and-forget으로 쏘고, ② `/api/live/past-candles`가 요청 구간 직전 동일 폭 구간을 background로 선행 워밍(read-ahead)한다. 전후 실측으로 효과를 수치화하고, 남은 병목이 `/api/range`(호가) 쪽이면 "프리펜드 API 경계 통합"을 별도 플랜으로 진행할지 결정한다.

**Tech Stack:** FastAPI + asyncio (백엔드), React + TanStack Query + vitest (프론트), pytest(`uv run --extra dev`), KIS Open API (FHKST03010230), gstack `/browse` (실측 도그푸딩).

**Scope note (경계 통합 제외 사유):** 논의된 4단계 중 "프리펜드 API 경계 통합"(`past-candles`+`/api/range` 단일 응답화, useLiveBundle 원자화 게이트 제거)은 별도 서브시스템 규모의 변경이라 이 플랜에서 제외한다. Task 1의 실측과 Task 8의 사후 실측이 그 투자를 정당화하는지 판단하는 결정 게이트다.

**전제:** 리포 루트 `.env`에 `KIS_APP_KEY`/`KIS_APP_SECRET` 필요(워크트리는 메인 체크아웃 `.env`를 상속). 과거 분봉 fetch는 장외 시간에도 동작한다.

---

## 배경: 현재 데이터 흐름 (실행자가 알아야 할 최소한)

- 좌측 팬 → `useViewportBackfill` 3b가 `historicalFromDate`를 5캘린더일 확장 → `useLivePastCandles`가 미보유 날짜 구간만 `/api/live/past-candles`로 델타 요청.
- 백엔드 `LiveMinuteCandleBackfill._collect_for_venue`가 날짜별 디스크 캐시(`PastCandlesCache`, 키=(venue, code, date)) 확인 → 미스 날짜만 KIS 호출. KIS 분봉 API는 1회 최대 120행이라 하루당 순차 ~4회 호출.
- 모든 KIS REST는 `kis_access.run_with_capacity(priority="user_visible"|"background")`를 거친다. background는 foreground 대기자에게 토큰을 양보하되 굶지 않는다(ADR-0087).
- 지난 거래일 분봉은 불변 → 한 번 캐시되면 영원히 히트. **따라서 "느림"은 캐시 미스에서만 발생하고, 미스를 인터랙션 이전에 채우는 것이 이 플랜의 전부다.**

---

### Task 1: 사전 실측 — 청크당 지연을 KIS vs /api/range로 분해

코드 변경 없음. 개선 전 기준선(baseline)을 수치로 기록한다.

**Files:**
- Create: `docs/superpowers/plans/2026-07-07-live-minute-backfill-measurements.md`

- [ ] **Step 1: 백엔드를 perf 로그 켜고 기동**

```bash
HOGA_PERF_DEBUG=1 uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

run_in_background로 실행. 헬스체크는 curl이 아니라 venv python으로(이 환경에서 curl이 간헐 실패):

```bash
.venv/bin/python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').status)"
```

Expected: `200`

- [ ] **Step 2: 프론트 기동 + 브라우저 perf 플래그 설정**

```bash
cd frontend && npm run dev   # http://localhost:5173
```

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B js "localStorage.setItem('hoga.perf.debug','1')"
$B js "location.reload()"
```

- [ ] **Step 3: 캐시 미스 종목으로 좌측 팬 시나리오 실행**

이전에 열어본 적 없는 종목(캐시 미스 보장)을 골라 탭을 연다. 1분봉 상태에서 좌측으로 여러 청크 팬한다(스크립트로 드래그가 어려우면 사용자에게 수동 팬을 요청하고 로그만 수집해도 된다).

- [ ] **Step 4: 로그 수집**

프론트(청크 트리거·API별 소요):

```bash
$B console | grep "hoga-perf"
```

`viewport_backfill_extend`(청크 dispatch 시각), `api_call`의 `path=/api/live/past-candles`와 `path=/api/range`별 `durationMs`를 뽑는다.

백엔드(KIS 호출 단위 소요) — uvicorn 로그에서:

```
hoga_perf past_candles_fetch status=ok ... duration_ms=...
hoga_perf past_candles_collect ... pending_dates=N ... duration_ms=...
```

- [ ] **Step 5: 기준선 기록 문서 작성**

`docs/superpowers/plans/2026-07-07-live-minute-backfill-measurements.md`에 아래 템플릿으로 기록:

```markdown
# /live 분봉 백필 실측

## 사전 (baseline, YYYY-MM-DD)
- 종목/조건: <code>, 1m, 캐시 미스, 좌측 팬 N청크
- 청크당 /api/live/past-candles durationMs: [..., ...] (중앙값 X ms)
- 청크당 /api/range durationMs: [..., ...] (중앙값 Y ms)
- KIS past_candles_fetch(하루 단위) duration_ms: [..., ...] (중앙값 Z ms)
- 청크 dispatch → 캔들 표시 체감: <관찰>
- 병목 판정: past-candles / api-range / 반반

## 사후 (warm + read-ahead 적용 후)
- (Task 8에서 채움)
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-07-07-live-minute-backfill-measurements.md
git commit -m "docs(live): 분봉 백필 사전 실측 기준선 기록"
```

---

### Task 2: 백엔드 — priority 스레딩 + `warm_minute` (background 워밍 코어)

`LiveMinuteCandleBackfill`에 background 우선순위로 미캐시 과거 날짜를 순차 fetch하는 supervised 단일 비행 워밍을 추가한다. 날짜 내부가 이미 순차 ~4콜이므로 워밍은 날짜도 순차로 돌아(동시성 1) 사용자 경로의 세마포어(3)와 경합하지 않는다.

**Files:**
- Modify: `hoga/live/live_candle_backfill.py` (`__init__`, `_fetch_past_shared`, `_fetch_past_scheduled`, 새 메서드 `warm_minute`/`_warm_run`)
- Test: `tests/unit/live/test_live_candle_backfill.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/live/test_live_candle_backfill.py` 상단 import에 `import asyncio` 추가 후, 파일 끝에 추가:

```python
@pytest.mark.asyncio
async def test_warm_minute_fetches_uncached_dates_at_background_priority(
    tmp_path, monkeypatch,
) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler, concurrency=1,
    )

    status = await backfill.warm_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 19),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )
    task = backfill._warm_tasks[("KRX", "005930")]
    await task

    assert status == "started"
    assert [c["priority"] for c in scheduler.calls] == ["background", "background"]
    assert cache.get_past("KRX", "005930", "20260518") is not None
    assert cache.get_past("KRX", "005930", "20260519") is not None


@pytest.mark.asyncio
async def test_warm_minute_single_flight_per_venue_code(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    release = asyncio.Event()

    class _BlockedScheduler:
        async def submit(self, *, key, endpoint, priority, call, cooldown_scope=None):
            await release.wait()
            return await call(_FakeKis())  # type: ignore[arg-type]

    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_BlockedScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )
    common = dict(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    first = await backfill.warm_minute(**common)
    second = await backfill.warm_minute(**common)
    task = backfill._warm_tasks[("KRX", "005930")]
    release.set()
    await task

    assert (first, second) == ("started", "already_running")


@pytest.mark.asyncio
async def test_warm_minute_skips_cached_and_today(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("KRX", "005930", "20260518", [])
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler, concurrency=1,
    )

    await backfill.warm_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 20),  # 5/20 == today → 제외
        today_d=dt.date(2026, 5, 20),
        policy="KRX",
    )
    await backfill._warm_tasks[("KRX", "005930")]

    # 캐시된 5/18과 today 5/20은 건너뛰고 5/19만 fetch
    assert [c["key"] for c in scheduler.calls] == [
        ("live-candle-backfill", "minute", "KRX", "005930", "20260519"),
    ]


@pytest.mark.asyncio
async def test_warm_minute_stops_on_rate_limit(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal
    from hoga.live.kis_client import KisRateLimitError

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)

    class _RateLimitedScheduler:
        def __init__(self) -> None:
            self.count = 0

        async def submit(self, **_kwargs):
            self.count += 1
            raise KisRateLimitError("rate limit")

    scheduler = _RateLimitedScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    await backfill.warm_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 22),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )
    await backfill._warm_tasks[("KRX", "005930")]

    assert scheduler.count == 1  # 첫 레이트리밋에서 즉시 중단, 나머지 날짜 시도 금지
    assert backfill._rate_limited_now() is True
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py -q -k warm_minute
```

Expected: 4 FAIL — `AttributeError: ... has no attribute 'warm_minute'`

- [ ] **Step 3: 구현**

`hoga/live/live_candle_backfill.py` 변경 3곳:

(a) `__init__` 끝에 워밍 태스크 레지스트리 추가 (`self._rate_limit_until = 0.0` 아래):

```python
        self._warm_tasks: dict[tuple[KisVenue, str], asyncio.Task[None]] = {}
```

(b) `_fetch_past_shared` / `_fetch_past_scheduled`에 priority 스레딩 — 기존 두 메서드를 다음으로 교체:

```python
    async def _fetch_past_shared(
        self,
        venue: KisVenue,
        code: str,
        date_s: str,
        *,
        priority: kis_access.KisRequestPriority = "user_visible",
    ) -> tuple[list[dict], str | None]:
        # 단일 비행 키는 priority를 포함하지 않는다: warm(background)이 먼저 띄운
        # 태스크에 사용자 요청이 올라타면 background 우선순위로 대기하게 되지만,
        # ADR-0087의 background 비굶주림 보장으로 진전은 유지된다. 반대 방향
        # (user_visible 태스크에 warm이 올라탐)은 순수 이득.
        key = (venue, code, date_s)
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(
                self._fetch_past_scheduled(venue, code, date_s, priority=priority)
            )
            self._inflight[key] = task
            task.add_done_callback(lambda _t, k=key: self._inflight.pop(k, None))
        return await task

    async def _fetch_past_scheduled(
        self,
        venue: KisVenue,
        code: str,
        date_s: str,
        *,
        priority: kis_access.KisRequestPriority = "user_visible",
    ) -> tuple[list[dict], str | None]:
        t0 = perf_debug.now()
        try:
            result = await kis_access.run_with_capacity(
                self._scheduler,
                data_dir=self._data_dir,
                key=("live-candle-backfill", "minute", venue, code, date_s),
                endpoint=kis_access.KisRestEndpoint.PAST_MINUTE,
                priority=priority,
                cooldown_scope=venue,
                fetch_fn=lambda kis: self._fetch_past_once(kis, venue, code, date_s),
            )
        except Exception:
            if perf_debug.enabled():
                log.warning(
                    "hoga_perf past_candles_fetch status=error code=%s venue=%s date=%s "
                    "duration_ms=%.1f",
                    code, venue, date_s, perf_debug.elapsed_ms(t0),
                )
            raise
        if perf_debug.enabled():
            log.warning(
                "hoga_perf past_candles_fetch status=ok code=%s venue=%s date=%s "
                "candles=%d cache_write_error=%s duration_ms=%.1f",
                code,
                venue,
                date_s,
                len(result[0]),
                result[1] is not None,
                perf_debug.elapsed_ms(t0),
            )
        return result
```

(변경점은 `priority` 파라미터 추가와 `run_with_capacity`의 `priority=priority` 뿐 — perf 로그 블록은 기존 그대로.)

(c) `collect_minute_cache_only` 위(또는 클래스 내 아무 일관된 위치)에 새 메서드 2개 추가:

```python
    async def warm_minute(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
    ) -> str:
        """[frm, too]의 미캐시 과거 날짜를 background 우선순위로 순차 fetch해
        캐시를 데운다(fire-and-forget). (venue, code)별 단일 비행;
        "started" | "already_running" 반환. 태스크는 supervised — 실패는
        로그로 남고 침묵 사망하지 않는다(ADR-0088).

        일부러 순차(동시성 1): 워밍이 사용자 경로의 세마포어(3)나 KIS 예산을
        점유하지 않게 한다. KRX 폴백은 하지 않는다 — 폴백이 필요한 날짜는
        인터랙션 경로의 collect_minute가 그때 처리한다."""
        key = (policy, code)
        existing = self._warm_tasks.get(key)
        if existing is not None and not existing.done():
            return "already_running"
        task = asyncio.create_task(
            self._warm_run(policy, code, frm=frm, too=too, today_d=today_d),
            name=f"live-candle-warm:{policy}:{code}",
        )
        self._warm_tasks[key] = task

        def _done(t: asyncio.Task, k: tuple[KisVenue, str] = key) -> None:
            self._warm_tasks.pop(k, None)
            if t.cancelled():
                return
            exc = t.exception()
            if exc is not None:
                log.warning(
                    "live candle warm failed venue=%s code=%s: %s", k[0], k[1], exc,
                )

        task.add_done_callback(_done)
        return "started"

    async def _warm_run(
        self,
        venue: KisVenue,
        code: str,
        *,
        frm: date,
        too: date,
        today_d: date,
    ) -> None:
        today_s = today_d.strftime("%Y%m%d")
        for date_s in _date_iter(frm, too):
            if date_s >= today_s:
                continue
            if self._cache.get_past(venue, code, date_s) is not None:
                continue
            if trading_calendar.is_trading_day(date_s) is False:
                self._cache.store_past(venue, code, date_s, [])
                continue
            if self._rate_limited_now():
                return
            try:
                await self._fetch_past_shared(venue, code, date_s, priority="background")
            except KisRateLimitError:
                self._mark_rate_limited()
                return
            except (KisCapacityCooldown, KisCapacityOverloaded, KisApiError):
                # 워밍은 best-effort: 이 날짜는 인터랙션 경로가 나중에 다시 시도.
                continue
```

- [ ] **Step 4: 테스트 통과 확인 (기존 회귀 포함)**

```bash
uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py -q
```

Expected: 전부 PASS (기존 첫 테스트의 `"priority": "user_visible"` 단언이 priority 스레딩의 회귀 가드)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/live_candle_backfill.py tests/unit/live/test_live_candle_backfill.py
git commit -m "feat(live): 분봉 백필에 background 단일비행 워밍(warm_minute) 추가"
```

---

### Task 3: 백엔드 — `POST /api/live/warm-past-candles` 라우트

**Files:**
- Modify: `hoga/live/api.py` (상수 1개 + `/past-candles` 라우트 아래에 라우트 1개)
- Test: `tests/api/test_live_warm_past_candles_route.py` (신규)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/api/test_live_warm_past_candles_route.py` 생성:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import lifecycle
from hoga.live.api import build_router


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status))
    return TestClient(app)


def test_warm_route_422_on_bad_code() -> None:
    r = _client().post("/api/live/warm-past-candles?code=abc")
    assert r.status_code == 422


def test_warm_route_422_on_bad_venue() -> None:
    r = _client().post("/api/live/warm-past-candles?code=005930&venue=NASDAQ")
    assert r.status_code == 422


def test_warm_route_503_when_cache_not_wired() -> None:
    # data_dir 미배선 → minute_backfill None → 503 (기존 /past-candles와 동일 계약)
    r = _client().post("/api/live/warm-past-candles?code=005930")
    assert r.status_code == 503
```

(참고: `build_router(get_status=...)`만 넘기는 구성은 `tests/api/test_live_indices_routes.py`의 `_client()`와 동일 패턴. 만약 `build_router` 시그니처상 이 호출이 안 되면 그 파일의 `_client()`를 그대로 복사해 맞춘다.)

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
uv run --extra dev pytest tests/api/test_live_warm_past_candles_route.py -q
```

Expected: FAIL — 404 (라우트 없음) 로 422/503 단언 실패

- [ ] **Step 3: 구현**

`hoga/live/api.py`:

(a) 모듈 상수 — `_PAST_CANDLES_RATE_LIMIT_COOLDOWN_S = 10.0` (line ~88) 아래에 추가:

```python
# 종목 활성화 시 선행 워밍 창(캘린더일). ~40거래일 ≈ 160 KIS 콜 ≈ 11초의
# background 예산 — foreground 양보(ADR-0087) 하에서 무해한 크기.
_WARM_PAST_CANDLES_CALENDAR_DAYS = 60
```

(b) `_get_past_candles` 라우트 바로 아래에 추가 (`minute_backfill`, `data_dir`, `_kis_scheduler`, `_has_kis_capacity_candidate`, `_CODE_RE`, `_today_kst_date`는 이미 해당 스코프에 있음):

```python
    @router.post("/warm-past-candles")
    async def _post_warm_past_candles(
        code: str = Query(...),
        venue: str | None = Query("KRX"),
    ) -> dict:
        """종목 활성화 시 과거 분봉 캐시를 background로 데운다(fire-and-forget).

        인터랙션 경로(/past-candles)와 달리 실패해도 무해 — 응답은 워밍
        시작 여부만 알린다. KIS 불가 상태는 503이 아니라 status로 알린다
        (프론트가 조용히 무시하는 best-effort 계약)."""
        if not _CODE_RE.match(code):
            raise HTTPException(
                422, {"code": "invalid_code", "msg": "code must be 6 digits"},
            )
        try:
            policy = parse_live_venue_policy(venue)
        except ValueError as e:
            raise HTTPException(422, {"code": "invalid_venue", "msg": str(e)}) from e
        if minute_backfill is None:
            raise HTTPException(503, "past-candles cache not wired (data_dir missing)")
        if data_dir is not None and kis_access.kis_rest_bypass_enabled(data_dir):
            return {"code": code, "venue": policy, "status": "bypassed"}
        if _kis_scheduler is None or not _has_kis_capacity_candidate():
            return {"code": code, "venue": policy, "status": "kis_unavailable"}
        today_d = _today_kst_date()
        frm = today_d - timedelta(days=_WARM_PAST_CANDLES_CALENDAR_DAYS)
        too = today_d - timedelta(days=1)
        status = await minute_backfill.warm_minute(
            code=code, frm=frm, too=too, today_d=today_d, policy=policy,
        )
        return {
            "code": code,
            "venue": policy,
            "from": frm.strftime("%Y%m%d"),
            "to": too.strftime("%Y%m%d"),
            "status": status,
        }
```

(`timedelta`는 `hoga/live/api.py`에 이미 import되어 있음: `from datetime import date, datetime, time, timedelta, timezone`.)

- [ ] **Step 4: 테스트 통과 확인**

```bash
uv run --extra dev pytest tests/api/test_live_warm_past_candles_route.py tests/unit/live/test_live_candle_backfill.py -q
```

Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/live/api.py tests/api/test_live_warm_past_candles_route.py
git commit -m "feat(live): POST /api/live/warm-past-candles 워밍 라우트 추가"
```

---

### Task 4: 프론트 — `useWarmPastCandles` 훅 + LivePage 배선

**Files:**
- Create: `frontend/src/api/liveWarmPastCandles.ts`
- Test: `frontend/src/api/liveWarmPastCandles.test.tsx` (신규)
- Modify: `frontend/src/live/LivePage.tsx` (import 1줄 + 훅 호출 1줄)

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/api/liveWarmPastCandles.test.tsx` 생성:

```tsx
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWarmPastCandles } from './liveWarmPastCandles';
import { apiAction } from './client';

vi.mock('./client', () => ({ apiAction: vi.fn().mockResolvedValue(undefined) }));

describe('useWarmPastCandles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('디바운스 후 워밍 요청을 1회 쏜다', () => {
    renderHook(() => useWarmPastCandles('005930', 'KRX'));
    expect(apiAction).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(apiAction).toHaveBeenCalledTimes(1);
    expect(apiAction).toHaveBeenCalledWith(
      '/api/live/warm-past-candles?code=005930&venue=KRX',
      { method: 'POST' },
    );
  });

  it('code가 null이면 아무것도 하지 않는다', () => {
    renderHook(() => useWarmPastCandles(null, 'KRX'));
    vi.advanceTimersByTime(5000);
    expect(apiAction).not.toHaveBeenCalled();
  });

  it('빠른 탭 전환은 마지막 code로 합쳐진다', () => {
    const { rerender } = renderHook(
      ({ code }: { code: string }) => useWarmPastCandles(code, 'KRX'),
      { initialProps: { code: '005930' } },
    );
    vi.advanceTimersByTime(500);
    rerender({ code: '000660' });
    vi.advanceTimersByTime(1500);
    expect(apiAction).toHaveBeenCalledTimes(1);
    expect(apiAction).toHaveBeenCalledWith(
      '/api/live/warm-past-candles?code=000660&venue=KRX',
      { method: 'POST' },
    );
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd frontend && npx vitest run src/api/liveWarmPastCandles.test.tsx
```

Expected: FAIL — `Cannot find module './liveWarmPastCandles'`

- [ ] **Step 3: 훅 구현**

`frontend/src/api/liveWarmPastCandles.ts` 생성:

```ts
import { useEffect } from 'react';

import { apiAction } from './client';
import type { LiveVenueOption } from '../state/liveVenue';

/** 빠른 탭 전환이 워밍 요청을 스팸하지 않게 하는 트레일링 디바운스.
 * 백엔드 warm_minute의 (venue, code) 단일 비행이 2차 방어선. */
const WARM_DEBOUNCE_MS = 1500;

/** 종목 활성화 시 과거 분봉 캐시 워밍을 fire-and-forget으로 요청한다.
 * 실패는 삼킨다 — 워밍은 best-effort이고, 놓친 날짜는 사용자가 팬할 때
 * 인터랙션 경로(/past-candles)가 어차피 같은 캐시를 채운다. */
export function useWarmPastCandles(code: string | null, venue: LiveVenueOption): void {
  useEffect(() => {
    if (!code) return;
    const id = setTimeout(() => {
      void apiAction(`/api/live/warm-past-candles?code=${code}&venue=${venue}`, {
        method: 'POST',
      }).catch(() => undefined);
    }, WARM_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [code, venue]);
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd frontend && npx vitest run src/api/liveWarmPastCandles.test.tsx
```

Expected: 3 PASS

- [ ] **Step 5: LivePage 배선**

`frontend/src/live/LivePage.tsx`:

import 블록에 추가:

```ts
import { useWarmPastCandles } from '../api/liveWarmPastCandles';
```

`const liveVenue = useLiveVenueStore((s) => s.venue);` (line ~135) 바로 아래에 추가:

```ts
  // 종목 활성화 시 과거 분봉 캐시 선행 워밍 — 좌측 팬의 KIS 왕복을 캐시 히트로.
  useWarmPastCandles(activeCode, liveVenue);
```

- [ ] **Step 6: 프론트 게이트 실행**

```bash
cd frontend && npx vitest run src/live/LivePage.test.tsx src/api/liveWarmPastCandles.test.tsx && npx tsc -b
```

Expected: 전부 PASS, tsc 에러 0. (참고: `npm run lint` 전체는 기존 부채 ~143건으로 원래 빨강 — 변경 파일에만 eslint를 스코프해 0 에러 확인: `npx eslint src/api/liveWarmPastCandles.ts src/api/liveWarmPastCandles.test.tsx src/live/LivePage.tsx`)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/liveWarmPastCandles.ts frontend/src/api/liveWarmPastCandles.test.tsx frontend/src/live/LivePage.tsx
git commit -m "feat(live): 종목 활성화 시 과거 분봉 캐시 선행 워밍 훅 배선"
```

---

### Task 5: 백엔드 — `/past-candles` read-ahead (요청 직전 구간 선행 워밍)

사용자가 청크 N을 요청하면 청크 N-1(직전 동일 폭 구간)을 background로 미리 데운다. `useViewportBackfill`의 settle-loop가 다음 스텝을 dispatch할 때 캐시 히트가 되는 효과 — 프론트 무변경 파이프라이닝.

**Files:**
- Modify: `hoga/live/live_candle_backfill.py` (`collect_minute` 래핑)
- Modify: `hoga/live/api.py` (`_get_past_candles` 호출부)
- Test: `tests/unit/live/test_live_candle_backfill.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/live/test_live_candle_backfill.py`에 추가:

```python
@pytest.mark.asyncio
async def test_collect_minute_read_ahead_warms_preceding_window(
    tmp_path, monkeypatch,
) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler, concurrency=1,
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 20),
        too=dt.date(2026, 5, 21),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
        read_ahead=True,
    )
    task = backfill._warm_tasks.get(("KRX", "005930"))
    assert task is not None
    await task

    # 요청창 5/20-21은 user_visible, 선행창 5/18-19는 background
    priorities = [c["priority"] for c in scheduler.calls]
    assert priorities.count("user_visible") == 2
    assert priorities.count("background") == 2
    assert cache.get_past("KRX", "005930", "20260518") is not None
    assert cache.get_past("KRX", "005930", "20260519") is not None


@pytest.mark.asyncio
async def test_collect_minute_read_ahead_respects_earliest_allowed(
    tmp_path, monkeypatch,
) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,
        concurrency=1,
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 20),
        too=dt.date(2026, 5, 21),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
        read_ahead=True,
        earliest_allowed=dt.date(2026, 5, 20),  # 선행창 전체가 하한 밖 → 워밍 없음
    )

    assert ("KRX", "005930") not in backfill._warm_tasks
    assert all(c["priority"] == "user_visible" for c in scheduler.calls)


@pytest.mark.asyncio
async def test_collect_minute_default_no_read_ahead(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,
        concurrency=1,
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 20),
        too=dt.date(2026, 5, 21),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert ("KRX", "005930") not in backfill._warm_tasks
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py -q -k read_ahead
```

Expected: FAIL — `TypeError: collect_minute() got an unexpected keyword argument 'read_ahead'`

- [ ] **Step 3: 구현**

`hoga/live/live_candle_backfill.py`:

(a) 기존 `collect_minute` 메서드를 **이름만** `_collect_minute_inner`로 바꾼다(본문·시그니처 그대로).

(b) 그 위에 새 `collect_minute` 래퍼를 추가:

```python
    async def collect_minute(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
        read_ahead: bool = False,
        earliest_allowed: date | None = None,
    ) -> LiveMinuteCandleBackfillResult:
        out = await self._collect_minute_inner(
            code=code, frm=frm, too=too, today_d=today_d, policy=policy,
        )
        # read-ahead: 이번 요청창 직전 동일 폭 구간을 background로 선행 워밍.
        # settle-loop의 다음 청크가 캐시 히트가 된다. 레이트리밋/용량 경고가
        # 있으면 예산이 이미 부족하다는 뜻이므로 이번엔 건너뛴다.
        if read_ahead and not _fallback_blocking_warning_dates(out.data_warnings):
            span_days = (too - frm).days + 1
            ra_too = frm - timedelta(days=1)
            ra_frm = ra_too - timedelta(days=span_days - 1)
            if earliest_allowed is not None:
                ra_frm = max(ra_frm, earliest_allowed)
            if ra_frm <= ra_too:
                await self.warm_minute(
                    code=code, frm=ra_frm, too=ra_too, today_d=today_d, policy=policy,
                )
        return out
```

(c) `_collect_minute_inner` 본문 안의 재귀 없음 확인 — 내부는 `_collect_for_venue`만 호출하므로 이름 변경 외 수정 불필요.

(d) `hoga/live/api.py`의 `_get_past_candles`에서 호출부를 다음으로 교체:

```python
        out = await minute_backfill.collect_minute(
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
            policy=policy,
            read_ahead=True,
            earliest_allowed=today_d - timedelta(days=_PAST_MAX_DAYS - 1),
        )
```

(`_PAST_MAX_DAYS`는 `_validate_past_request`의 기본 캡과 같은 모듈 상수 — 프론트 `earliestAllowedMinuteDate`의 250일 클램프와 같은 하한이라 워밍이 스크롤 불가 영역을 데우지 않는다.)

- [ ] **Step 4: 테스트 통과 확인 (전체 회귀)**

```bash
uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py tests/api/test_live_warm_past_candles_route.py -q
```

Expected: 전부 PASS (기존 collect_minute 테스트들은 kwargs 기본값 덕에 무수정 통과)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/live_candle_backfill.py hoga/live/api.py tests/unit/live/test_live_candle_backfill.py
git commit -m "feat(live): past-candles 요청 직전 구간 read-ahead 선행 워밍"
```

---

### Task 6: ADR 작성

**Files:**
- Create: `docs/adr/0090-live-minute-backfill-warm-and-read-ahead.md`
  (작성 전 `ls docs/adr/ | tail -3`으로 0090이 여전히 다음 번호인지 확인 — 선점됐으면 다음 빈 번호 사용, 본문 내 번호도 함께 수정)

- [ ] **Step 1: ADR 작성**

```markdown
# ADR-0090: /live 분봉 백필 — 선행 워밍 + read-ahead (인터랙션-결합 해소)

## Status

Accepted (2026-07-07)

## Context

/live 분봉에서 과거로 팬하면 캔들이 늦게 뜬다. 원인은 파라미터가 아니라 결합
구조다: 데이터 가용성이 뷰포트 인터랙션에 결합되어, 팬하는 순간에 KIS 왕복
(하루당 순차 ~4콜, 120행/콜 캡)을 지불한다. settle-loop(useViewportBackfill 3a)는
청크를 직렬로 진행하므로 채우기 시간은 청크 수에 선형이다.

지난 거래일 분봉은 불변이라 (venue, code, date) 캐시는 한 번 채우면 영원히
히트한다. 시스템은 어떤 종목을 보게 될지(활성 탭)와 다음에 어떤 구간을 요청할지
(직전 청크) 이미 알고 있고, background 우선순위 레인(ADR-0087)도 이미 있다.
즉 예측 가능한 수요를 선지불할 부품이 모두 있었다.

## Decision

두 겹의 선행 캐시 채움을 추가한다. 둘 다 기존 뼈대(날짜 캐시, 캐퍼시티 스케줄러,
프론트 델타 fetch) 무변경 위에 얹힌다.

1. **종목 활성화 워밍**: 프론트가 활성 종목 변경 시(1.5s 디바운스)
   `POST /api/live/warm-past-candles`를 fire-and-forget으로 호출. 백엔드
   `LiveMinuteCandleBackfill.warm_minute`이 최근 60캘린더일의 미캐시 날짜를
   background 우선순위로 **순차** fetch한다. (venue, code) 단일 비행,
   supervised task(ADR-0088), 레이트리밋 시 즉시 중단.
2. **read-ahead**: `/api/live/past-candles`가 요청 구간을 서빙한 직후, 직전
   동일 폭 구간을 warm_minute으로 선행 워밍한다(250일 하한 클램프,
   레이트리밋/용량 경고 시 스킵). settle-loop의 다음 청크가 캐시 히트가 된다.

워밍은 순차(동시성 1)로 돌아 사용자 경로의 세마포어(3)와 KIS 예산을 점유하지
않는다. 단일 비행 키는 priority를 포함하지 않는다 — warm이 먼저 띄운 태스크에
사용자 요청이 올라타면 background로 대기하지만 ADR-0087의 비굶주림 보장으로
진전은 유지된다.

## Alternatives considered

- **전 종목 상시 사전 백필**: KIS 쿼터(15콜/초)와 분봉 보존(~1년) 대비 비용
  폭발. 관심종목 스코프 워밍이 같은 체감을 훨씬 싸게 준다. 기각.
- **프리펜드 API 경계 통합**(past-candles + /api/range 단일 응답, useLiveBundle
  원자화 게이트 제거): 근본적이지만 별도 서브시스템 규모. 실측에서 /api/range가
  지배적 병목으로 확인될 때 별도 ADR/플랜으로 진행한다. 보류.
- **프론트 청크 크기 확대**: 첫 페인트 지연 재발(/diagnose 2026-06-09의 90초
  블랭크 사례). 기각.

## Consequences

- 캐시 미스 팬의 체감 지연은 "매 청크 KIS 왕복"에서 "첫 청크만 KIS 왕복,
  이후 캐시 히트"로 바뀐다. 워밍이 이긴 경우 첫 청크도 히트.
- background 호출량 증가: 종목 전환당 최대 ~40거래일 × ~4콜. foreground 양보
  하의 background 레인이 흡수하고, 레이트리밋 신호에 즉시 중단한다.
- 워밍은 primary venue만 데운다 — KRX 폴백이 필요한 날짜는 인터랙션 경로가
  그때 처리한다(폴백 캐시는 도우면 이득, 없어도 기존과 동일).
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0090-live-minute-backfill-warm-and-read-ahead.md
git commit -m "docs(adr): ADR-0090 /live 분봉 워밍 + read-ahead"
```

---

### Task 7: 전체 게이트 (백엔드 + 프론트)

**Files:** 없음 (검증만)

- [ ] **Step 1: 백엔드 전체 테스트**

```bash
uv run --extra dev pytest -q
```

Expected: 전부 PASS (이 워크트리 기준 기존 green 유지)

- [ ] **Step 2: 프론트 전체 게이트**

```bash
cd frontend && npx vitest run && npx tsc -b && npm run build
```

Expected: vitest 전부 PASS, tsc 에러 0, build 성공

- [ ] **Step 3: 실패 시 처리**

실패한 테스트가 이 플랜의 변경과 무관한 기존 flaky/red인지 `git stash` 후 재실행으로 판별한다. 이 플랜의 변경이 원인이면 해당 Task로 돌아가 수정 후 재커밋.

---

### Task 8: 사후 실측 + 경계 통합 go/no-go 결정 게이트

**Files:**
- Modify: `docs/superpowers/plans/2026-07-07-live-minute-backfill-measurements.md`

- [ ] **Step 1: Task 1과 동일 절차로 사후 실측**

Task 1의 Step 1~4를 그대로 반복하되, **다른** 미방문 종목으로 시나리오를 두 가지 실행:

1. 종목 선택 → 워밍 완료 대기(백엔드 로그에서 `live-candle-warm` 태스크가 도는 동안 `hoga_perf past_candles_fetch`가 background로 찍힘) → 좌측 팬: 청크당 `/api/live/past-candles` durationMs가 캐시 히트 수준(수십 ms)인지.
2. 종목 선택 → 즉시 좌측 팬(워밍이 못 이긴 경쟁 상태): 첫 청크는 KIS 왕복, 이후 청크가 read-ahead 덕에 히트되는지.

- [ ] **Step 2: measurements 문서의 "사후" 섹션 채우기**

사전/사후의 청크당 `past-candles` vs `/api/range` durationMs 중앙값을 나란히 기록.

- [ ] **Step 3: 경계 통합 go/no-go 판정 기록**

문서 끝에 결론 추가:

```markdown
## 프리펜드 API 경계 통합 go/no-go
- 사후 기준, 청크 체감을 지배하는 것: past-candles / api-range
- 판정: go(별도 플랜 작성) | no-go(현 수준으로 충분)
- 근거: <수치>
```

판정 규칙: 워밍+read-ahead 적용 후에도 청크 표시 지연의 중앙값에서 `/api/range`가 `past-candles`보다 크면 **go** — "프리펜드 API 경계 통합"(단일 프리펜드 응답 + useLiveBundle 게이트 제거)을 별도 플랜(superpowers:writing-plans)으로 작성한다. 아니면 no-go로 종료.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-07-07-live-minute-backfill-measurements.md
git commit -m "docs(live): 분봉 백필 사후 실측 + 경계통합 go/no-go 기록"
```

---

## Self-Review 결과

- **커버리지**: 실측(Task 1, 8) / 워밍(Task 2-4) / read-ahead(Task 5) / 문서(Task 6) / 게이트(Task 7) — 합의된 범위 전부 매핑. 경계 통합은 의도적 제외(Scope note + Task 8 게이트).
- **타입 일관성**: `warm_minute` 반환 `str`("started"|"already_running") ↔ 라우트 `status` 필드; `_warm_tasks` 키 `(policy, code)` ↔ 테스트 `("KRX", "005930")`; `priority` 리터럴은 `kis_access.KisRequestPriority`("user_visible"|"background")와 일치.
- **알려진 리스크**: ① `build_router(get_status=...)` 최소 구성이 라우트 테스트에서 안 될 경우 → `tests/api/test_live_indices_routes.py`의 `_client()` 복사(Task 3 Step 1에 명시). ② ADR 번호 0090 선점 가능성 → Task 6에 확인 절차 명시. ③ 워밍 60일 상수는 실측 후 조정 여지(상수 한 곳).
