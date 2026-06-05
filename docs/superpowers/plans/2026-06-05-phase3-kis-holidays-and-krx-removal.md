# Phase 3(+4) — 거래일을 KIS chk-holiday로 + KRX 완전 제거 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 거래일 달력을 pykrx(삼성전자 OHLCV 유추)에서 KIS `chk-holiday`(CTCA0903R, `opnd_yn` 직접 판정)로 바꾸고, 그 결과 사용처가 0이 된 KRX 흔적(`KRX_ID`/`KRX_PW`·pykrx·관련 에러코드·안내문구)을 **완전히 제거**한다. 이로써 KRX→KIS 이전 전체가 완료된다.

**Architecture:** SPEC §5(동기 유지 — calendar 호출자 5개 파일 무변경)·§5.5(토큰은 Phase 1의 `KisTokenProvider` 공유)·§10(Phase 3 직전 `kis_runtime` 추출). Task 1이 KIS 자원 싱글턴을 `lifecycle`에서 `kis_runtime`으로 옮겨 poller-무관 소비자가 깨끗하게 토큰을 얻게 하고, Task 2가 동기 `kis_holidays`를 만들며(실측 fixture), Task 3가 `calendar._trading_days_for` 속만 교체한다(캐시·폴백·`is_trading_day`/`trading_days_in_range` 불변). Task 4가 KRX 잔재를 일괄 제거한다(프론트 exhaustive Record 동시 갱신 — Phase 2 교훈).

**Tech Stack:** Python 3, httpx(sync `Client`), pytest, TypeScript(union+Record 동시 갱신).

**probe 실측 (2026-06-05, 실 토큰으로 검증 완료):**
- 한 호출(BASS_DT=20260601)에 **24행**(6/1~6/24), BASS_DT=20260625 → 6/25~7/18. **BASS_DT 전진 루프로 월 커버 ≈ 2회 호출.**
- 응답 키 실측: `bass_dt, wday_dvsn_cd, bzdy_yn, tr_day_yn, opnd_yn, sttl_day_yn`. **거래일 ⇔ `opnd_yn == "Y"`.**
- 2026-06-03(수, 선거일)이 `opnd_yn=N` — 평일 폴백이 못 잡는 진짜 휴장일을 KIS가 직접 준다.
- 실측 응답 fixture가 `/home/dev/.claude/jobs/dbeb6b61/tmp/chk_holiday_20260601.json`에 저장돼 있다 — Task 2 Step 1에서 repo fixture로 복사한다.

---

## File Structure

- **Create** `hoga/live/kis_runtime.py` — KIS 자원 싱글턴(provider+client)의 ensure/get/set/aclose/reset. `lifecycle`에서 이동(SPEC §10).
- **Create** `hoga/api/kis_holidays.py` — 동기 `chk-holiday` 조회. `fetch_month_trading_days(year, month) -> set[str]`, `KisHolidayFetchError`. BASS_DT 전진 루프.
- **Create** `tests/unit/api/fixtures/chk_holiday_20260601.json` — 실측 응답(24행).
- **Modify** `hoga/live/lifecycle.py` — KIS 싱글턴 코드 제거, `kis_runtime` 위임/import 갱신.
- **Modify** `hoga/api/calendar.py` — `_trading_days_for` 속 교체, `krx_creds_present` 제거, `KrxUnavailableError`→`TradingDayUnavailableError` rename.
- **Modify** `hoga/api/error_codes.py` — `KIS_HOLIDAY_FETCH_FAILED` 추가, `KRX_CREDENTIALS_MISSING`/`KRX_FETCH_FAILED` 제거.
- **Modify** `frontend/src/api/types.ts` + `frontend/src/api/upstream-hints.tsx` — union·**5개 exhaustive Record** 동시 갱신(krx_* 키 제거 + kis_holiday_fetch_failed 추가).
- **Modify** `hoga/api/captures.py:23,1278-1285`, `hoga/api/watchlist_routes.py:32,106-108` — rename된 예외 + KIS 안내 문구.
- **Modify** `hoga/env.py`, `pyproject.toml:17`(pykrx 제거), `.env.example`, `CLAUDE.md`, `hoga/api/app.py:241`(주석) — KRX 잔재 제거.

---

## Task 1: kis_runtime 추출 (SPEC §10)

