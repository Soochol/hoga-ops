# /live 분봉 fetch 기아 해소 (요청 예산 + 청크 워크백) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 전체-윈도우 재요청(최대 243일, 25분 관측)이 KIS 분봉 예산을 독점해 다른 종목의 초기 로드가 60초+ 굶던 문제를, ① 서버측 미캐시-일수 예산, ② read_ahead 폭 캡, ③ LRU 증설, ④ 프론트 청크 워크백, ⑤ 요청 타임아웃의 5겹으로 해소한다.

**Architecture:** 백엔드 `LiveMinuteCandleBackfill._collect_for_venue`가 한 요청당 KIS에서 새로 가져올 날짜 수를 예산(기본 12거래일)으로 제한하고, 초과분은 새 blocking 경고 `fetch_budget_exhausted`로 유예한다(blocking이므로 프론트 델타 기준에 박제되지 않음 → 다음 사이클에 자동 재시도). 프론트 `planPastCandlesDelta`는 기준선이 없거나 델타 폭이 클 때 15캘린더일 청크로 나눠 최신부터 자동 워크백한다(예산 12거래일 > 청크 ~11거래일이라 청크는 항상 예산 안에서 완결). read_ahead 워밍 폭도 15일로 캡해 자기증폭을 끊고, 과거 캐시 LRU를 512→2048로 늘려 깊은 워크백이 최근 날짜를 축출하는 churn을 없앤다.

**Tech Stack:** FastAPI + asyncio (백엔드), React + TanStack Query + vitest (프론트), pytest.

**근거 조사:** 메모리 `project_live_minute_candle_fetch_starvation.md` (2026-07-07). 델타 기준선 박제 버그는 PR #451에서 이미 수정됨. 병행 세션이 발견한 "extending 게이트가 폴백 3종 미참조" 프론트 결함(`project_live_minute_fetch_contention_latency.md`)은 **이 플랜의 스코프 밖** — 별도 작업.

**실행 환경 주의:**
- 워크트리: `/home/dev/code/hoga-ops/.claude/worktrees/wonderful-mestorf-06256c` (브랜치 `claude/wonderful-mestorf-06256c`). 모든 경로는 이 워크트리 기준 상대경로.
- 백엔드 테스트는 반드시 `uv run --extra dev pytest ...` (bare `uv run pytest`는 "No module named pytest"로 죽음).
- 프론트는 첫 실행 시 `cd frontend && npm install` 필요할 수 있음(워크트리는 node_modules 비어 있음). 게이트는 `npx vitest run` + `npx tsc -b` (`npm run lint`는 기존 부채 ~143건으로 게이트 아님).
- 커밋은 `git add <정확한 경로> && git commit` (`git commit --only`는 훅이 차단).

---

## File Structure

| 파일 | 역할 |
|---|---|
| Modify: `hoga/live/live_candle_backfill.py` | 미캐시-일수 예산(Task 1), read_ahead 폭 캡(Task 2) |
| Modify: `hoga/live/past_candles_cache.py` | LRU 512→2048 (Task 3) |
| Modify(append): `tests/unit/live/test_past_candles_cache.py` | 과거 캐시 용량 테스트 (Task 3). **주의: 파일이 이미 존재(13개 테스트) — Create 아님, append.** |
| Modify: `tests/unit/live/test_live_candle_backfill.py` | Task 1·2 테스트 추가 |
| Modify: `frontend/src/api/livePastCandles.ts` | 청크 워크백(Task 4), 타임아웃(Task 5), blocking 사유 추가 |
| Modify: `frontend/src/api/livePastCandles.test.tsx` | Task 4·5 테스트 추가 |
| Create: `docs/adr/NNNN-live-minute-fetch-budget.md` | 결정 기록 (Task 6) |

상수 정합성(반드시 이 관계 유지): 프론트 청크 `PAST_CHUNK_CALENDAR_DAYS = 15` ≈ 11거래일 < 백엔드 예산 `max_fresh_dates_per_collect = 12`거래일. read_ahead 캡 `_READ_AHEAD_MAX_SPAN_DAYS = 15` ≥ 프론트 팬 스텝 `stepChunkDays`(5캘린더일) — superset 속성 유지.

