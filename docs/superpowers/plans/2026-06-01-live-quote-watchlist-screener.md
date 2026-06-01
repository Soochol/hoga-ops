# 관심종목·스크리너 라이브 등락률(현재가) 컬럼 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오른쪽 레일의 관심종목·스크리너 패널 행을 공유 컴포넌트로 통일하고, 각 종목의 **세션단계별 라이브 등락률 + 현재가**(장전=숨김, 장중=실시간, 장마감=종가)를 KIS에서 가져와 표시한다.

**Architecture:** 데이터 경로 2개를 분리한다 — (1) *찾기/필터* = 스크리너 일봉 코퍼스(`daily_adjusted.parquet`, EOD, **불변**), (2) *표시* = KIS `intstock-multprice`(FHKST11300006, 30종목/콜)로 현재가·등락률을 10초 폴링해 행에 오버레이. 백엔드 신규 `GET /api/live/quotes`가 세션단계를 판정해 장전이면 등락률을 `null`로 게이트. 프론트는 공유 `QuoteRow` + `useQuotes` 훅을 두 드로어가 재사용.

**Tech Stack:** Backend — FastAPI, KisClient(`hoga/live/kis_client.py`), pytest(`uv run --extra dev pytest`). Frontend — React + Vite, @tanstack/react-query, vitest + @testing-library/react, Tailwind + CSS 토큰.

**진행: 단계적.** **Phase 1 (P1) = 관심종목** (Task 1–7) — 백엔드 + 공유 컴포넌트 + WatchlistDrawer. 원 요청을 저위험으로 전달. **Phase 2 (P2) = 스크리너 드로어 라이브 전환** (Task 8) — 작동·테스트된 코드 변경이라 분리하되 P1의 공유 컴포넌트를 그대로 재사용(중복 0). **Phase 3 = 문서화** (Task 9–10).

---

## File Structure

**Backend**
- Modify `hoga/live/kis_client.py` — `KisQuote` dataclass + 순수 헬퍼(`_build_multi_price_params`, `_parse_quote`) + `_fetch_multi_price(get, codes)` + `KisClient.fetch_multi_price`. KIS `intstock-multprice` 단일 ingress.
- Modify `hoga/live/api.py` — `LiveQuote`/`LiveQuotesResponse` 모델 + `_market_phase()` + `GET /api/live/quotes` 라우트.

**Frontend**
- Create `frontend/src/api/liveQuotes.ts` — `getQuotes(codes)` + `useQuotes(codes)`.
- Create `frontend/src/rightrail/QuoteRow.tsx` — 공유 행(코드│이름│현재가│등락률). `ChangeCell` 재사용.
- Modify `frontend/src/watchlist/WatchlistDrawer.tsx` — inline `WatchlistRow` 제거, `QuoteRow` + `useQuotes` 채택. (P1)
- Modify `frontend/src/screener/ScreenerDrawer.tsx` — `ScreenerResultRow` 제거, `QuoteRow` + `useQuotes`(상위 30 cap). (P2)

**Tests**
- Create `tests/unit/live/test_kis_multi_price.py`
- Create `tests/unit/live/test_live_quotes_route.py`
- Create `frontend/src/rightrail/QuoteRow.test.tsx`
- Modify `frontend/src/watchlist/WatchlistDrawer.test.tsx`
- Modify `frontend/src/screener/ScreenerDrawer.test.tsx` (P2)

**Docs**
- Modify `CONTEXT.md`, Create `docs/adr/0055-live-quote-overlay.md`

---

## Phase 1 — 관심종목 (P1)

### Task 1: KIS 응답 파싱 — 순수 헬퍼 + KisQuote