`lifecycle.py`의 KIS 자원 싱글턴 관리를 `hoga/live/kis_runtime.py`로 옮긴다. **동작 불변** — 위치만 이동. poller-무관 소비자(Task 2의 kis_holidays, screener, live/api)가 poller 모듈을 import하지 않게 된다.

**Files:** Create `hoga/live/kis_runtime.py`, Modify `hoga/live/lifecycle.py`, Test `tests/unit/live/test_kis_singleton.py`(import 경로 갱신)

- [ ] **Step 1: Create kis_runtime.py — move the KIS singleton block from lifecycle**

`hoga/live/kis_runtime.py`: lifecycle.py에서 다음을 **그대로 이동**(코드 변경 없이 — 단 docstring과 아래 신규 함수 추가):
- 전역 `_kis_client: KisClient | None = None`, `_kis_token_provider: KisTokenProvider | None = None`
- `get_kis_client()`, `set_kis_client()`, `ensure_kis_token_provider(token_cache_path, creds)`, `ensure_kis_client(creds, provider)`, `ensure_kis_client_from_env(data_dir)`, `aclose_kis_client()`
- 필요한 import: `KisClient, KisCredentials` from `.kis_client`, `KisTokenProvider` from `.kis_token_provider`, `Path`, `os`

모듈 docstring:

```python
"""KIS process-resource singletons (token provider + client).

Extracted from lifecycle.py (SPEC §10, 아키텍처 그릴링 2026-06-05) so that
poller-independent consumers — the sync holiday path (kis_holidays), the
screener EOD update, /api/live/quotes — obtain KIS resources without importing
the poller lifecycle module. Singleton-ness is unchanged (ADR-0038/0050):
one token provider + one client (one 15/s bucket) per process; closed only at
process shutdown via aclose_kis_client.
"""
```

그리고 **신규** 동기 소비자용 헬퍼를 추가:

```python
def ensure_kis_token_provider_from_env() -> tuple[KisTokenProvider, KisCredentials] | None:
    """Resolve creds from env and return (provider, creds), or None when
    KIS_APP_KEY/SECRET are absent. For consumers that need the token + auth
    headers but NOT the async data client (e.g. the sync holiday path)."""
    app_key = os.environ.get("KIS_APP_KEY")
    app_secret = os.environ.get("KIS_APP_SECRET")
    if not app_key or not app_secret:
        return None
    from hoga.config import resolve_data_dir

    creds = KisCredentials(app_key=app_key, app_secret=app_secret, env="real")
    provider = ensure_kis_token_provider(
        resolve_data_dir() / ".local" / "kis-token.json", creds
    )
    return provider, creds
```

(`resolve_data_dir`의 시그니처를 먼저 확인하라 — 인자가 필요하면 기존 호출 패턴을 따른다.)

그리고 `reset_for_tests()`를 kis_runtime에 추가(두 전역 None).

- [ ] **Step 2: lifecycle.py — replace the moved block with imports/delegation**

lifecycle.py에서 이동된 전역·함수들을 삭제하고, 하위호환 re-export로 대체(기존 호출자·테스트가 `lifecycle.ensure_kis_client_from_env` 등을 계속 쓸 수 있게):

```python
from .kis_runtime import (  # re-export: KIS resource singletons moved per SPEC §10
    aclose_kis_client,
    ensure_kis_client,
    ensure_kis_client_from_env,
    ensure_kis_token_provider,
    get_kis_client,
    set_kis_client,
)
```

`lifecycle.reset_for_tests()`는 자체 상태(poller/_buffer/promote) 리셋 + `kis_runtime.reset_for_tests()` 호출로 위임. `start_live_poller` 내부의 `ensure_kis_client_from_env` 사용은 re-export로 그대로 동작.

- [ ] **Step 3: Update the singleton tests' private-global references**

`tests/unit/live/test_kis_singleton.py`의 autouse fixture는 `lifecycle.reset_for_tests()` 경유라 그대로 동작. 단 `lifecycle._kis_client`/`lifecycle._kis_token_provider`를 직접 읽는 assertion이 있으면 `kis_runtime._kis_client` 등으로 갱신. `test_aclose_closes_and_nulls_both_singletons`의 null 확인도 kis_runtime 전역 기준.

- [ ] **Step 4: Run**

