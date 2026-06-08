# 안정성 원포인트 3건 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⑤ EGW00201 재시도 가시화(로그) · ⑦ 일봉 워크백 조기 종료 · ⑧ 장외 quotes 폴링 게이트(마지막 시세 유지) — 합계 ~35줄.

**Architecture:** 각 수정은 독립 파일·독립 커밋. ⑧은 백엔드(phase 'closed' + 라우터 수준 last-quotes 캐시) → 프론트(refetchInterval 함수) 순. Spec: `docs/superpowers/specs/2026-06-08-stability-one-pointers-design.md`.

**Tech Stack:** Python logging/caplog, httpx.MockTransport(기존 픽스처), FastAPI TestClient, React Query refetchInterval 함수, vitest.

---

## 핵심 맥락

- ⑤ 대상: `hoga/live/kis_client.py:304-326` `_get_with_rate_retry` — 현재 무로그, 모듈에 `logging` import 없음. 테스트 픽스처: `tests/unit/live/test_kis_client.py:241` `_make_attempt_counting_client(responses=[...], _rate_limit_backoff=...)` + `:287` 패턴(fake_sleep monkeypatch).
- ⑦ 대상: `kis_client.py:606-615` `fetch_past_daily_candles` 루프 꼬리 — 형제 `fetch_investor_net`의 `:722-724` (`if page_oldest is None or page_oldest <= from_yyyymmdd: break`)를 미러. 테스트 픽스처: `tests/unit/live/test_kis_rest_methods.py:362` walk-back 핸들러(`FID_INPUT_DATE_1` anchor → rows 매핑).
- ⑧ 대상: `hoga/live/api.py:313-317` `_quote_phase`(현재 pre_open/open 2상) + `:381-408` `_get_quotes`. 테스트: `tests/unit/live/test_live_quotes_route.py` — `live_api._quote_phase`를 monkeypatch하는 기존 관례 + `_FakeKis`/`_app` 픽스처. 프론트: `frontend/src/api/liveQuotes.ts`(+ `liveQuotes.test.tsx` 존재).
- 기존 표시 계약 유지: pre_open은 change_pct/change_won을 null로 — **closed는 open처럼 등락률 표시**(마지막 시세 = 종가+등락).

---

### Task 1: ⑤ EGW00201 재시도 가시화

**Files:**
- Modify: `hoga/live/kis_client.py` (import 1 + 로거 1 + 재시도 분기 ~5줄)
- Test: `tests/unit/live/test_kis_client.py`

- [ ] **Step 1: 실패 테스트 작성** — `test_get_retries_on_rate_limit_5xx_then_succeeds`(:287) 아래에:

```python
@pytest.mark.asyncio
async def test_rate_limit_retry_is_logged(monkeypatch, caplog) -> None:
    """스펙 2026-06-08 ⑤: 재시도는 +1~7s의 침묵 지연이었다 — 첫 재시도는
    WARNING(운영 신호), 이후 재시도는 DEBUG(병렬 fetch 동시 재시도 로그 벽 방지)."""
    import logging

    async def fake_sleep(s: float) -> None:
        return

    monkeypatch.setattr("hoga.live.kis_client.asyncio.sleep", fake_sleep)
    client, _counter = _make_attempt_counting_client(
        responses=[
            (500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "too fast"}),
            (500, {"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "too fast"}),
            (200, _ok_orderbook_body()),
        ],
        _rate_limit_backoff=(1.0, 2.0, 4.0),
    )
    try:
        with caplog.at_level(logging.DEBUG, logger="hoga.live.kis_client"):
            await client._get(path="/uapi/probe", tr_id="PROBE0000", params={})
    finally:
        await client.aclose()
    retry_logs = [r for r in caplog.records if "EGW00201" in r.message]
    assert len(retry_logs) == 2
    assert retry_logs[0].levelno == logging.WARNING
    assert "/uapi/probe" in retry_logs[0].message and "1/3" in retry_logs[0].message
    assert retry_logs[1].levelno == logging.DEBUG
```

- [ ] **Step 2: RED 확인** — Run: `uv run pytest tests/unit/live/test_kis_client.py::test_rate_limit_retry_is_logged -q`
Expected: FAIL — `assert len(retry_logs) == 2` 에서 0 (로그 없음).