---

### Task 1: 백엔드 — 요청당 미캐시-일수 예산 + `fetch_budget_exhausted` 경고

**Files:**
- Modify: `hoga/live/live_candle_backfill.py` (`__init__` ~63-83행, `_collect_for_venue` ~400-424행, 로그 ~533-550행, `_fallback_blocking_warning_dates` ~792-803행, `_capacity_overloaded_warning` 인근 모듈 레벨)
- Test: `tests/unit/live/test_live_candle_backfill.py`

- [ ] **Step 1: 실패하는 테스트 3개 작성**

`tests/unit/live/test_live_candle_backfill.py` 끝에 추가 (파일 상단의 기존 `_FakeKis`, `_RecordingScheduler`, `_kst_ms` 재사용):

```python
@pytest.mark.asyncio
async def test_collect_minute_caps_uncached_fetches_per_request(tmp_path, monkeypatch) -> None:
    """예산(3)보다 큰 미캐시 창(10일) → 최신 3일만 fetch, 나머지는 budget 경고로 유예."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
        max_fresh_dates_per_collect=3,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 10),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert result.fresh_dates == ["20260508", "20260509", "20260510"]
    assert sorted(d for _, d, _, _ in kis.calls) == ["20260508", "20260509", "20260510"]
    warned = [w for w in result.data_warnings if w["reason"] == "fetch_budget_exhausted"]
    assert [w["date"] for w in warned] == [f"2026050{d}" for d in range(1, 8)]


@pytest.mark.asyncio
async def test_budget_counts_only_uncached_dates(tmp_path, monkeypatch) -> None:
    """캐시된 날짜는 예산을 소모하지 않는다."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    for day in range(1, 8):  # 5/1-5/7 캐시 채움 → 미캐시는 5/8-5/10 셋뿐
        date_s = f"2026050{day}"
        cache.store_past("KRX", "005930", date_s, [
            {"t_ms": _kst_ms(date_s), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        ])
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1, max_fresh_dates_per_collect=3,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 10),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert result.fresh_dates == ["20260508", "20260509", "20260510"]
    assert result.data_warnings == []  # 예산 내 완결 → 경고 없음


@pytest.mark.asyncio
async def test_budget_exhausted_suppresses_read_ahead(tmp_path, monkeypatch) -> None:
    """예산 초과 경고가 있으면 read_ahead 워밍을 건너뛴다(증폭 차단)."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
        max_fresh_dates_per_collect=3,
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 10),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
        read_ahead=True,
    )

    assert ("KRX", "005930") not in backfill._warm_tasks
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py -q -k budget`
Expected: 3 FAIL — `TypeError: __init__() got an unexpected keyword argument 'max_fresh_dates_per_collect'`

- [ ] **Step 3: 구현**

`hoga/live/live_candle_backfill.py` — 세 군데 수정.

(a) `__init__` 시그니처·저장 (기존 63-83행):

```python
    def __init__(
        self,
        *,
        data_dir,
        cache: PastCandlesCache,
        scheduler: KisRestScheduler,
        concurrency: int = 3,
        rate_limit_cooldown_s: float = 10.0,
        max_fresh_dates_per_collect: int = 12,
    ) -> None:
```

본문에 한 줄 추가 (`self._rate_limit_cooldown_s = ...` 다음):

```python
        # 한 collect 호출이 KIS에서 새로 가져올 수 있는 날짜 수 상한.
        # 기준선을 잃은 프론트가 수백 일 창을 통째로 재요청하면(2026-07-07
        # 실측 최대 243일/25분) foreground로 KIS 예산을 독점해 다른 종목이
        # 굶는다. 초과분은 fetch_budget_exhausted 경고(blocking)로 유예 —
        # 프론트가 박제하지 않으므로 다음 사이클에 이어서 받는다.
        self._max_fresh_dates_per_collect = max(1, int(max_fresh_dates_per_collect))
```

(b) 모듈 레벨 경고 헬퍼 — `_capacity_overloaded_warning` 정의 바로 옆에 추가:

```python
def _fetch_budget_exhausted_warning(date_s: str) -> dict:
    return {
        "date": date_s,
        "reason": "fetch_budget_exhausted",
        "msg": "uncached-date fetch budget exhausted for this request; older dates deferred",
    }
```

(c) `_collect_for_venue`의 pending 구성 루프 직후(기존 422행 `pending.append(date_s)` 루프 종료 후, `blocked = asyncio.Event()` 이전)에 삽입:

```python
        deferred = 0
        if len(pending) > self._max_fresh_dates_per_collect:
            # 최신 날짜 우선(차트는 우측=최신부터 보인다). 유예분은 blocking
            # 경고 → read_ahead 스킵 + 비-KRX 폴백의 covered 처리 + 프론트
            # 비박제까지 한 사유로 일관 처리된다.
            overflow = pending[: -self._max_fresh_dates_per_collect]
            pending = pending[-self._max_fresh_dates_per_collect :]
            deferred = len(overflow)
            for date_s in overflow:
                warnings_by_date[date_s] = _fetch_budget_exhausted_warning(date_s)
```

(d) `_fallback_blocking_warning_dates`(기존 ~792-803행)의 `blocking_reasons` set에 `"fetch_budget_exhausted"` 추가:

```python
    blocking_reasons = {
        "capacity_overloaded",
        "fetch_budget_exhausted",
        "kis_api_error",
        "kis_rate_limit",
        "rate_limit_aborted",
    }
```

(e) collect perf 로그(기존 533-550행)에 유예 수 추가 — 포맷 문자열의 `pending_dates=%d` 를 `pending_dates=%d deferred_dates=%d` 로 바꾸고 인자 `len(pending)` 다음에 `deferred` 를 추가.

- [ ] **Step 4: 통과 확인 (기존 테스트 포함)**