Run: `uv run --extra dev pytest tests/unit/live/ -q`
Expected: ALL PASS (Phase 1 때 291 안팎). 동작 불변 확인.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_runtime.py hoga/live/lifecycle.py tests/unit/live/
git commit -m "refactor(kis): extract KIS resource singletons to kis_runtime (SPEC §10)"
```

---

## Task 2: kis_holidays.py — 동기 휴장일 조회 (실측 fixture)

**Files:** Create `hoga/api/kis_holidays.py`, `tests/unit/api/fixtures/chk_holiday_20260601.json`, `tests/unit/api/test_kis_holidays.py`

- [ ] **Step 1: Copy the probe fixture into the repo**

```bash
cp /home/dev/.claude/jobs/dbeb6b61/tmp/chk_holiday_20260601.json tests/unit/api/fixtures/chk_holiday_20260601.json
```

(실측 응답 24행 — bass_dt 20260601~20260624, 2026-06-03이 opnd_yn=N인 진짜 데이터.)

- [ ] **Step 2: Write the failing tests**

`tests/unit/api/test_kis_holidays.py`:

```python
"""KIS chk-holiday sync fetch (Phase 3). Real-response fixture."""
import json
from pathlib import Path

import httpx
import pytest

from hoga.api.kis_holidays import (
    KisHolidayFetchError,
    _collect_month_from_pages,
    fetch_month_trading_days,
)

FIX = Path(__file__).parent / "fixtures" / "chk_holiday_20260601.json"


def _pages_from_fixture():
    body = json.loads(FIX.read_text())
    return [body["output"]]  # one page of 24 rows


def test_collect_filters_opnd_yn_and_month() -> None:
    days = _collect_month_from_pages(_pages_from_fixture(), 2026, 6)
    assert "20260601" in days          # opnd_yn=Y
    assert "20260603" not in days      # 선거일 — opnd_yn=N (real data)
    assert "20260607" not in days      # Sunday
    assert all(d.startswith("202606") for d in days)


def test_fetch_month_advances_bass_dt(monkeypatch: pytest.MonkeyPatch) -> None:
    """First page covers only 6/1-6/24 → loop must call again from 6/25."""
    body = json.loads(FIX.read_text())
    page2 = [
        {"bass_dt": d, "wday_dvsn_cd": "03", "bzdy_yn": "Y",
         "tr_day_yn": "Y", "opnd_yn": "Y", "sttl_day_yn": "Y"}
        for d in ("20260625", "20260626", "20260629", "20260630", "20260701")
    ]
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bass = req.url.params["BASS_DT"]
        calls.append(bass)
        out = body["output"] if bass == "20260601" else page2
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output": out})

    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: ("TOKEN", "K", "S", "https://x"))
    monkeypatch.setattr(kh, "_transport_for_tests", httpx.MockTransport(handler))

    days = fetch_month_trading_days(2026, 6)
    assert calls == ["20260601", "20260625"]   # BASS_DT advanced past last row
    assert "20260630" in days and "20260701" not in days


def test_fetch_raises_without_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: None)
    with pytest.raises(KisHolidayFetchError):
        fetch_month_trading_days(2026, 6)


def test_fetch_raises_on_rt_cd_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.api.kis_holidays as kh
    monkeypatch.setattr(kh, "_resolve_provider", lambda: ("TOKEN", "K", "S", "https://x"))
    monkeypatch.setattr(
        kh, "_transport_for_tests",
        httpx.MockTransport(lambda req: httpx.Response(
            200, json={"rt_cd": "1", "msg_cd": "E", "msg1": "bad", "output": []})),
    )
    with pytest.raises(KisHolidayFetchError):
        fetch_month_trading_days(2026, 6)
```

- [ ] **Step 3: Run to verify failure**

Run: `uv run --extra dev pytest tests/unit/api/test_kis_holidays.py -v`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the module**

`hoga/api/kis_holidays.py`:

```python
"""KIS 국내휴장일조회 (CTCA0903R) — sync trading-day source for the calendar.

Sync httpx.Client (NOT KisClient's AsyncClient) so the executor/threadpool
calendar path calls it without the event-loop-binding hazard (ADR-0050
amendment). The bearer token comes from the shared KisTokenProvider via
kis_runtime — one cache + cooldown with the async fetch path.

Probe-verified 2026-06-05: one call returns ~24 rows forward from BASS_DT;
output keys are bass_dt/wday_dvsn_cd/bzdy_yn/tr_day_yn/opnd_yn/sttl_day_yn;
trading day ⇔ opnd_yn == "Y". We advance BASS_DT past the last returned row
until the target month is covered — robust whether KIS returns one day or
many per call. Cold-path only (results are month-cached by calendar.py);
sequential calls self-throttle on network RTT, no rate-limit handling needed.
"""
from __future__ import annotations