**Files:**
- Modify: `hoga/live/kis_client.py`
- Test: `tests/unit/live/test_kis_multi_price.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/live/test_kis_multi_price.py
from hoga.live.kis_client import KisQuote, _parse_quote, _build_multi_price_params


def test_parse_quote_up_sign_positive():
    # prdy_vrss_sign 2 = 상승 → 양수, inter2_prpr → price
    q = _parse_quote("005930", {"inter2_prpr": "72400", "prdy_ctrt": "1.20", "prdy_vrss_sign": "2"})
    assert q == KisQuote(code="005930", price=72400, change_pct=1.20)


def test_parse_quote_down_sign_forces_negative():
    # 부호 5(하락)는 prdy_ctrt 가 부호 없이 와도 음수로 정규화
    q = _parse_quote("000660", {"inter2_prpr": "183500", "prdy_ctrt": "0.80", "prdy_vrss_sign": "5"})
    assert q.change_pct == -0.80
    assert q.price == 183500


def test_parse_quote_flat_sign_zero():
    q = _parse_quote("000020", {"inter2_prpr": "10000", "prdy_ctrt": "0.00", "prdy_vrss_sign": "3"})
    assert q.change_pct == 0.0


def test_parse_quote_missing_ctrt_is_none():
    q = _parse_quote("123456", {"inter2_prpr": "5000", "prdy_ctrt": "", "prdy_vrss_sign": ""})
    assert q.change_pct is None
    assert q.price == 5000


def test_build_multi_price_params_numbered_keys():
    p = _build_multi_price_params(["005930", "000660"])
    assert p["FID_COND_MRKT_DIV_CODE_1"] == "J" and p["FID_INPUT_ISCD_1"] == "005930"
    assert p["FID_COND_MRKT_DIV_CODE_2"] == "J" and p["FID_INPUT_ISCD_2"] == "000660"
    assert "FID_INPUT_ISCD_3" not in p
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_multi_price.py -v`
Expected: FAIL with `ImportError: cannot import name 'KisQuote'` (or `_parse_quote`).

- [ ] **Step 3: Write minimal implementation**

`hoga/live/kis_client.py` 상단의 dataclass 정의들 근처(기존 `KisCandle`/`KisOrderbook` 패턴 옆)에 추가:

```python
@dataclass(frozen=True)
class KisQuote:
    """One row of intstock-multprice (현재가 + 등락률) for a Code."""
    code: str
    price: int
    change_pct: float | None
```

모듈 레벨 순수 헬퍼(클래스 밖, 파일 하단의 `fetch_*` 군 근처)에 추가:

```python
_MULTI_PRICE_CHUNK = 30  # intstock-multprice: 최대 30종목/콜 (FHKST11300006)


def _build_multi_price_params(codes_chunk: list[str]) -> dict[str, str]:
    """FID_COND_MRKT_DIV_CODE_N / FID_INPUT_ISCD_N (N=1..30) 번호 키 빌드."""
    params: dict[str, str] = {}
    for n, c in enumerate(codes_chunk, start=1):
        params[f"FID_COND_MRKT_DIV_CODE_{n}"] = _STOCK_MRKT_DIV  # "J"
        params[f"FID_INPUT_ISCD_{n}"] = c
    return params


def _parse_quote(code: str, row: dict) -> KisQuote:
    """multprice output 한 항목 → KisQuote.

    price = inter2_prpr. change_pct = prdy_ctrt(절대값) 에 prdy_vrss_sign 적용
    (1·2 상한/상승=양수, 4·5 하한/하락=음수, 3 보합=0). prdy_ctrt 가 빈값이면 None.
    """
    raw_price = row.get("inter2_prpr") or "0"
    price = int(float(raw_price))
    raw_ctrt = row.get("prdy_ctrt")
    if raw_ctrt in (None, ""):
        return KisQuote(code=code, price=price, change_pct=None)
    mag = abs(float(raw_ctrt))
    sign = str(row.get("prdy_vrss_sign", ""))
    if sign in ("4", "5"):
        pct = -mag
    elif sign in ("1", "2"):
        pct = mag
    else:
        pct = 0.0 if mag == 0 else float(raw_ctrt)
    return KisQuote(code=code, price=price, change_pct=pct)
```

(`_STOCK_MRKT_DIV` 는 이미 모듈에 정의되어 있음 — `fetch_orderbook` 가 사용. 없다면 `_STOCK_MRKT_DIV = "J"` 확인.)

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_multi_price.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_multi_price.py
git commit -m "feat(live): KisQuote + intstock-multprice parse helpers"
```

---

### Task 2: KisClient.fetch_multi_price (청크 + _get 루프)

**Files:**
- Modify: `hoga/live/kis_client.py`
- Test: `tests/unit/live/test_kis_multi_price.py` (확장)

- [ ] **Step 1: Write the failing test**

`get` 의존성을 주입받는 순수 오케스트레이터를 테스트한다(실제 KisClient 인스턴스 불필요).

```python
# tests/unit/live/test_kis_multi_price.py 에 추가
import pytest
from hoga.live.kis_client import _fetch_multi_price