Run: `uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py -q`
Expected: 전부 PASS (기존 read_ahead 테스트들은 2일 창이라 예산 12 미달 — 영향 없음)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/live_candle_backfill.py tests/unit/live/test_live_candle_backfill.py
git commit -m "feat(live): 분봉 collect에 미캐시-일수 예산(12) — 거대 윈도우의 KIS 독점 차단"
```

---

### Task 2: 백엔드 — read_ahead 워밍 폭 캡 (자기증폭 차단)

**Files:**
- Modify: `hoga/live/live_candle_backfill.py:99-118` (`collect_minute`의 read_ahead 블록)
- Test: `tests/unit/live/test_live_candle_backfill.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
@pytest.mark.asyncio
async def test_read_ahead_span_capped(tmp_path, monkeypatch) -> None:
    """40일 요청창이라도 선행 워밍은 직전 15일만(자기증폭 차단)."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
        max_fresh_dates_per_collect=100,  # 예산 경고로 워밍이 스킵되지 않게 격리
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 20),
        too=dt.date(2026, 6, 28),  # 40일 창
        today_d=dt.date(2026, 7, 1),
        policy="KRX",
        read_ahead=True,
    )
    task = backfill._warm_tasks.get(("KRX", "005930"))
    assert task is not None
    await task

    bg_dates = sorted(d for c, d in (
        (c["priority"], k)
        for c, k in zip(scheduler.calls, (c["key"][4] for c in scheduler.calls))
    ) if c == "background")
    # 선행창 = [frm-15, frm-1] = 2026-05-05 .. 2026-05-19 (전부 거래일 mock)
    assert bg_dates[0] == "20260505"
    assert bg_dates[-1] == "20260519"
    assert len(bg_dates) == 15
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py -q -k span_capped`
Expected: FAIL — 캡이 없어 `bg_dates[0] == "20260420"` (40일 선행창), `len == 40`

- [ ] **Step 3: 구현**

`collect_minute`의 read_ahead 블록 수정. 모듈 상수 추가(파일 상단 상수부, `log = logging.getLogger` 인근):

```python
# read_ahead 선행 워밍 폭 상한(캘린더일). 프론트 팬 스텝 stepChunkDays(5)와
# 청크 워크백 PAST_CHUNK_CALENDAR_DAYS(15)의 superset이면 gap이 없다.
# 무제한이면 거대 창 요청이 같은 폭의 워밍을 또 낳아(2026-07-07: 243일→
# +243일) KIS 예산을 자기증폭적으로 태운다.
_READ_AHEAD_MAX_SPAN_DAYS = 15
```

기존 99-118행의 블록에서 주석 문단("span_days는 의도적으로 무제한이다..." 전체)을 위 상수 참조로 교체하고 계산식만 변경:

```python
        # read-ahead: 이번 요청창 직전 구간을 background로 선행 워밍하되,
        # 폭은 _READ_AHEAD_MAX_SPAN_DAYS로 캡한다(상수 주석 참조).
        # 레이트리밋/용량/예산 경고가 있으면 예산이 이미 부족하다는 뜻이므로
        # 이번엔 건너뛴다.
        if read_ahead and not _fallback_blocking_warning_dates(out.data_warnings):
            span_days = min((too - frm).days + 1, _READ_AHEAD_MAX_SPAN_DAYS)
            ra_too = frm - timedelta(days=1)
            ra_frm = ra_too - timedelta(days=span_days - 1)
            if earliest_allowed is not None:
                ra_frm = max(ra_frm, earliest_allowed)
            if ra_frm <= ra_too:
                await self.warm_minute(
                    code=code, frm=ra_frm, too=ra_too, today_d=today_d, policy=policy,
                )
```

- [ ] **Step 4: 통과 확인**

Run: `uv run --extra dev pytest tests/unit/live/test_live_candle_backfill.py -q`
Expected: 전부 PASS (기존 `test_collect_minute_read_ahead_warms_preceding_window`는 2일 창 → min(2,15)=2, 불변)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/live_candle_backfill.py tests/unit/live/test_live_candle_backfill.py
git commit -m "fix(live): read_ahead 워밍 폭을 15일로 캡 — 거대 창 요청의 자기증폭 차단"
```

---

### Task 3: 백엔드 — 과거 분봉 LRU 512 → 2048

**Files:**
- Modify: `hoga/live/past_candles_cache.py:29`
- Create: `tests/unit/live/test_past_candles_cache.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/live/test_past_candles_cache.py` 신규:

```python
from __future__ import annotations

import datetime as dt

from hoga.live.past_candles_cache import PastCandlesCache


def _kst_ms(date_yyyymmdd: str) -> int:
    kst = dt.timezone(dt.timedelta(hours=9))
    d = dt.datetime.strptime(date_yyyymmdd, "%Y%m%d").replace(hour=9, tzinfo=kst)
    return int(d.timestamp() * 1000)


def _bar(date_s: str) -> list[dict]:
    return [{"t_ms": _kst_ms(date_s), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}]


def test_default_capacity_survives_two_symbol_deep_walkback(tmp_path) -> None:
    """250일 워크백(_PAST_MAX_DAYS) × 2종목 + 60일 워밍 × 4종목 ≈ 740키가
    공존해도 최근 날짜가 축출되지 않아야 한다. 512에서는 깊은 walk가 최근
    날짜를 밀어내 60초마다 재fetch churn을 일으켰다(2026-07-07 실측: 같은
    날짜 39회 재fetch)."""
    cache = PastCandlesCache(data_dir=tmp_path)
    start = dt.date(2025, 11, 1)
    dates = [(start + dt.timedelta(days=i)).strftime("%Y%m%d") for i in range(250)]
    for code in ("005930", "000660"):
        for date_s in dates:
            cache.store_past("KRX", code, date_s, _bar(date_s))
    for code in ("112040", "000270", "015760", "241560"):
        for date_s in dates[-60:]:
            cache.store_past("KRX", code, date_s, _bar(date_s))

    # 두 종목 250일 전량 + 워밍 4종목 60일 전량 생존
    assert all(
        cache.get_past("KRX", code, date_s) is not None
        for code in ("005930", "000660") for date_s in dates
    )
    assert all(
        cache.get_past("KRX", code, date_s) is not None
        for code in ("112040", "000270", "015760", "241560") for date_s in dates[-60:]
    )
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py -q`
Expected: FAIL — 740키 > 512라 앞쪽 저장분이 LRU 축출됨

- [ ] **Step 3: 구현**

`hoga/live/past_candles_cache.py:29`:

```python
# 2048 = _PAST_MAX_DAYS(250) × 2종목 + 60일 워밍 여러 종목 + 여백.
# 512에서는 한 종목 반년 워크백만으로 최근 날짜가 축출돼 60초 refetch가
# 매번 KIS 재호출하는 churn이 생겼다(2026-07-07 실측). 봉당 ~130KB/일
# 기준 최악 ~270MB — 단일 운영 서버에서 수용 가능.
DEFAULT_PAST_MEM_MAX_ENTRIES = 2048
```

- [ ] **Step 4: 통과 확인**

Run: `uv run --extra dev pytest tests/unit/live/test_past_candles_cache.py tests/unit/live/test_live_candle_backfill.py -q`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/live/past_candles_cache.py tests/unit/live/test_past_candles_cache.py
git commit -m "fix(live): 과거 분봉 LRU 512→2048 — 깊은 워크백이 최근 날짜 축출하던 churn 제거"
```

---

### Task 4: 프론트 — 청크 워크백 (거대 윈도우 요청 근절)

**Files:**
- Modify: `frontend/src/api/livePastCandles.ts` (`BLOCKING_WARNING_REASONS`, `planPastCandlesDelta`, `useLivePastCandles`)
- Test: `frontend/src/api/livePastCandles.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/api/livePastCandles.test.tsx`에 추가. URL을 그대로 되돌려주는 mock 헬퍼를 파일 상단 `RESPONSE` 아래에 추가:

```tsx
function mockApiEchoingWindow() {
  return vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
    const params = new URLSearchParams(url.split('?')[1]);
    return {
      code: params.get('code')!,
      from: params.get('from')!,
      to: params.get('to')!,
      venue: (params.get('venue') ?? 'KRX') as LivePastCandlesResponse['venue'],
      candles: [],
      cached_dates: [],
      fresh_dates: [],
      data_warnings: [],
    } satisfies LivePastCandlesResponse;
  });
}
```

`describe('useLivePastCandles', ...)` 안에 테스트 2개:

```tsx
  it('기준선이 없으면 최신 15일 청크만 먼저 요청한다', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => useLivePastCandles('005930', '20260101', '20260707'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // 20260707 - 14일 = 20260623. 188일 전체가 아니라 최신 청크만.
    expect(spy.mock.calls[0][0]).toBe(
      '/api/live/past-candles?code=005930&from=20260623&to=20260707&venue=KRX',
    );
  });

  it('청크 단위로 seed from까지 자동 워크백한다', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => useLivePastCandles('005930', '20260601', '20260707'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3), { timeout: 3000 });
    const urls = spy.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      '/api/live/past-candles?code=005930&from=20260623&to=20260707&venue=KRX',
      '/api/live/past-candles?code=005930&from=20260608&to=20260622&venue=KRX',
      '/api/live/past-candles?code=005930&from=20260601&to=20260607&venue=KRX',
    ]);
    // seed까지 도달하면 멈춘다(4번째 요청 없음)
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalledTimes(3);
  });
```

`describe('hasBlockingWarnings', ...)`의 `fetch_budget_exhausted` 테스트는 **Task 1 리뷰 수정 커밋(ad81624)에서 이미 추가됨 — 스킵**.

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/api/livePastCandles.test.tsx`
Expected: 신규 3개 FAIL — 첫 요청이 `from=20260101` 전체 창; blocking 사유 미등록

- [ ] **Step 3: 구현**

`frontend/src/api/livePastCandles.ts` — 네 군데.

(a) `BLOCKING_WARNING_REASONS`에 `fetch_budget_exhausted` 추가는 **Task 1 리뷰 수정 커밋(ad81624)에서 이미 완료 — 스킵**.

(b) 상수 추가(파일 내 `planPastCandlesDelta` 위):

```ts
/** 한 요청의 최대 캘린더일 폭. 백엔드 미캐시-일수 예산
 * (max_fresh_dates_per_collect=12 거래일)보다 작은 ~11거래일이라 청크는
 * 항상 예산 안에서 완결된다. 기준선(mergedRef)이 리마운트·날짜 롤오버로
 * 사라졌을 때 수백 일 창을 통째로 재요청하던 것이 분봉 기아의
 * 근본원인(2026-07-07 조사) — 청크 워크백으로 근절한다. */
export const PAST_CHUNK_CALENDAR_DAYS = 15;
```

(c) `planPastCandlesDelta`의 반환 두 곳을 청크 캡으로 교체 (기존 158-171행의 `if (!canReusePrevious)` 블록과 마지막 return):

```ts
  if (!canReusePrevious) {
    const chunkFloor = addDays(to, -(PAST_CHUNK_CALENDAR_DAYS - 1));
    return {
      enabled: true,
      requestFrom: from < chunkFloor ? chunkFloor : from,
      requestTo: to,
      canReusePrevious: false,
      servePrevious: false,
      identity,
    };
  }
  const requestTo = addDays(previous.from, -1);
  const chunkFloor = addDays(requestTo, -(PAST_CHUNK_CALENDAR_DAYS - 1));
  return {
    enabled: true,
    requestFrom: from < chunkFloor ? chunkFloor : from,
    requestTo,
    canReusePrevious: true,
    servePrevious: true,
    identity,
  };
```

(d) `useLivePastCandles`에 워크백 전진 nudge 추가. 응답 pin은 렌더 말미에 일어나므로(hook 본문 마지막 `mergedRef.current = ...`), pin 직후 렌더가 한 번 더 없으면 다음 청크 요청이 외부 렌더(SSE 틱·refetchInterval)까지 지연된다. react import에 `useEffect`, `useReducer` 추가 후, hook의 `return` 직전에:

```ts
  // 청크 워크백 전진 nudge: 응답이 pin된 렌더에서는 plan이 pin 이전
  // previous로 계산돼 있다. 데이터 도착마다 리렌더를 한 번 강제해
  // 다음 청크 쿼리키가 즉시 파생되게 한다. blocking 경고 응답은 pin되지
  // 않아 plan이 같은 키를 유지 → React Query가 중복 요청을 흡수하므로
  // 무한 루프가 아니다(재시도는 staleTime 60s가 담당).
  useEffect(() => {
    if (query.data && !query.isPlaceholderData) bumpMergedVersion();
  }, [query.data, query.isPlaceholderData]);
```

훅 상단(다른 hook들과 같은 위치)에:

```ts
  const [, bumpMergedVersion] = useReducer((x: number) => x + 1, 0);
```

- [ ] **Step 4: 통과 확인 (파일 전체 — 기존 델타·박제 테스트 회귀 포함)**

Run: `cd frontend && npx vitest run src/api/livePastCandles.test.tsx`
Expected: 전부 PASS. 특히 기존 `fetches only the missing older delta`(작은 델타 → 캡 미적용), `blocking 경고 응답은 델타 기준에 박제되지 않는다`, `정상 응답은 여전히 박제` 가 그대로 PASS여야 한다.

- [ ] **Step 5: 차트 통합 회귀**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx && npx tsc -b`
Expected: PASS. (청크 프리펜드는 기존 팬-델타 프리펜드와 동일 경로 — lwc 뷰포트 시프트 로직이 이미 처리. 실패 시 여기서 멈추고 원인 조사.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/livePastCandles.ts frontend/src/api/livePastCandles.test.tsx
git commit -m "fix(live): 과거 분봉을 15일 청크로 자동 워크백 — 기준선 소실 시 거대 윈도우 재요청 근절"
```

---

### Task 5: 프론트 — 요청 타임아웃 백스톱 (30s)

**Files:**
- Modify: `frontend/src/api/livePastCandles.ts` (queryFn)
- Test: `frontend/src/api/livePastCandles.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
describe('withPastCandlesTimeout', () => {
  it('원본 signal의 abort가 전파된다', () => {
    const c = new AbortController();
    const s = withPastCandlesTimeout(c.signal, 60_000);
    c.abort();
    expect(s.aborted).toBe(true);
  });

  it('타임아웃 경과 시 abort된다', async () => {
    const s = withPastCandlesTimeout(new AbortController().signal, 10);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.aborted).toBe(true);
  });
});
```

import에 `withPastCandlesTimeout` 추가.

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/api/livePastCandles.test.tsx`
Expected: FAIL — `withPastCandlesTimeout` 미정의(import 에러)

- [ ] **Step 3: 구현**

`livePastCandles.ts`:

```ts
/** 서버가 예산 내로 응답하므로 정상 요청은 수 초에 끝난다. 30s는 서버
 * 포화·행 상태에서 무한 로딩을 끊는 백스톱 — abort되면 React Query
 * 재시도/refetchInterval이 이어받는다. */
const PAST_CANDLES_TIMEOUT_MS = 30_000;

export function withPastCandlesTimeout(signal: AbortSignal, ms: number): AbortSignal {
  if (typeof AbortSignal.any !== 'function' || typeof AbortSignal.timeout !== 'function') {
    return signal; // 구형 런타임 폴백: 타임아웃 없이 기존 동작 유지
  }
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}
```

queryFn 수정:

```ts
    queryFn: ({ signal }) =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${plan.requestFrom}&to=${plan.requestTo}&venue=${venue}`,
        { signal: withPastCandlesTimeout(signal, PAST_CANDLES_TIMEOUT_MS) },
      ),
```

주의: 기존 테스트 `passes an AbortSignal to apiCall`은 `expect.any(AbortSignal)` / `toBeInstanceOf(AbortSignal)` 검사라 합성 signal로도 PASS.

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/api/livePastCandles.test.tsx`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/livePastCandles.ts frontend/src/api/livePastCandles.test.tsx
git commit -m "feat(live): past-candles 요청에 30s 타임아웃 백스톱"
```

---

### Task 6: ADR 작성

**Files:**
- Create: `docs/adr/NNNN-live-minute-fetch-budget.md` (NNNN = 다음 빈 번호)

- [ ] **Step 1: 다음 ADR 번호 확인**

Run: `ls docs/adr/ | sort | tail -3`
가장 큰 번호 +1을 NNNN으로 사용 (동시 세션이 번호를 선점했을 수 있으니 커밋 직전 재확인).

- [ ] **Step 2: ADR 작성**

`docs/adr/NNNN-live-minute-fetch-budget.md`:

```markdown
# NNNN. /live 분봉 fetch 예산 + 청크 워크백

Status: Accepted (2026-07-07)

## Context

/live 분봉의 델타 최적화 기준선(mergedRef)은 컴포넌트 메모리에만 있어
리마운트·`to`(=오늘) 롤오버 시 사라지고, 깊게 팬해둔 탭은 [from..오늘]
수백 일을 통째로 재요청했다(실측 최대 243일, collect 25.3분, KIS ~560콜
foreground). read_ahead는 요청창 폭 전체를 추가 워밍해 이를 배가했고,
과거 캐시 LRU(512)는 깊은 워크백에 최근 날짜를 축출해 60초 refetch가
같은 날짜를 재fetch하는 churn(동일 날짜 39회 실측)을 만들었다. 결과는
EGW00201 폭풍과 콜드 종목 초기 로드 60초+ 기아.

## Decision

4겹 방어를 한 사유(`fetch_budget_exhausted`, blocking)로 일관 연결한다.

1. 백엔드 collect는 요청당 미캐시 날짜를 `max_fresh_dates_per_collect`
   (기본 12거래일)까지만 fetch하고 초과분(과거쪽부터)은
   `fetch_budget_exhausted` 경고로 유예한다. blocking 사유이므로
   read_ahead 스킵·비-KRX 폴백 covered 처리·프론트 비박제가 함께 걸린다.
2. read_ahead 워밍 폭은 `_READ_AHEAD_MAX_SPAN_DAYS`(15캘린더일)로 캡.
3. 과거 분봉 LRU는 2048로 증설(250일×2종목+워밍 공존).
4. 프론트는 기준선이 없거나 델타가 넓으면 `PAST_CHUNK_CALENDAR_DAYS`
   (15캘린더일 ≈ 11거래일 < 예산 12) 청크로 최신부터 자동 워크백한다.

상수 결합: 프론트 청크(15일) < 백엔드 예산(12거래일) ≥ 청크 내 거래일,
read_ahead 캡(15) ≥ 팬 스텝 stepChunkDays(5). 이 관계가 깨지면 청크가
예산 경고를 받아 60초 주기로만 전진한다(기능은 유지, 속도만 저하).

## Consequences

- 어떤 단일 요청도 KIS를 ~48콜(12일×4콜) 이상 독점하지 못한다.
- 깊은 복원은 즉시가 아니라 청크 단위 점진 로드가 된다(15일/사이클,
  응답 도착 즉시 다음 청크 — 240일 복원 ≈ 16사이클).
- 비-KRX 정책은 primary+KRX 폴백이 각자 예산을 가져 최악 2×예산.
- 레거시/외부 클라이언트가 거대 창을 요청해도 서버 예산이 막는다.
```

- [ ] **Step 3: Commit**

```bash
git add docs/adr/NNNN-live-minute-fetch-budget.md
git commit -m "docs(adr): NNNN /live 분봉 fetch 예산 + 청크 워크백"
```

---

### Task 7: 전체 검증

- [ ] **Step 1: 백엔드 전체 테스트**

Run: `uv run --extra dev pytest -q`
Expected: 전부 PASS (실패 시 이 플랜의 변경분과 무관한지 `git stash` 대조로 판별)

- [ ] **Step 2: 프론트 전체 게이트**

Run: `cd frontend && npx vitest run && npx tsc -b && npm run build`
Expected: 전부 PASS + 빌드 성공 (`npm run lint`는 기존 부채로 게이트 아님)

- [ ] **Step 3: 실서버 스모크 (선택, 권장)**

메인 체크아웃 dev 서버(:8000/:5173)가 떠 있으면 — 워크트리 백엔드 검증은 CORS 제약상 직접 API 왕복으로:

```bash
# 워크트리에서 백엔드만 별도 포트로 띄워 예산 동작 확인
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8010 --reload --reload-dir hoga &
sleep 5
/home/dev/code/hoga-ops/.venv/bin/python3 -c "
import urllib.request, json
url='http://127.0.0.1:8010/api/live/past-candles?code=005930&from=20260401&to=20260707&venue=KRX'
with urllib.request.urlopen(url, timeout=60) as r:
    d=json.loads(r.read())
warned=[w for w in d['data_warnings'] if w['reason']=='fetch_budget_exhausted']
print('fresh:', len(d['fresh_dates']), 'budget-deferred:', len(warned))
assert len(d['fresh_dates']) <= 12, 'budget violated'
print('OK')
"
```

Expected: `fresh: ≤12`, `budget-deferred: >0`, `OK` — 98일 창이 12일로 캡됨. 확인 후 8010 서버 종료.

- [ ] **Step 4: 최종 커밋 상태 확인**

Run: `git log --oneline origin/main..HEAD && git status --porcelain`
Expected: Task 1-6 커밋 6개, 워킹트리 클린.

---

## Self-Review 결과

- **커버리지**: 조사에서 확인된 4개 원인(거대 윈도우/read_ahead 증폭/LRU churn/무한 대기) ↔ Task 4·1 / 2 / 3 / 5. 박제 버그는 PR #451로 기수정, extending 게이트 결함은 명시적 스코프 밖.
- **타입 정합**: `max_fresh_dates_per_collect`(Task 1 시그니처 = Task 2 테스트 사용처), `PAST_CHUNK_CALENDAR_DAYS`·`withPastCandlesTimeout`(Task 4 정의 = Task 5 사용처) 일치 확인.
- **플레이스홀더**: ADR 번호 NNNN만 실행 시점 확정(동시 세션 번호 선점 가능성 때문에 의도적) — Step 1에 확정 절차 포함.