import calendar as stdlib_calendar
from typing import Optional

import httpx

_PATH = "/uapi/domestic-stock/v1/quotations/chk-holiday"
_TR_ID = "CTCA0903R"
# 24+ rows/call → a month is ~2 calls; this guards a runaway loop, not quota.
_MAX_CALLS_PER_MONTH = 8

# Test seam: tests inject an httpx.MockTransport here (module-level on purpose
# — the sync client is built per fetch, so there is no instance to inject into).
_transport_for_tests: Optional[httpx.BaseTransport] = None


class KisHolidayFetchError(Exception):
    """creds-missing / HTTP / rt_cd / parse failure.
    Maps to UpstreamCode.KIS_HOLIDAY_FETCH_FAILED."""


def _resolve_provider():
    """Return (token, app_key, app_secret, base_url) or None when creds absent.

    Late import + tiny tuple so tests monkeypatch THIS seam without touching
    kis_runtime. Token issuance/cooldown lives in KisTokenProvider (Phase 1).
    """
    from hoga.live.kis_runtime import ensure_kis_token_provider_from_env

    got = ensure_kis_token_provider_from_env()
    if got is None:
        return None
    provider, creds = got
    return provider.get_token(), creds.app_key, creds.app_secret, creds.base_url


def _collect_month_from_pages(pages: list[list[dict]], year: int, month: int) -> set[str]:
    """Pure: filter opnd_yn=='Y' rows belonging to (year, month)."""
    prefix = f"{year:04d}{month:02d}"
    out: set[str] = set()
    for rows in pages:
        for r in rows:
            d = str(r.get("bass_dt", ""))
            if d.startswith(prefix) and r.get("opnd_yn") == "Y":
                out.add(d)
    return out


def fetch_month_trading_days(year: int, month: int) -> set[str]:
    """Trading days (opnd_yn=='Y') of (year, month) via BASS_DT-advance loop.

    Raises KisHolidayFetchError on any failure — calendar._trading_days_for
    maps that to None → weekday fallback. Never returns a partial month
    silently: the loop runs until the month-end is covered or raises.
    """
    resolved = _resolve_provider()
    if resolved is None:
        raise KisHolidayFetchError("KIS_APP_KEY/KIS_APP_SECRET missing")
    token, app_key, app_secret, base_url = resolved

    last_day = stdlib_calendar.monthrange(year, month)[1]
    month_end = f"{year:04d}{month:02d}{last_day:02d}"
    bass_dt = f"{year:04d}{month:02d}01"
    pages: list[list[dict]] = []

    with httpx.Client(base_url=base_url, transport=_transport_for_tests, timeout=15.0) as client:
        for _ in range(_MAX_CALLS_PER_MONTH):
            try:
                resp = client.get(
                    _PATH,
                    params={"BASS_DT": bass_dt, "CTX_AREA_FK": "", "CTX_AREA_NK": ""},
                    headers={
                        "authorization": f"Bearer {token}",
                        "appkey": app_key,
                        "appsecret": app_secret,
                        "tr_id": _TR_ID,
                        "custtype": "P",
                    },
                )
                resp.raise_for_status()
                body = resp.json()
            except Exception as e:  # noqa: BLE001 — network/HTTP/JSON → one failure class
                raise KisHolidayFetchError(f"chk-holiday call failed: {e}") from e
            if body.get("rt_cd") != "0":
                raise KisHolidayFetchError(
                    f"chk-holiday rt_cd={body.get('rt_cd')} msg={body.get('msg1', '')[:100]}"
                )
            out = body.get("output")
            rows = out if isinstance(out, list) else [out] if isinstance(out, dict) else []
            if not rows:
                raise KisHolidayFetchError("chk-holiday returned no rows")
            pages.append(rows)
            last = max(str(r.get("bass_dt", "")) for r in rows)
            if last >= month_end:
                return _collect_month_from_pages(pages, year, month)
            # advance BASS_DT past the last returned row
            import datetime as _dt
            nxt = _dt.date(int(last[:4]), int(last[4:6]), int(last[6:8])) + _dt.timedelta(days=1)
            bass_dt = nxt.strftime("%Y%m%d")
    raise KisHolidayFetchError(
        f"month {year}-{month:02d} not covered after {_MAX_CALLS_PER_MONTH} calls"
    )