- [ ] **Step 3: 구현** — `kis_client.py` 상단 import 블록(`import asyncio` 근처)에 `import logging` 추가(이미 있으면 생략 — 현재 없음), 모듈 상수부에:

```python
log = logging.getLogger(__name__)
```

`_get_with_rate_retry`의 except 분기를:

```python
            except KisRateLimitError:
                if attempt + 1 >= attempts:
                    raise
                # 가시화(스펙 2026-06-08 ⑤): 첫 재시도만 WARNING — 지속 장애 시
                # 병렬 fetch(동시 5)의 동시 재시도가 로그 벽이 되지 않게 이후는
                # DEBUG. 소진 후엔 호출부의 kis_rate_limit data_warning이 최종 신호.
                log_fn = log.warning if attempt == 0 else log.debug
                log_fn("KIS rate-limited (EGW00201) path=%s — retry %d/%d in %.0fs",
                       path, attempt + 1, attempts - 1, backoff[attempt])
                await asyncio.sleep(backoff[attempt])
```

- [ ] **Step 4: GREEN + 파일 회귀** — Run: `uv run pytest tests/unit/live/test_kis_client.py -q` → 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_client.py
git commit -m "feat(kis): EGW00201 재시도 가시화 — 첫 재시도 WARNING, 이후 DEBUG (스펙 ⑤)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: ⑦ 일봉 워크백 조기 종료

**Files:**
- Modify: `hoga/live/kis_client.py` (~4줄)
- Test: `tests/unit/live/test_kis_rest_methods.py`

- [ ] **Step 1: 실패 테스트 작성** — fetch_past_daily 테스트 군(:176 부근) 뒤에 추가. 기존 `:362` walk-back 핸들러 관례(FID_INPUT_DATE_1 anchor 매핑 + 호출 기록)를 따른다:

```python
@pytest.mark.asyncio
async def test_fetch_past_daily_stops_at_from_without_extra_call(tmp_path) -> None:
    """스펙 2026-06-08 ⑦: 페이지가 요청 시작일(from)까지 도달하면 즉시 종료 —
    형제 fetch_investor_net과 동일 분기. 없으면 빈 응답을 받는 헛 KIS 콜이
    1회 더 나간다(콜드 갭마다 +1, 일봉 차트 열어둔 동안 today 프로브 분당 +1)."""
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        calls.append(req.url.params.get("FID_INPUT_DATE_2", ""))
        # 한 페이지로 from(20240101)까지 전부 커버 — 더 부를 이유가 없다.
        rows = [
            {"stck_bsop_date": d, "stck_oprc": "100", "stck_hgpr": "110",
             "stck_lwpr": "95", "stck_clpr": "105", "acml_vol": "10"}
            for d in ("20240103", "20240102", "20240101")
        ]
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "",
                                         "output2": rows})

    client = _make_client(handler, tmp_path)
    try:
        result = await client.fetch_past_daily_candles("005930", "20240101", "20240103")
    finally:
        await client.aclose()
    assert len(result.candles) == 3
    assert len(calls) == 1, f"from 도달 후 헛 콜 발생: anchors={calls}"
```

(주의: 핸들러의 row 필드명은 같은 파일의 기존 daily 테스트(:176 `test_fetch_past_daily_clean_response`)가 쓰는 필드명과 반드시 일치시킨다 — 다르면 그 테스트의 row 빌더를 복사해 사용. `FID_INPUT_DATE_2`가 cursor 파라미터가 아니면 기존 테스트가 단언하는 파라미터명으로 교체. **콜 수 단언이 본질**이고 anchor 기록은 디버그용.)

- [ ] **Step 2: RED 확인** — Run: `uv run pytest tests/unit/live/test_kis_rest_methods.py::test_fetch_past_daily_stops_at_from_without_extra_call -q`
Expected: FAIL — `assert len(calls) == 1`에서 2 (from 도달 후 한 번 더 부름).
(다른 사유로 실패하면 — 필드명/파라미터명 불일치 — Step 1 주의사항대로 fixture를 고친 뒤 재확인.)