@pytest.mark.asyncio
async def test_fetch_multi_price_chunks_over_30_and_zips_order():
    calls: list[dict] = []

    async def fake_get(*, path, tr_id, params):
        calls.append(params)
        # output 순서 = 입력 순서. 청크 내 코드 수만큼 행 반환.
        n = sum(1 for k in params if k.startswith("FID_INPUT_ISCD_"))
        return {"output": [
            {"inter2_prpr": "100", "prdy_ctrt": "1.00", "prdy_vrss_sign": "2"} for _ in range(n)
        ]}

    codes = [f"{i:06d}" for i in range(35)]  # 35개 → 30 + 5 두 청크
    quotes = await _fetch_multi_price(fake_get, codes)

    assert len(calls) == 2  # 청킹
    assert [q.code for q in quotes] == codes  # 입력 순서 보존
    assert all(q.change_pct == 1.0 for q in quotes)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_multi_price.py::test_fetch_multi_price_chunks_over_30_and_zips_order -v`
Expected: FAIL with `ImportError: cannot import name '_fetch_multi_price'`.

- [ ] **Step 3: Write minimal implementation**

`hoga/live/kis_client.py` 에 모듈 레벨 오케스트레이터 + 얇은 메서드 추가:

```python
async def _fetch_multi_price(get, codes: list[str]) -> list["KisQuote"]:
    """get: async (*, path, tr_id, params)->dict (KisClient._get 와 동일 시그니처).
    30개씩 청크해 intstock-multprice 호출, output 을 입력 순서로 zip."""
    out: list[KisQuote] = []
    for i in range(0, len(codes), _MULTI_PRICE_CHUNK):
        chunk = codes[i:i + _MULTI_PRICE_CHUNK]
        body = await get(
            path="/uapi/domestic-stock/v1/quotations/intstock-multprice",
            tr_id="FHKST11300006",
            params=_build_multi_price_params(chunk),
        )
        rows = body.get("output") or []
        for c, row in zip(chunk, rows):
            out.append(_parse_quote(c, row))
    return out
```

`KisClient` 클래스 안(다른 `fetch_*` 메서드 옆):

```python
    async def fetch_multi_price(self, codes: list[str]) -> list[KisQuote]:
        """관심종목/스크리너 결과 코드들의 현재가+등락률 (intstock-multprice)."""
        return await _fetch_multi_price(
            lambda *, path, tr_id, params: self._get(path=path, tr_id=tr_id, params=params),
            codes,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_multi_price.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_multi_price.py
git commit -m "feat(live): KisClient.fetch_multi_price (chunked, order-preserving)"
```

---

### Task 3: GET /api/live/quotes + 세션단계 게이트

**Files:**
- Modify: `hoga/live/api.py`
- Test: `tests/unit/live/test_live_quotes_route.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/live/test_live_quotes_route.py
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hoga.live import lifecycle, api as live_api
from hoga.live.api import build_router
from hoga.live.kis_client import KisQuote


class _FakeKis:
    def __init__(self, quotes): self._quotes = quotes
    async def fetch_multi_price(self, codes): return self._quotes


def _app(quotes, kis=True):
    fake = _FakeKis(quotes) if kis else None
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        get_kis_client=(lambda: fake),
    ))
    return app


QUOTES = [KisQuote("005930", 72400, 1.2), KisQuote("000660", 183500, -0.8)]


def test_quotes_open_returns_change_pct(monkeypatch):
    monkeypatch.setattr(live_api, "_market_phase", lambda now: "open")
    c = TestClient(_app(QUOTES))
    r = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    body = r.json()
    assert body["phase"] == "open"
    assert body["quotes"][0] == {"code": "005930", "price": 72400, "change_pct": 1.2}
    assert body["quotes"][1]["change_pct"] == -0.8