```

- [ ] **Step 5: Run tests**

Run: `uv run --extra dev pytest tests/unit/api/test_kis_holidays.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add hoga/api/kis_holidays.py tests/unit/api/test_kis_holidays.py tests/unit/api/fixtures/chk_holiday_20260601.json
git commit -m "feat(calendar): KIS chk-holiday sync fetch (opnd_yn, BASS_DT-advance loop)"
```

---

## Task 3: calendar 교체 + 에러코드 스왑 + 안내 문구

**Files:** Modify `hoga/api/calendar.py`, `hoga/api/error_codes.py`, `frontend/src/api/types.ts`, `frontend/src/api/upstream-hints.tsx`, `hoga/api/captures.py:23,1278-1285`, `hoga/api/watchlist_routes.py:32,106-108`, Test `tests/test_api_calendar.py`

- [ ] **Step 1: Error code swap (backend) — add KIS, delete KRX**

`hoga/api/error_codes.py`: `KRX_CREDENTIALS_MISSING`/`KRX_FETCH_FAILED`(line 56-57) 삭제, 그 자리에:

```python
    # KIS chk-holiday trading-day fetch failure (Phase 3) — covers creds-missing,
    # HTTP/rt_cd errors, and parse failures on the calendar path.
    KIS_HOLIDAY_FETCH_FAILED = "kis_holiday_fetch_failed"
```

(line 63 주석의 `KRX_FETCH_FAILED` 언급도 `KIS_MASTER_FETCH_FAILED`로 갱신.)

- [ ] **Step 2: Frontend union + ALL 5 exhaustive Records — SAME commit**

`frontend/src/api/types.ts`: union에서 `'krx_credentials_missing'`/`'krx_fetch_failed'` 제거, `'kis_holiday_fetch_failed'` 추가.

`frontend/src/api/upstream-hints.tsx`: **5개 Record 전부**에서 `krx_credentials_missing`/`krx_fetch_failed` 키 제거 + `kis_holiday_fetch_failed` 키 추가. 힌트 문구(맥락별):
- `symbolSearchHints`/`symbolMasterSettingsHints`: `<>거래일 조회 오류 — 종목 검색과는 무관합니다. KIS 키(.env의 KIS_APP_KEY/KIS_APP_SECRET)를 확인하세요.</>`
- `calendarHints`: `<>KIS에서 거래일을 가져오지 못해 휴일 표시가 정확하지 않을 수 있습니다 — .env의 KIS_APP_KEY/KIS_APP_SECRET을 확인하세요.</>`
- `enqueueErrorHints`: `<>범위 캡처 시작 실패 — KIS 거래일 조회 실패. .env의 KIS_APP_KEY/KIS_APP_SECRET을 확인하고 재시도하세요.</>`
- `captureFinishedHints`: `<>캡처 실패 — KIS 거래일 조회 오류.</>`

(Phase 2 교훈: union 변경과 Record 변경을 나누면 tsc red.)

- [ ] **Step 3: calendar.py — swap the fetch body, rename the exception**

(a) `KrxUnavailableError`(line 42-46) → rename:

```python
class TradingDayUnavailableError(RuntimeError):
    """Trading-day data unavailable (KIS chk-holiday failed).
    Carries an UpstreamCode for HTTP surfacing."""
    def __init__(self, code: UpstreamCode) -> None:
        super().__init__(f"trading days unavailable: {code.value}")
        self.code = code
```

(b) `_trading_days_for`(line 49-80) 본문 교체 — creds 체크 삭제, pykrx 삭제:

```python
def _trading_days_for(year: int, month: int) -> set[str] | None:
    """Return YYYYMMDD strings for trading days in (year, month) via KIS
    chk-holiday (opnd_yn). Returns None when the fetch fails (creds missing,
    network, rt_cd) — most recent reason via :func:`last_failure_reason`.
    Cached results from earlier successful fetches stay valid."""
    global _last_failure_reason  # noqa: PLW0603

    key = (year, month)
    cached = _month_cache.get(key)
    if cached is not None:
        return cached

    try:
        from hoga.api.kis_holidays import fetch_month_trading_days
        result = fetch_month_trading_days(year, month)
    except Exception:  # noqa: BLE001 — KisHolidayFetchError or worse
        _last_failure_reason = UpstreamCode.KIS_HOLIDAY_FETCH_FAILED
        return None
    _month_cache[key] = result
    _last_failure_reason = None
    return result