- [ ] **Step 3: 구현** — `kis_client.py` `fetch_past_daily_candles` 루프 꼬리(:611-615)를:

```python
            if page_earliest is None:
                # No new valid candle to anchor cursor walk-back; rely on the
                # next iteration's empty/no-progress check to terminate.
                continue
            if page_earliest <= from_yyyymmdd:
                # 요청 시작일까지 도달 — 즉시 종료(스펙 2026-06-08 ⑦,
                # fetch_investor_net과 동일 분기). 이 분기가 없으면 빈 응답을
                # 받는 헛 콜이 1회 더 나간다.
                break
            cursor_to = _prev_day_yyyymmdd(page_earliest)
```

- [ ] **Step 4: GREEN + 파일 회귀** — Run: `uv run pytest tests/unit/live/test_kis_rest_methods.py -q` → 전부 PASS (기존 페이지네이션 테스트 포함).

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_rest_methods.py
git commit -m "fix(kis): 일봉 워크백 from 도달 시 조기 종료 — 헛 KIS 콜 제거 (스펙 ⑦)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: ⑧ 백엔드 — phase 'closed' + 마지막 시세 캐시

**Files:**
- Modify: `hoga/live/api.py` (`_quote_phase` 교체 + `_get_quotes`에 캐시/closed 분기 ~20줄)
- Test: `tests/unit/live/test_live_quotes_route.py`

- [ ] **Step 1: 실패 테스트 작성** — 기존 테스트들 아래에 (기존 `_FakeKis`/`_app` 픽스처와 `live_api._quote_phase` monkeypatch 관례 재사용; 콜 수 세는 fake는 새로 정의):

```python
from datetime import datetime as _dt


def test_quote_phase_clock_boundaries():
    """스펙 2026-06-08 ⑧: 평일 08:50–16:00만 폴링 가치 구간. KRX 동시호가
    08:50 시작(사용자 정정 — 구 08:30 아님). 2026-06-08은 월요일."""
    mk = lambda h, m: _dt(2026, 6, 8, h, m, tzinfo=_KST)  # noqa: E731
    assert _quote_phase(mk(8, 49)) == "closed"
    assert _quote_phase(mk(8, 50)) == "pre_open"
    assert _quote_phase(mk(9, 0)) == "open"
    assert _quote_phase(mk(15, 59)) == "open"
    assert _quote_phase(mk(16, 0)) == "closed"
    # 토요일(2026-06-13) 장중 시각도 closed
    assert _quote_phase(_dt(2026, 6, 13, 10, 0, tzinfo=_KST)) == "closed"


class _CountingFakeKis:
    def __init__(self, quotes):
        self._quotes = quotes
        self.calls = 0

    async def fetch_multi_price(self, codes):
        self.calls += 1
        return self._quotes


def _counting_app(fake):
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        get_kis_client=(lambda: fake),
    ))
    return app


def test_quotes_closed_serves_last_seen_without_kis(monkeypatch):
    """closed에는 장중 마지막 시세를 KIS 무호출로 서빙('마지막 시세 유지' 결정).
    등락률은 open과 동일하게 표시(종가+등락 — pre_open과 다름)."""
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    r1 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r1.json()["quotes"][0]["price"] == 72400
    assert fake.calls == 1
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "closed")
    r2 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    body = r2.json()
    assert fake.calls == 1, "closed에서 캐시 보유 코드에 KIS 호출 발생"
    assert body["phase"] == "closed"
    assert body["quotes"][0]["price"] == 72400
    assert body["quotes"][0]["change_pct"] == 1.2   # closed는 등락률 유지
    assert body["quotes"][1]["change_won"] == -1500


def test_quotes_closed_cold_start_fetches_once(monkeypatch):
    """closed 콜드 스타트(서버 재시작 직후): 캐시 미스면 정확히 1회만 KIS를
    불러 채우고(KIS는 장외에도 종가 반환), 이후 요청은 캐시 서빙."""
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "closed")
    r1 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert fake.calls == 1
    assert r1.json()["quotes"][0]["price"] == 72400
    r2 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert fake.calls == 1, "콜드 스타트 이후에도 KIS 재호출"
    assert r2.json()["quotes"][1]["price"] == 183500
```