def test_quotes_pre_open_nulls_change_pct(monkeypatch):
    monkeypatch.setattr(live_api, "_market_phase", lambda now: "pre_open")
    c = TestClient(_app(QUOTES))
    r = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    body = r.json()
    assert body["phase"] == "pre_open"
    assert all(q["change_pct"] is None for q in body["quotes"])  # 장전 숨김
    assert body["quotes"][0]["price"] == 72400  # 현재가는 유지


def test_quotes_no_kis_graceful_empty(monkeypatch):
    monkeypatch.setattr(live_api, "_market_phase", lambda now: "open")
    c = TestClient(_app(QUOTES, kis=False))
    r = c.get("/api/live/quotes", params={"codes": "005930"})
    assert r.status_code == 200
    assert r.json()["quotes"] == []


def test_quotes_filters_invalid_codes(monkeypatch):
    seen = {}
    class _Rec(_FakeKis):
        async def fetch_multi_price(self, codes): seen["codes"] = codes; return []
    monkeypatch.setattr(live_api, "_market_phase", lambda now: "open")
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, get_kis_client=lambda: _Rec([])))
    TestClient(app).get("/api/live/quotes", params={"codes": "005930,BADCODE,00066"})
    assert seen["codes"] == ["005930"]  # 6자리만 통과
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/unit/live/test_live_quotes_route.py -v`
Expected: FAIL — 404 on `/api/live/quotes` (route not defined) / `_market_phase` AttributeError.

- [ ] **Step 3: Write minimal implementation**

`hoga/live/api.py` — `ControlRequest` 클래스 근처에 모델 + 헬퍼:

```python
class LiveQuote(BaseModel):
    code: str
    price: int
    change_pct: float | None


class LiveQuotesResponse(BaseModel):
    phase: Literal["pre_open", "open"]
    quotes: list[LiveQuote]


def _market_phase(now: datetime) -> Literal["pre_open", "open"]:
    """장전(거래일 여부 무관 09:00 이전) = 등락률 숨김. 09:00 이후 = 표시.
    오픈 09:00 은 반장에도 동일하므로 경계 하나로 충분. (주말 이른 아침은
    잠깐 숨김 — 무해; 거래일 정밀 판정이 필요해지면 calendar 로 보강.)"""
    return "pre_open" if now.time() < time(9, 0) else "open"
```

`build_router` 안, `/past-daily-candles` 라우트 근처에 추가:

```python
    @router.get("/quotes", response_model=LiveQuotesResponse)
    async def _get_quotes(codes: str = Query(...)) -> LiveQuotesResponse:
        phase = _market_phase(datetime.now(_KST))
        code_list = [c for c in codes.split(",") if _CODE_RE.match(c)]
        kis = get_kis_client() if get_kis_client is not None else None
        if kis is None or not code_list:
            return LiveQuotesResponse(phase=phase, quotes=[])
        try:
            quotes = await kis.fetch_multi_price(code_list)
        except (KisRateLimitError, KisApiError):
            return LiveQuotesResponse(phase=phase, quotes=[])
        pre = phase == "pre_open"
        return LiveQuotesResponse(phase=phase, quotes=[
            LiveQuote(code=q.code, price=q.price,
                      change_pct=(None if pre else q.change_pct))
            for q in quotes
        ])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/unit/live/test_live_quotes_route.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_live_quotes_route.py
git commit -m "feat(live): GET /api/live/quotes with pre-open change_pct gate"
```

---

### Task 4: 프론트 API — getQuotes + useQuotes

**Files:**
- Create: `frontend/src/api/liveQuotes.ts`

- [ ] **Step 1: Write the implementation**

(이 파일은 얇은 데이터 레이어 — 동작 테스트는 Task 5·6의 컴포넌트 테스트에서 mock 으로 커버.)

```ts
// frontend/src/api/liveQuotes.ts
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface LiveQuote {
  code: string;
  price: number;
  change_pct: number | null;
}

export interface LiveQuotesResponse {
  phase: 'pre_open' | 'open';
  quotes: LiveQuote[];
}

export function getQuotes(codes: string[]): Promise<LiveQuotesResponse> {
  return apiCall<LiveQuotesResponse>(`/api/live/quotes?codes=${codes.join(',')}`);
}