```

(c) `from hoga.env import krx_creds_present` import(line 24) 삭제. line 87-93 docstring의 KRX 언급 → KIS로. line 104의 `KrxUnavailableError(... or UpstreamCode.KRX_FETCH_FAILED)` → `TradingDayUnavailableError(... or UpstreamCode.KIS_HOLIDAY_FETCH_FAILED)`. 모듈 docstring(line 3)의 "KRX trading-day list" → "KIS trading-day list".

(d) `kis_holidays` 호출은 동기 블로킹(네트워크) — 기존과 동일하게 호출자들의 executor offload가 그대로 유효(`calendar_route` run_in_executor, captures의 `_expand_to_trading_days` offload). **변경 불필요** — SPEC §5.1.

- [ ] **Step 4: Update the two external catchers + messages**

`hoga/api/captures.py`: line 23 import → `TradingDayUnavailableError`. line 1278-1285의 catch + 503 메시지:

```python
        except TradingDayUnavailableError as e:
            raise HTTPException(status_code=503, detail={
                "code": e.code,
                "message": (
                    "Trading-day list unavailable (KIS). Configure KIS_APP_KEY / "
                    "KIS_APP_SECRET in repo-root .env and try again."
                ),
            }) from e
```

(주변 주석의 "pykrx-backed cold-month fetch" → "KIS-backed cold-month fetch".)

`hoga/api/watchlist_routes.py`: line 32 import rename, line 106 catch rename, line 108 주석의 `'configure KRX_ID/KRX_PW' hint` → `'configure KIS_APP_KEY/KIS_APP_SECRET' hint`.

`hoga/api/screener.py:37` 주석 "KRX 먹통" → "KIS 거래일 먹통", `:73`·`:136`·`hoga/api/scheduler.py:142` 주석 `KrxUnavailableError` → `TradingDayUnavailableError`.

- [ ] **Step 5: Update calendar tests**

`tests/test_api_calendar.py`(+ KrxUnavailableError를 import하는 테스트): pykrx monkeypatch → `hoga.api.kis_holidays.fetch_month_trading_days` monkeypatch(또는 `calendar._month_cache` pre-populate — 기존 권장 패턴 유지). `KRX_CREDENTIALS_MISSING`/`KRX_FETCH_FAILED` 단언 → `KIS_HOLIDAY_FETCH_FAILED`. creds-present 분기 테스트는 삭제(분기가 사라짐 — kis_holidays가 creds 부재 시 raise → 동일하게 None/폴백).

Run: `grep -rln "KrxUnavailableError\|KRX_CREDENTIALS_MISSING\|KRX_FETCH_FAILED\|get_market_ohlcv" tests/` 후 각각 갱신.

- [ ] **Step 6: Run backend + frontend**

Run: `uv run --extra dev pytest tests/ -q` → ALL PASS.
Run: `cd frontend && npx tsc -b && npx vitest run` → green (union·Record 동시 갱신 확인).

- [ ] **Step 7: Commit**

```bash
git add hoga/api/calendar.py hoga/api/error_codes.py hoga/api/captures.py hoga/api/watchlist_routes.py hoga/api/screener.py hoga/api/scheduler.py frontend/src/api/ tests/
git commit -m "feat(calendar): trading days from KIS chk-holiday; KRX error codes removed"
```

---

## Task 4: KRX 잔재 완전 제거 (구 Phase 4)

이 시점에 `krx_creds_present`/`KRX_ID`/`KRX_PW`/pykrx의 코드 사용처는 0이다. 잔재를 지운다.

**Files:** Modify `hoga/env.py`, `pyproject.toml:17`, `.env.example`, `CLAUDE.md`, `hoga/api/app.py:241`(주석), `hoga/api/calendar.py:226`(주석)

- [ ] **Step 1: Remove the dead credential helper + docs**

- `hoga/env.py`: `krx_creds_present()`(line 116-118) 삭제, line 15-16의 `KRX_ID, KRX_PW` 문서행 삭제. (먼저 `grep -rn "krx_creds_present" hoga/ tests/` → calendar 제거 후 0이어야 한다. 테스트가 import하면 그 테스트도 정리.)
- `pyproject.toml`: line 17 `"pykrx>=1.2.8",` 삭제. (`grep -rn "pykrx" hoga/` → 0 확인 후.)
- `.env.example`: `KRX_ID`/`KRX_PW` 항목 삭제, `KIS_APP_KEY`/`KIS_APP_SECRET` 항목이 없으면 추가(메모리상 빠져 있던 항목 — /live·달력에 필요).
- `CLAUDE.md`: "Set `KRX_ID` / `KRX_PW` ... per `.env.example`" 문장과 `krx_credentials_missing` 503 증상 설명을 KIS 기준으로 갱신(증상: 거래일은 `kis_holiday_fetch_failed`로 폴백, 종목 검색은 무인증 동작).
- `hoga/api/app.py:241` 주석의 KRX_ID/KRX_PW → KIS_APP_KEY/KIS_APP_SECRET. `hoga/api/calendar.py:226` 주석 "cold-month pykrx" → "cold-month KIS".

- [ ] **Step 2: Lockfile refresh for the removed dep**

Run: `uv lock` (pykrx 제거 반영) — 실패하거나 무관 대량 변경이 생기면 보고하고 lockfile은 별도 커밋으로 분리.

- [ ] **Step 3: Final grep — zero KRX**

Run: `grep -rni "pykrx\|krx_id\|krx_pw\|krx_creds\|KRX_CREDENTIALS\|KRX_FETCH_FAILED\|KrxUnavailable" hoga/ frontend/src/ tests/ pyproject.toml .env.example CLAUDE.md`
Expected: 0 lines. ("KRX"라는 단어 자체는 도메인 용어(한국거래소)로 CONTEXT.md 등 문서에 남는 게 정상 — credential/코드 식별자만 0이면 된다.)

- [ ] **Step 4: Run everything**

Run: `uv run --extra dev pytest tests/ -q` → ALL PASS.
Run: `cd frontend && npx tsc -b && npx vitest run` → green.

- [ ] **Step 5: Commit**

```bash
git add hoga/env.py pyproject.toml uv.lock .env.example CLAUDE.md hoga/api/app.py hoga/api/calendar.py tests/
git commit -m "chore: remove pykrx + KRX_ID/KRX_PW — KRX login fully replaced by KIS"
```

---

## Task 5: SPEC 마무리 + 최종 회귀

- [ ] **Step 1: SPEC 상태 갱신**

`docs/superpowers/specs/2026-06-05-krx-to-kis-migration-design.md`: 헤더 `상태: 설계 승인 대기` → `상태: 구현 완료 (2026-06-05, Phase 1~4)`. §6 노트에 "Phase 3에서 calendar·KRX 잔재 정리 완료" 한 줄 추가.

- [ ] **Step 2: 최종 전체 회귀**

Run: `uv run --extra dev pytest tests/ -q` + `cd frontend && npx tsc -b && npx vitest run`
Expected: 모두 green. 이게 "KRX 로그인 삭제 → KIS API 대체" 전체의 합격 기준.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-05-krx-to-kis-migration-design.md
git commit -m "docs(spec): KRX→KIS migration complete (Phases 1-4)"
```