- [ ] **Step 2: RED 확인** — Run: `uv run pytest tests/unit/live/test_live_quotes_route.py -q`
Expected: 신규 3개 FAIL — boundaries는 `_quote_phase`가 "closed"를 모름(08:49→"pre_open"), closed 2종은 fetch가 무단락이라 calls 증가.

- [ ] **Step 3: 구현 — wire 모델 + `_quote_phase` 교체** (api.py:308-317).

먼저 pydantic 모델의 phase Literal에 "closed" 추가 — **빠뜨리면 라우트가
`response_model` 재검증에서 ValidationError → 500** (advisor 검증 지적):

```python
class LiveQuotesResponse(BaseModel):
    phase: Literal["pre_open", "open", "closed"]
    quotes: list[LiveQuote]
```

이어서 `_quote_phase` 교체:

```python
def _quote_phase(now: datetime) -> Literal["pre_open", "open", "closed"]:
    """/quotes 오버레이의 폴링·표시 게이트(스펙 2026-06-08 ⑧).
    closed: 주말 또는 평일 08:50 이전·16:00 이후 — 프론트가 폴링을 600s로
    줄이고 백엔드는 마지막 시세 캐시로 응답한다('마지막 시세 유지' 결정).
    pre_open: 08:50–09:00 동시호가(KRX 08:50 시작) — 등락률 숨김(기존 계약).
    시계 기반 — 평일 공휴일의 드문 낭비는 수용(캘린더 게이트는 동기 KIS HTTP
    재도입이라 배제). session_gate.market_phase와 계약이 달라 이름 분리 유지."""
    if now.weekday() >= 5:  # noqa: PLR2004 — 토/일
        return "closed"
    t = now.time()
    if t < time(8, 50) or t >= time(16, 0):
        return "closed"
    return "pre_open" if t < time(9, 0) else "open"
```

- [ ] **Step 4: 구현 — `_get_quotes` 캐시 + closed 분기.** `build_router` 안 `_get_quotes` 정의 **위**에 라우터 수준 캐시 추가:

```python
    # 장중 마지막 quotes — closed 서빙용(스펙 2026-06-08 ⑧ '마지막 시세 유지',
    # ADR-0056 결: 표시 전용·디스크 미영속). ADR-0038 단일 워커라 dict로 충분.
    _last_quotes: dict[str, KisQuote] = {}
```

`_get_quotes` 본문에서 `if kis is None: return ...` 가드 **아래**, 기존 `try: quotes = await kis.fetch_multi_price(...)` **위**에 closed 분기 삽입:

```python
        if phase == "closed":
            # 장외: 마지막 시세 서빙. 캐시 미스(재시작 직후)면 1회만 KIS를 불러
            # 채운다 — KIS는 장외에도 종가를 반환. 프론트는 closed에 600s
            # 하트비트라 이 경로의 KIS 콜은 사실상 드로어 마운트 시 1회뿐.
            missing = [c for c in code_list if c not in _last_quotes]
            if missing:
                try:
                    for q in await kis.fetch_multi_price(code_list):
                        _last_quotes[q.code] = q
                except Exception as e:  # noqa: BLE001 — 오버레이는 절대 500 금지
                    log.warning("live quotes cold fetch failed (%d codes): %s",
                                len(code_list), e)
            return LiveQuotesResponse(phase=phase, quotes=[
                LiveQuote(code=q.code, price=q.price,
                          change_pct=q.change_pct, change_won=q.change_won)
                for c in code_list
                if (q := _last_quotes.get(c)) is not None
            ])
```

기존 성공 경로(`quotes = await kis.fetch_multi_price(code_list)` 다음 줄)에 캐시 갱신 1줄:

```python
        for q in quotes:
            _last_quotes[q.code] = q
```

`KisQuote` import 확인: api.py 상단에 없으면 `from hoga.live.kis_client import KisApiError, KisRateLimitError` 라인에 `KisQuote` 추가.

- [ ] **Step 5: GREEN + 파일 회귀** — Run: `uv run pytest tests/unit/live/test_live_quotes_route.py -q` → 전부 PASS (기존 open/pre_open/graceful 테스트 포함 — 이들은 `_quote_phase`를 monkeypatch하므로 시계 변경의 영향 없음).