/** 코드 목록의 현재가+등락률을 10초 폴링. codes 비면 비활성. */
export function useQuotes(codes: string[]) {
  return useQuery({
    queryKey: ['live-quotes', codes.join(',')],
    queryFn: () => getQuotes(codes),
    enabled: codes.length > 0,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/liveQuotes.ts
git commit -m "feat(fe): live-quotes api + useQuotes 10s polling hook"
```

---

### Task 5: 공유 행 컴포넌트 QuoteRow

**Files:**
- Create: `frontend/src/rightrail/QuoteRow.tsx`
- Test: `frontend/src/rightrail/QuoteRow.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/rightrail/QuoteRow.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuoteRow } from './QuoteRow';

function row(props: Partial<React.ComponentProps<typeof QuoteRow>> = {}) {
  const onClick = vi.fn();
  render(
    <ul>
      <QuoteRow code="005930" name="삼성전자" price={72400} pct={1.2}
        active={false} ariaLabel="삼성전자 005930 차트 열기"
        testId="quote-row-005930" onClick={onClick} {...props} />
    </ul>,
  );
  return { onClick };
}

describe('QuoteRow', () => {
  it('renders code, name, price (ko-KR), and signed change %', () => {
    row();
    expect(screen.getByText('005930')).toBeInTheDocument();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    expect(screen.getByText('72,400')).toBeInTheDocument();
    expect(screen.getByText(/\+1\.20%/)).toBeInTheDocument();
  });

  it('renders — for null pct (장전/무데이터)', () => {
    row({ pct: null });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('Enter key triggers onClick (keyboard a11y)', () => {
    const { onClick } = row();
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/rightrail/QuoteRow.test.tsx`
Expected: FAIL — cannot resolve `./QuoteRow`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/rightrail/QuoteRow.tsx
import { ChangeCell } from '../screener/ChangeCell';

/** 관심종목·스크리너 드로어 공용 행: 코드 │ 이름 │ 현재가 │ 등락률.
 *  ScreenerResultRow 의 시각/키보드 계약을 그대로 가져오고 현재가 셀을 추가. */
export function QuoteRow({
  code, name, price, pct, active, ariaLabel, testId, onClick,
}: {
  code: string;
  name: string;
  price: number | null;
  pct: number | null;
  active: boolean;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
  return (
    <li
      data-testid={testId}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="cursor-pointer px-md py-sm flex items-center gap-2 border-b outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
      style={{
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <span className="font-mono text-xs text-fg-dim" style={{ minWidth: '3.2rem' }}>{code}</span>
      <span className="flex-1 truncate text-sm text-fg">{name}</span>
      <span className="font-mono tabular-nums text-sm text-fg-dim text-right">
        {price != null ? price.toLocaleString('ko-KR') : '—'}
      </span>
      <span className="font-mono tabular-nums text-sm text-right" style={{ minWidth: '4.5rem' }}>
        <ChangeCell pct={pct} />
      </span>
    </li>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/rightrail/QuoteRow.test.tsx`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/rightrail/QuoteRow.tsx frontend/src/rightrail/QuoteRow.test.tsx
git commit -m "feat(fe): shared QuoteRow (code|name|price|change%) for rail drawers"
```

---

### Task 6: WatchlistDrawer — QuoteRow + 라이브 등락률 채택

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

- [ ] **Step 1: Write the failing test (확장)**

기존 테스트 상단 import + mock 셋업에 `liveQuotes` 추가하고, 새 테스트 2개를 `describe` 안에 추가.

기존 [WatchlistDrawer.test.tsx](../../../frontend/src/watchlist/WatchlistDrawer.test.tsx) 의 import 블록에 추가:

```tsx
import * as liveQuotes from '../api/liveQuotes';
```

`beforeEach` 안(`vi.restoreAllMocks()` 다음)에 기본 quotes mock 추가 — **기존 테스트도 getQuotes 가 실제 fetch 하지 않도록**:

```tsx
    vi.spyOn(liveQuotes, 'getQuotes').mockResolvedValue({ phase: 'open', quotes: [] });
```

`describe` 안에 새 테스트:

```tsx
  it('renders live price and change % from useQuotes', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    vi.spyOn(liveQuotes, 'getQuotes').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2 },
        { code: '000660', price: 183500, change_pct: -0.8 },
      ],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('72,400')).toBeInTheDocument());
    expect(screen.getByText(/\+1\.20%/)).toBeInTheDocument();
    expect(screen.getByText(/-0\.80%/)).toBeInTheDocument();
  });

  it('shows — for a code missing from quotes (장전/무데이터)', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    vi.spyOn(liveQuotes, 'getQuotes').mockResolvedValue({ phase: 'open', quotes: [] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);  // price + pct
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: FAIL — `72,400` not found (WatchlistDrawer 아직 price 미렌더).

- [ ] **Step 3: Write implementation**

[WatchlistDrawer.tsx](../../../frontend/src/watchlist/WatchlistDrawer.tsx) 전체 교체:

```tsx
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useLocation } from 'react-router';
import { getWatchlist } from '../api/watchlist';
import { useQuotes } from '../api/liveQuotes';
import { useLivePageStore } from '../state/livePage';
import { QuoteRow } from '../rightrail/QuoteRow';

/**
 * Read-only Watchlist Panel (CONTEXT.md), app-wide via the Right Rail (ADR-0052).
 * 각 행에 KIS 라이브 현재가+등락률 오버레이 (ADR-0055). 클릭 시 activeCode 세팅
 * + /live 점프.
 */
export function WatchlistDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data, isLoading, error } = useQuery({
    queryKey: ['watchlist'],
    queryFn: getWatchlist,
    staleTime: 60_000,
  });

  const codes = useMemo(() => data?.entries.map((e) => e.code) ?? [], [data]);
  const { data: quotesData } = useQuotes(codes);
  const quoteByCode = useMemo(
    () => new Map((quotesData?.quotes ?? []).map((q) => [q.code, q])),
    [quotesData],
  );

  const onPick = (code: string) => {
    setActiveCode(code);
    if (pathname !== '/live') navigate('/live');
  };

  return (
    <div
      id="right-rail-watchlist-panel"
      data-testid="watchlist-panel"
      style={{
        width: 'var(--watchlist-panel-w)',
        height: '100%',
        background: 'var(--bg-card)',
        borderLeft: '1px solid var(--border)',
        overflow: 'auto',
      }}
    >
      <div
        style={{
          padding: 'var(--space-sm) var(--space-md)',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-dim)',
          fontFamily: 'monospace',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        관심종목
      </div>
      {isLoading && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dimmer)', fontSize: 'var(--text-sm)' }}>
          불러오는 중
        </div>
      )}
      {error && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--error)', fontSize: 'var(--text-sm)' }}>
          관심종목을 불러올 수 없습니다
        </div>
      )}
      {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dimmer)', fontSize: 'var(--text-sm)' }}>
          관심종목이 없습니다
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {data?.entries.map((entry) => {
          const q = quoteByCode.get(entry.code);
          return (
            <QuoteRow
              key={entry.code}
              code={entry.code}
              name={entry.name}
              price={q?.price ?? null}
              pct={q?.change_pct ?? null}
              active={entry.code === activeCode}
              ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
              testId={`watchlist-row-${entry.code}`}
              onClick={() => onPick(entry.code)}
            />
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/watchlist src/rightrail && npx tsc -b`
Expected: PASS — 기존 5 테스트(testid `watchlist-row-*`/이름/클릭/네비/하이라이트) + 신규 2 + QuoteRow 3 모두 통과.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat(fe): WatchlistDrawer adopts QuoteRow + live quotes overlay"
```

---

### Task 7: P1 수동 검증 (실서버 + /browse)

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 서버 기동** (CLAUDE.md 핫리로드 패턴, `.env` 에 `KIS_APP_KEY/SECRET` 필요)

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga &
cd frontend && npm run dev &
```

- [ ] **Step 2: 엔드포인트 직접 확인**

Run: `curl -s "http://127.0.0.1:8000/api/live/quotes?codes=005930,000660" | head`
Expected: `{"phase":"...","quotes":[{"code":"005930","price":...,"change_pct":...}, ...]}`. (크레덴셜 없으면 `"quotes":[]` — graceful)

- [ ] **Step 3: UI 확인 (/browse)**

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B js "document.querySelector('[aria-label=\"관심종목 패널 토글\"]').click()"
$B text   # 관심종목 행이 코드·이름·현재가·등락률(▲/▼)로 렌더되는지
$B console --errors
```
Expected: 행이 한 줄(코드│이름│현재가│등락률)로 렌더, hover 하이라이트, 선택 시 teal+좌측바, 콘솔 에러 없음. 장중이면 10초마다 값 갱신, 장전이면 등락률 `—`.

- [ ] **Step 4: ⚠️ 미검증 가정 — 장외 동작 확인**

장마감/주말에 `curl` 재실행 → `change_pct` 가 **직전 종가 기준 값**인지 vs **0/누락**인지 확인.
- 직전 종가 기준이면 → "장마감=종가 기준" 요구 충족, 추가 작업 없음.
- 0/누락이면 → **fallback**: `fetch_past_daily_candles`(일봉 2개: 최신/직전 close)로 정착 등락률 산출하는 분기를 `_get_quotes` 에 추가(별도 커밋). 이 경우만 Task 추가.

---

## Phase 2 — 스크리너 드로어 라이브 전환 (P2)

### Task 8: ScreenerDrawer — QuoteRow + 라이브 오버레이 (상위 30 cap)

**Files:**
- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
- Test: `frontend/src/screener/ScreenerDrawer.test.tsx`

설계: `ScreenerResultRow` 제거, `QuoteRow` 사용. `useQuotes` 는 **상위 30행 코드만** 받음(fan-out 상한 — scan limit 기본 1000이라 무제한 폴링 금지). 행의 `pct = liveQuote?.change_pct ?? r.change_pct`(상위=라이브, 그 외=스캔 코퍼스 EOD), `price = liveQuote?.price ?? null`. 스캔/필터 로직 불변.

- [ ] **Step 1: Write the failing test**

기존 [ScreenerDrawer.test.tsx](../../../frontend/src/screener/ScreenerDrawer.test.tsx) 패턴(스캔 mock + lastScan 세팅)에 맞춰, `liveQuotes.getQuotes` mock 추가 후:

```tsx
import * as liveQuotes from '../api/liveQuotes';
// ...기존 셋업...

it('overlays live price/% on result rows (top-30 cap)', async () => {
  vi.spyOn(liveQuotes, 'getQuotes').mockResolvedValue({
    phase: 'open',
    quotes: [{ code: '005930', price: 72400, change_pct: 3.4 }],
  });
  // (기존 테스트가 lastScan 에 005930 행을 넣는 방식 재사용 — change_pct 코퍼스값과 다르게)
  // ...render ScreenerDrawer with a scan result containing 005930...
  await waitFor(() => expect(screen.getByText('72,400')).toBeInTheDocument());
  expect(screen.getByText(/\+3\.40%/)).toBeInTheDocument();          // 라이브값
  expect(screen.getByTestId('screener-row-005930')).toBeInTheDocument(); // testid 유지(회귀)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx`
Expected: FAIL — `72,400` 미렌더.

- [ ] **Step 3: Write implementation**

[ScreenerDrawer.tsx](../../../frontend/src/screener/ScreenerDrawer.tsx) 에서:
1. import: `import { QuoteRow } from '../rightrail/QuoteRow';` `import { useQuotes } from '../api/liveQuotes';` (기존 `ScreenerResultRow`/`ChangeCell` import 제거).
2. 컴포넌트 본문에서 상위 30 코드 + 훅:

```tsx
  const liveCodes = useMemo(
    () => (lastScan?.rows ?? []).slice(0, 30).map((r) => r.code),
    [lastScan],
  );
  const { data: quotesData } = useQuotes(liveCodes);
  const quoteByCode = useMemo(
    () => new Map((quotesData?.quotes ?? []).map((q) => [q.code, q])),
    [quotesData],
  );
```

3. 결과 `<ul>` 의 row 매핑을 교체:

```tsx
                {lastScan.rows.map((r) => {
                  const q = quoteByCode.get(r.code);
                  return (
                    <QuoteRow
                      key={r.code}
                      code={r.code}
                      name={r.name}
                      price={q?.price ?? null}
                      pct={q?.change_pct ?? r.change_pct}
                      active={r.code === activeCode}
                      ariaLabel={`${r.name} ${r.code} 차트 열기`}
                      testId={`screener-row-${r.code}`}
                      onClick={() => openLive(r.code)}
                    />
                  );
                })}
```

4. 파일 하단 `ScreenerResultRow` 정의 삭제.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/screener && npx tsc -b`
Expected: PASS — 기존 ScreenerDrawer 테스트(testid `screener-row-*`, 클릭→activeCode, 조회/갱신) + 신규 오버레이 테스트 통과.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screener/ScreenerDrawer.tsx frontend/src/screener/ScreenerDrawer.test.tsx
git commit -m "feat(fe): ScreenerDrawer adopts QuoteRow + live overlay (top-30)"
```

---

## Phase 3 — 문서화

### Task 9: CONTEXT.md 갱신

**Files:** Modify `CONTEXT.md`

- [ ] **Step 1: Right Rail 항목 stale 수정** — [CONTEXT.md:97](../../../CONTEXT.md#L97) 의 "single Watchlist entry" + `panelOpen` boolean → **관심+스크리너 2항목**, `activePanel: 'watchlist'|'screener'`(`state/rightRail.ts`).
- [ ] **Step 2: Screener Panel 용어 신규** — `ScreenerDrawer`(읽기전용 결과 리스트, jump-to-chart). Watchlist Panel 과 형제.
- [ ] **Step 3: Live Quote 용어 신규** — KIS 직접(`intstock-multprice`)·세션게이트(장전 숨김)·**표시전용** 현재가+등락률; 스크리너 코퍼스와 무관(realm 분리). 표준어 **등락률**(=`change_pct`/`prdy_ctrt`) 사용.
- [ ] **Step 4: Watchlist Panel 항목 보강** — "행의 라이브 등락률/현재가는 KIS 직접(`/api/live/quotes`), 스크리너 코퍼스 아님" 관계 명시.
- [ ] **Step 5: Commit** `docs: CONTEXT.md — Right Rail/Screener Panel/Live Quote terms`

### Task 10: ADR-0055

**Files:** Create `docs/adr/0055-live-quote-overlay.md`

- [ ] **Step 1:** 결정 기록 — "관심종목·스크리너 드로어 표시 등락률·현재가는 **KIS 라이브**(`intstock-multprice`, 코퍼스 아님)·**표시전용**·**세션게이트**(장전 숨김). 스크리너 **스캔 필터는 EOD 코퍼스 유지**(시장 전체 라이브 스캔은 ~수천 콜이라 비현실적) → 장중 필터≠표시 **의도적 괴리**, 저녁 갱신 후 수렴." 대안(스크리너 코퍼스 재사용·필터 라이브화)과 거부 사유 포함. 다음 번호 = 0055([docs/adr/](../../../docs/adr/) 최신 0054 다음).
- [ ] **Step 2: Commit** `docs: ADR-0055 live quote overlay (KIS-direct, display-only, session-gated)`

---

## Self-Review

- **Spec coverage:** 데이터 소스(KIS 직접·Task1-3) / 세션단계 게이트(Task3 `_market_phase`) / 30종목 배치(Task1-2) / 공유 UI(Task5) / 관심종목(Task6) / 스크리너 표시-라이브(Task8) / fan-out 상한(Task8 top-30) / 문서·ADR(Task9-10) — 그릴링 결정 전부 매핑됨.
- **미검증 가정 1건(명시됨):** `intstock-multprice` 장외 `prdy_ctrt` 동작 → Task 7 Step 4에서 실측 + fallback 경로 기술.
- **타입 일관성:** 백엔드 `KisQuote{code,price,change_pct}` ↔ 와이어 `LiveQuote` ↔ 프론트 `LiveQuote{code,price,change_pct}` ↔ `QuoteRow` props(`price:number|null, pct:number|null`) 정합. testid 규약 유지(`watchlist-row-*`/`screener-row-*`)로 기존 테스트 회귀 없음.
- **DRY/YAGNI:** 서버 TTL 캐시는 단일 사용자 환경상 불필요로 판단해 제외(react-query dedup+10s 로 충분); 필요해지면 추가.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-01-live-quote-watchlist-screener.md`. 두 가지 실행 옵션:**

**1. Subagent-Driven (추천)** — 태스크마다 새 서브에이전트 디스패치, 태스크 사이 리뷰, 빠른 반복. (P1 Task 1→7 먼저, 검증 후 P2.)

**2. Inline Execution** — 이 세션에서 executing-plans 로 배치 실행 + 체크포인트 리뷰.

**어느 방식으로 진행할까요?**