---

## Self-Review

**Spec coverage:** §5.1 동기 유지(호출자 5파일 무변경 — Task 3(d)) ✓ / §5.2 provider 공유·동기 httpx(Task 2 `_resolve_provider`→kis_runtime→KisTokenProvider) ✓ / §5.2 방어적 BASS_DT 전진(실측 24행·2회/월 — Task 2 loop) ✓ / §5.3 `_trading_days_for` 속만 교체(캐시·폴백·반환형 불변 — Task 3(b)) ✓ / §5.4 폴백 유지(실패→None→평일) ✓ / §10 kis_runtime 추출(Task 1) ✓ / §6 calendar·env·captures·frontend·.env.example·CLAUDE.md 정리(Task 3-4) ✓.

**Phase 2 교훈 반영:** 프론트 union+5 Record 동시 갱신 명시(Task 3 Step 2), 실측 fixture(probe 저장본), grep-0 게이트, npm install된 worktree에서 tsc.

**Type consistency:** `KisHolidayFetchError`(T2) ↔ calendar catch(T3) / `UpstreamCode.KIS_HOLIDAY_FETCH_FAILED`(T3) ↔ 프론트 union·Record / `TradingDayUnavailableError`(T3) ↔ captures·watchlist import / `ensure_kis_token_provider_from_env`(T1) ↔ `_resolve_provider`(T2). ✓

**Placeholder scan:** 모든 step에 실제 코드/커맨드. 실측값 기반(가정 0). ✓