- [ ] **Step 6: 커밋**

```bash
git add hoga/live/api.py tests/unit/live/test_live_quotes_route.py
git commit -m "feat(api): quotes phase 'closed' + 마지막 시세 캐시 — 장외 KIS 호출 차단 (스펙 ⑧)

폴링 창 평일 08:50–16:00 (KRX 동시호가 08:50). closed는 장중 마지막
quotes를 서빙(등락률 유지), 콜드 스타트는 1회 fetch로 보정.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: ⑧ 프론트 — closed 시 600s 하트비트

**Files:**
- Modify: `frontend/src/api/liveQuotes.ts` (~6줄)
- Test: `frontend/src/api/liveQuotes.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `liveQuotes.test.tsx`에 (파일의 기존 import 관례에 vitest `expect/it` 사용):

```typescript
import { quotesRefetchInterval } from './liveQuotes';

describe('quotesRefetchInterval', () => {
  it('closed면 600s 하트비트 — false 금지(다음 개장에 폴링 재개 불가)', () => {
    expect(quotesRefetchInterval('closed')).toBe(600_000);
  });
  it('open/pre_open/미도착(undefined)은 10s 유지', () => {
    expect(quotesRefetchInterval('open')).toBe(10_000);
    expect(quotesRefetchInterval('pre_open')).toBe(10_000);
    expect(quotesRefetchInterval(undefined)).toBe(10_000);
  });
});
```

(기존 테스트 파일이 describe/it 대신 다른 구조면 그 관례를 따른다.)

- [ ] **Step 2: RED 확인** — Run: `cd frontend && npx vitest run src/api/liveQuotes.test.tsx 2>&1 | tail -5`
Expected: FAIL — `quotesRefetchInterval` export 없음.

- [ ] **Step 3: 구현** — `liveQuotes.ts`:

phase 타입 확장:

```typescript
export interface LiveQuotesResponse {
  phase: 'pre_open' | 'open' | 'closed';
  quotes: LiveQuote[];
}
```

export 함수 추가 + useQuery 적용:

```typescript
/** closed(평일 08:50–16:00 밖·주말)면 600s 하트비트 — `false`로 완전히 끄면
 *  React Query가 재평가할 계기가 없어 다음 개장에 폴링이 재개되지 않는다.
 *  600s는 08:50 후 최대 10분 내 자동 복귀하면서 일일 폴링 ~69% 절감
 *  (스펙 2026-06-08 ⑧). */
export function quotesRefetchInterval(phase: string | undefined): number {
  return phase === 'closed' ? 600_000 : 10_000;
}
```

`useQuotes`의 `refetchInterval: 10_000`을:

```typescript
    refetchInterval: (q) => quotesRefetchInterval(q.state.data?.phase),
```

- [ ] **Step 4: GREEN + 프론트 회귀** — Run: `cd frontend && npx vitest run src/api/ 2>&1 | tail -5` → 전부 PASS. 타입 체크: `cd frontend && npx tsc --noEmit 2>&1 | tail -3` → 에러 0.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/api/liveQuotes.ts frontend/src/api/liveQuotes.test.tsx
git commit -m "feat(frontend): quotes closed 시 600s 하트비트 — 장외 폴링 ~69% 절감 (스펙 ⑧)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 전체 회귀 + spec 상태 갱신

- [ ] **Step 1: 백엔드 전체** — Run: `uv run pytest -q` → 기준선 1307 passed + 신규 5 = **1312 passed, 4 skipped** 기대.
- [ ] **Step 2: 프론트 전체** — Run: `cd frontend && npx vitest run 2>&1 | tail -4` → 전부 PASS.
- [ ] **Step 3: 린트** — Run: `uv run ruff check hoga/live/kis_client.py hoga/live/api.py` → 신규 위반 0 (baseline 외).
- [ ] **Step 4: spec Status 갱신** — `- **Status**: Approved ...` 줄을 `- **Status**: Implemented (2026-06-08)`로 교체 후:

```bash
git add docs/superpowers/specs/2026-06-08-stability-one-pointers-design.md
git commit -m "docs(spec): 안정성 원포인트 3건 Status → Implemented

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
