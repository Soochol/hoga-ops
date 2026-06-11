# 관심맵 당일 캔들 글리프 (스파크라인 대체) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관심맵(/heatmap) 행의 since-open 스파크라인(v0.7.15.0)을 당일 1봉 OHLC 캔들 글리프로 교체한다 — 데이터는 기존 10초 멀티시세 폴이 이미 주는 당일 OHLC, 누적·히스토리 0.

**Architecture:** 백엔드는 멀티시세 응답의 `inter2_oprc/hgpr/lwpr`를 `KisQuote`→`LiveQuote`로 **additive 노출**(pre_open은 None 게이트, closed는 캐시 무가드). 프론트는 신규 `CandleGlyph`(SVG 심지+몸통, 색=strict 종가>시가)를 행에 꽂고, 스파크라인 누적 스택(store/effect/hook 5파일)을 삭제한다.

**Tech Stack:** Python(dataclass, Pydantic, FastAPI) + pytest; React/TS + Vitest + @testing-library/react; SVG.

**Spec:** `docs/superpowers/specs/2026-06-11-heatmap-candle-glyph-design.md` (그릴링 8결정 반영본).

**테스트 명령:** 백엔드 `uv run pytest <path> -q` (repo 루트). 프론트 `npx vitest run <path>` + 타입 `npx tsc -p tsconfig.app.json --noEmit` (전부 `frontend/`에서). **fresh 워크트리면 먼저 `cd frontend && npm install` 1회.**

---

## File Structure

**백엔드 변경**
- `hoga/live/kis_client.py` — `KisQuote`에 OHLC(+`=None`), 신규 `_parse_ohlc_field`/`_parse_change`, `_parse_quote` 단일-return 리팩터.
- `hoga/live/api.py` — `LiveQuote`에 OHLC, `LiveQuoteFetcher` 두 매핑(closed 무가드 / open·pre 게이트).
- 테스트: `tests/unit/live/test_kis_multi_price.py`, `test_live_quote_fetcher.py`, `test_live_quotes_route.py`.

**프론트 신규**
- `frontend/src/heatmap/CandleGlyph.tsx` (+`CandleGlyph.test.tsx`).

**프론트 변경**
- `frontend/src/api/liveQuotes.ts` — `LiveQuote`에 **선택적** OHLC.
- `frontend/src/heatmap/HeatmapRow.tsx` — 스파크 셀→캔들 셀, `series`→`open/high/low`, 그리드 2.5rem.
- `frontend/src/heatmap/HeatmapFolder.tsx` — `seriesByCode` 제거, 행에 OHLC 전달.
- `frontend/src/heatmap/HeatmapBoard.tsx` — `seriesByCode` 제거, `columnWidth 12rem→16.5rem`.
- `frontend/src/pages/Heatmap.tsx` — 누적 effect·캡션·sparkline 배선 제거.
- 테스트: `HeatmapRow.test.tsx`, `HeatmapBoard.test.tsx`, `Heatmap.test.tsx`.

**삭제**: `frontend/src/heatmap/Sparkline.tsx`(+test), `frontend/src/heatmap/useSparklineSeries.ts`, `frontend/src/state/sparklineStore.ts`(+test).

**문서**: `DESIGN.md` 규칙 1건 교체.

---

## Task 1: 백엔드 — KisQuote OHLC + _parse_quote 단일-return

**Files:**
- Modify: `hoga/live/kis_client.py` (`KisQuote`@251, `_parse_quote`@977–1012)
- Test: `tests/unit/live/test_kis_multi_price.py`

- [ ] **Step 1: Write failing tests (append to test_kis_multi_price.py)**

```python
def test_parse_quote_includes_today_ohlc():
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "298000",
                      "prdy_ctrt": "1.50", "prdy_vrss_sign": "2",
                      "inter2_oprc": "290500", "inter2_hgpr": "306500", "inter2_lwpr": "287500"})
    assert q is not None
    assert (q.open, q.high, q.low) == (290500, 306500, 287500)
    assert q.price == 298000 and q.change_pct == 1.50  # 기존 로직 불변

def test_parse_quote_ohlc_kept_when_change_bails_out():
    # 빈 prdy_ctrt → change=None 이어도 OHLC는 채워진다(단일 return 검증; 4-return 함정 방지).
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "298000",
                      "prdy_ctrt": "", "inter2_oprc": "290500",
                      "inter2_hgpr": "306500", "inter2_lwpr": "287500"})
    assert q is not None
    assert q.change_pct is None and q.change_won is None
    assert (q.open, q.high, q.low) == (290500, 306500, 287500)

def test_parse_quote_ohlc_missing_or_zero_is_none():
    # 빈값/0/비숫자 → None (0 위조 금지 — 스케일·양봉판정 오염 방지).
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "298000",
                      "prdy_ctrt": "1.5", "prdy_vrss_sign": "2",
                      "inter2_oprc": "0", "inter2_hgpr": "", "inter2_lwpr": "N/A"})
    assert q is not None
    assert (q.open, q.high, q.low) == (None, None, None)
```

- [ ] **Step 2: Run — verify fail**

Run: `uv run pytest tests/unit/live/test_kis_multi_price.py -q`
Expected: FAIL (`TypeError: ... unexpected keyword 'open'` 또는 AttributeError — KisQuote에 open 없음).

- [ ] **Step 3: Add OHLC to KisQuote**

`hoga/live/kis_client.py` `KisQuote`(@251–256) 교체:
```python
@dataclass(frozen=True)
class KisQuote:
    """One row of intstock-multprice (현재가 + 등락률 + 전일대비 등락액 + 당일 OHLC) for a Code."""
    code: str
    price: int
    change_pct: float | None
    change_won: int | None = None
    # 당일 OHLC(inter2_oprc/hgpr/lwpr). 기본 None — positional 생성자/동등성 테스트 보존.
    open: int | None = None
    high: int | None = None
    low: int | None = None
```

- [ ] **Step 4: Add helpers + single-return _parse_quote**

`hoga/live/kis_client.py`, `_parse_quote`(@977) **바로 위에** 헬퍼 2개 추가:
```python
def _parse_ohlc_field(raw: object) -> int | None:
    """당일 OHLC 한 필드 → int|None. price 파서와 달리 0으로 위조하지 않는다
    (0 은 양봉/음봉 판정·[low,high] 스케일 분모를 오염). 빈값/파싱실패/<=0 → None."""
    if raw in (None, ""):
        return None
    try:
        v = int(float(raw))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _parse_change(row: dict) -> tuple[float | None, int | None]:
    """(change_pct, change_won). prdy_ctrt 빈값/파싱실패·미인식 부호코드면 (None, None)
    — 절대값 필드라 부호 없으면 양수 위조 금지(#11)."""
    raw_ctrt = row.get("prdy_ctrt")
    if raw_ctrt in (None, ""):
        return None, None
    try:
        mag = abs(float(raw_ctrt))
    except (TypeError, ValueError):
        return None, None
    sign = str(row.get("prdy_vrss_sign", ""))
    mult = {"1": 1.0, "2": 1.0, "4": -1.0, "5": -1.0, "3": 0.0}.get(sign)
    if mult is None:
        return None, None
    change_won = _parse_change_won(row.get("inter2_prdy_vrss") or row.get("prdy_vrss"), mult)
    return mult * mag, change_won
```

그리고 `_parse_quote` 본문(@991–1012, `code`/`price` 산출 이후 전부)을 **단일 return**으로 교체:
```python
    code = (row.get("inter_shrn_iscd") or "").strip()
    if not code:
        return None
    try:
        price = int(float(row.get("inter2_prpr") or "0"))
    except (TypeError, ValueError):
        price = 0
    # change 와 OHLC 는 독립 필드군 — 끝에서 한 번만 생성해 어느 쪽 결측에도 다른 쪽 누락 없게.
    change_pct, change_won = _parse_change(row)
    return KisQuote(
        code=code, price=price, change_pct=change_pct, change_won=change_won,
        open=_parse_ohlc_field(row.get("inter2_oprc")),
        high=_parse_ohlc_field(row.get("inter2_hgpr")),
        low=_parse_ohlc_field(row.get("inter2_lwpr")),
    )
```
(`_parse_change_won`@1015 은 그대로 둔다. docstring 의 price/change 설명 1줄에 "+ 당일 OHLC" 추가 권장.)

- [ ] **Step 5: Run — verify pass**

Run: `uv run pytest tests/unit/live/test_kis_multi_price.py -q`
Expected: PASS (기존 7 + 신규 3 = 10). 동등성 테스트(`q == KisQuote(...)`)도 양쪽 OHLC=None 으로 통과.

- [ ] **Step 6: Commit**
```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_multi_price.py
git commit -m "feat(live): KisQuote 당일 OHLC 파싱 + _parse_quote 단일 return"
```

---

## Task 2: 백엔드 — LiveQuote 와이어 OHLC + Fetcher 매핑(pre_open 숨김)

**Files:**
- Modify: `hoga/live/api.py` (`LiveQuote`@301, `LiveQuoteFetcher.fetch_and_gate`@347)
- Test: `tests/unit/live/test_live_quote_fetcher.py`, `tests/unit/live/test_live_quotes_route.py`

- [ ] **Step 1: Write failing tests**

`test_live_quote_fetcher.py` — 픽스처 `Q`(@8)에 OHLC 부여 + 단언 추가:
```python
Q = [KisQuote("005930", 72400, 1.2, 750, open=72000, high=73000, low=71500),
     KisQuote("000660", 183500, -0.8, -1500, open=184000, high=185000, low=182000)]
```
`test_open_returns_live_and_caches` 끝에 추가:
```python
    assert (out[0].open, out[0].high, out[0].low) == (72000, 73000, 71500)  # open 경로 OHLC 통과
```
`test_pre_open_hides_change_keeps_price` 끝에 추가:
```python
    assert out[0].open is None and out[0].high is None and out[0].low is None  # pre 게이트가 OHLC도 None
```

`test_live_quotes_route.py` — :51 exact-dict 에 OHLC 키 추가(QUOTES@41 은 OHLC 미전달 → None):
```python
    assert body["quotes"][0] == {"code": "005930", "price": 72400, "change_pct": 1.2,
                                 "change_won": 750, "open": None, "high": None, "low": None}
```
그리고 라우트가 OHLC를 **서빙**함을 증명하는 신규 테스트 추가(파일 끝):
```python
def test_quotes_open_serves_today_ohlc(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    quotes = [KisQuote("005930", 72400, 1.2, 750, open=72000, high=73000, low=71500)]
    c = TestClient(_app(quotes, tmp_path))
    r = c.get("/api/live/quotes", params={"codes": "005930"})
    q0 = r.json()["quotes"][0]
    assert (q0["open"], q0["high"], q0["low"]) == (72000, 73000, 71500)
```

- [ ] **Step 2: Run — verify fail**

Run: `uv run pytest tests/unit/live/test_live_quote_fetcher.py tests/unit/live/test_live_quotes_route.py -q`
Expected: FAIL (LiveQuote에 open 없음 → exact-dict 불일치 / AttributeError).

- [ ] **Step 3: Add OHLC to LiveQuote**

`hoga/live/api.py` `LiveQuote`(@301–305) 교체:
```python
class LiveQuote(BaseModel):
    code: str
    price: int
    change_pct: float | None
    change_won: int | None
    open: int | None = None
    high: int | None = None
    low: int | None = None
```

- [ ] **Step 4: Map OHLC in both Fetcher branches**

`LiveQuoteFetcher.fetch_and_gate` closed 분기 return(@364–369) 교체 — **가드 없음**(캐시가 당일/직전세션 종가):
```python
            return [
                LiveQuote(code=q.code, price=q.price,
                          change_pct=q.change_pct, change_won=q.change_won,
                          open=q.open, high=q.high, low=q.low)
                for c in code_list
                if (q := self._last_quotes.get(c)) is not None
            ]
```
open/pre_open 분기 return(@379–385) 교체 — **pre 게이트**(OHLC도 change처럼 숨김):
```python
        pre = phase == "pre_open"
        return [
            LiveQuote(code=q.code, price=q.price,
                      change_pct=(None if pre else q.change_pct),
                      change_won=(None if pre else q.change_won),
                      open=(None if pre else q.open),
                      high=(None if pre else q.high),
                      low=(None if pre else q.low))
            for q in quotes
        ]
```

- [ ] **Step 5: Run — verify pass**

Run: `uv run pytest tests/unit/live/test_live_quote_fetcher.py tests/unit/live/test_live_quotes_route.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add hoga/live/api.py tests/unit/live/test_live_quote_fetcher.py tests/unit/live/test_live_quotes_route.py
git commit -m "feat(live): /quotes 와이어에 당일 OHLC(closed 무가드·pre_open 숨김)"
```

---

## Task 3: 프론트 — CandleGlyph 컴포넌트

**Files:**
- Create: `frontend/src/heatmap/CandleGlyph.tsx`
- Test: `frontend/src/heatmap/CandleGlyph.test.tsx`

- [ ] **Step 1: Write failing test**

`frontend/src/heatmap/CandleGlyph.test.tsx`:
```tsx
import { render } from '@testing-library/react';
import { it, expect } from 'vitest';
import { CandleGlyph } from './CandleGlyph';

const bodyFill = (c: HTMLElement) =>
  c.querySelector('.candle-glyph rect:last-child')?.getAttribute('fill');

it('양봉(close>open) → --price-up', () => {
  const { container } = render(<CandleGlyph open={100} high={120} low={95} close={115} />);
  expect(bodyFill(container)).toBe('var(--price-up)');
});
it('음봉(close<open) → --price-down', () => {
  const { container } = render(<CandleGlyph open={115} high={120} low={95} close={100} />);
  expect(bodyFill(container)).toBe('var(--price-down)');
});
it('도지(close==open) → --fg-dim (>= 아님)', () => {
  const { container } = render(<CandleGlyph open={100} high={110} low={90} close={100} />);
  expect(bodyFill(container)).toBe('var(--fg-dim)');
});
it('결측(null) → 렌더 없음', () => {
  const { container } = render(<CandleGlyph open={null} high={120} low={95} close={115} />);
  expect(container.querySelector('.candle-glyph')).toBeNull();
});
it('모순(high<low) → 렌더 없음', () => {
  const { container } = render(<CandleGlyph open={100} high={90} low={95} close={100} />);
  expect(container.querySelector('.candle-glyph')).toBeNull();
});
it('limit-lock(high==low) → 심지·몸통 최소 1px 렌더', () => {
  const { container } = render(<CandleGlyph open={100} high={100} low={100} close={100} />);
  const rects = container.querySelectorAll('.candle-glyph rect');
  expect(rects.length).toBe(2);
  rects.forEach((r) => expect(Number(r.getAttribute('height'))).toBeGreaterThanOrEqual(1));
});
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run src/heatmap/CandleGlyph.test.tsx`
Expected: FAIL (`Cannot find module './CandleGlyph'`).

- [ ] **Step 3: Implement CandleGlyph**

`frontend/src/heatmap/CandleGlyph.tsx`:
```tsx
import { memo } from 'react';

export interface CandleGlyphProps {
  /** 당일 OHLC + 현재가(close). 하나라도 결측/모순이면 미렌더(빈 셀). */
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  width?: number;
  height?: number;
}

const W = 10, H = 16, PAD = 1, BODY_W = 8, CX = 5;

/** 두 y좌표 사이 최소 1px·중점정렬 세그먼트(심지·몸통 공용 — limit-lock 비대칭 방지). */
function place(a: number, b: number): { y: number; height: number } {
  const raw = Math.abs(a - b);
  const height = Math.max(raw, 1);
  return { y: Math.min(a, b) - (height - raw) / 2, height };
}

/** 당일 1봉 캔들 글리프(고-저 심지 + 시-종 몸통). 색 = strict 종가 vs 시가:
 *  종가>시가 양봉 --price-up(적) · 종가<시가 음봉 --price-down(청) · 도지 --fg-dim.
 *  결측/모순(null·high<=0·high<low) → null. DESIGN.md: 가격방향 카테고리의 캔들 확장. */
export const CandleGlyph = memo(function CandleGlyph({
  open, high, low, close, width = W, height = H,
}: CandleGlyphProps) {
  if (open == null || high == null || low == null || close == null
      || high <= 0 || high < low) return null;
  const stroke = close > open ? 'var(--price-up)'
    : close < open ? 'var(--price-down)' : 'var(--fg-dim)';
  const span = (high - low) || 1;          // 도지/limit-lock: 0 나눗셈 방지
  const y = (v: number) => PAD + (1 - (v - low) / span) * (height - PAD * 2);
  const c = Math.min(Math.max(close, low), high);  // [low,high]로 clamp(off-canvas 방어)
  const wick = place(y(low), y(high));
  const body = place(y(open), y(c));
  return (
    <svg className="candle-glyph" viewBox={`0 0 ${width} ${height}`} width={width} height={height}
      preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">
      <rect x={CX - 0.5} y={wick.y} width={1} height={wick.height} fill={stroke} />
      <rect x={CX - BODY_W / 2} y={body.y} width={BODY_W} height={body.height} fill={stroke} />
    </svg>
  );
});
```

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run src/heatmap/CandleGlyph.test.tsx`
Expected: PASS (6).

- [ ] **Step 5: Commit**
```bash
git add frontend/src/heatmap/CandleGlyph.tsx frontend/src/heatmap/CandleGlyph.test.tsx
git commit -m "feat(heatmap): CandleGlyph — 당일 OHLC 1봉 캔들(strict 종가>시가 색)"
```

---

## Task 4: 프론트 — liveQuotes OHLC(optional) + HeatmapRow 캔들 셀

**Files:**
- Modify: `frontend/src/api/liveQuotes.ts` (`LiveQuote` 인터페이스)
- Modify: `frontend/src/heatmap/HeatmapRow.tsx`
- Test: `frontend/src/heatmap/HeatmapRow.test.tsx`

- [ ] **Step 1: Update HeatmapRow.test.tsx (replace sparkline tests)**

`HeatmapRow.test.tsx`에서 기존 두 테스트("series 있으면 스파크라인…", "series 없으면…")를 교체:
```tsx
it('OHLC 있으면 캔들 셀 렌더(양봉=적)', () => {
  row({ open: 100, high: 120, low: 95 });  // price=70000(>open) → 양봉
  const fill = document.querySelector('.candle-glyph rect:last-child')?.getAttribute('fill');
  expect(fill).toBe('var(--price-up)');
});

it('OHLC 결측이면 캔들 없음(칸 유지, 결측 — 개수 불변)', () => {
  row({ price: null, pct: null });  // open/high/low 미전달 → null
  expect(document.querySelector('.candle-glyph')).toBeNull();
  expect(screen.getAllByText('—').length).toBe(2);  // 빈 캔들 셀이 '—'를 만들지 않는다
});
```
(파일 상단 `row()` 헬퍼는 `{...props}` 스프레드라 open/high/low 전달 가능 — 기존 그대로.)

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run src/heatmap/HeatmapRow.test.tsx`
Expected: FAIL (`.candle-glyph` 없음 / `open` prop 타입 에러).

- [ ] **Step 3: liveQuotes.ts — 선택적 OHLC**

`frontend/src/api/liveQuotes.ts` `LiveQuote` 인터페이스(@6)에 추가:
```ts
export interface LiveQuote {
  code: string;
  price: number;
  change_pct: number | null;
  /** 전일대비 등락액(원). 장전(pre_open)·무데이터 시 null. */
  change_won: number | null;
  /** 당일 OHLC(멀티시세 inter2_oprc/hgpr/lwpr). **optional** — 필수면 screener·live-price-line·
   *  SectorTempStrip.test 등 범위 밖 6파일이 tsc 에러. 와이어는 항상 키를 보내지만(FastAPI)
   *  타입은 느슨히, 호출부에서 `?? null` 강제. */
  open?: number | null;
  high?: number | null;
  low?: number | null;
}
```

- [ ] **Step 4: HeatmapRow.tsx — 스파크 셀 → 캔들 셀**

(a) import 교체: `import { Sparkline } from './Sparkline';` → `import { CandleGlyph } from './CandleGlyph';`
(b) props: `series?: number[];`(주석 포함) 제거 → 추가:
```tsx
  /** 당일 OHLC(없으면 빈 캔들 셀). close 는 기존 price. 부모가 quote 에서 주입. */
  open?: number | null;
  high?: number | null;
  low?: number | null;
```
(c) 구조분해: `name, price, pct, series, onClick, ...` → `name, price, pct, open, high, low, onClick, ...`
(d) 그리드: `grid-cols-[minmax(4rem,1fr)_3.5rem_3.2rem_4.25rem]` → `grid-cols-[minmax(4rem,1fr)_2.5rem_3.2rem_4.25rem]`
(e) 셀 교체:
```tsx
      {/* 당일 캔들 셀 — CandleGlyph 가 null 이어도 이 span 이 칼럼을 점유해 정렬 유지. */}
      <span className="flex items-center justify-center overflow-hidden"><CandleGlyph open={open} high={high} low={low} close={price} /></span>
```

- [ ] **Step 5: Run — verify pass**

Run: `npx vitest run src/heatmap/HeatmapRow.test.tsx`
Expected: PASS (기존 클릭/드래그 테스트 + 신규 캔들 2).

- [ ] **Step 6: Commit**
```bash
git add frontend/src/api/liveQuotes.ts frontend/src/heatmap/HeatmapRow.tsx frontend/src/heatmap/HeatmapRow.test.tsx
git commit -m "feat(heatmap): HeatmapRow 당일 캔들 셀 + LiveQuote optional OHLC"
```

---

## Task 5: 프론트 — HeatmapFolder/Board OHLC 배선 + columnWidth

**Files:**
- Modify: `frontend/src/heatmap/HeatmapFolder.tsx`, `frontend/src/heatmap/HeatmapBoard.tsx`
- Test: `frontend/src/heatmap/HeatmapBoard.test.tsx`

- [ ] **Step 1: Update HeatmapBoard.test.tsx**

기존 "seriesByCode를 전달하면 스파크라인…" 테스트를 캔들로 교체:
```tsx
it('quote 의 OHLC 로 행에 캔들이 그려진다', () => {
  const qbc = new Map<string, LiveQuote>([
    ['005930', { code: '005930', price: 70000, change_pct: 1, change_won: 700,
                 open: 69000, high: 71000, low: 68500 }],
  ]);
  render(<HeatmapBoard groups={groups} quoteByCode={qbc}
    sortMode="change" onPick={() => {}} />);
  expect(document.querySelector('.candle-glyph')).toBeTruthy();
});
```
(기존 빈폴더/미분류 제외 테스트, 앵커 id 테스트는 그대로 — `seriesByCode` prop 참조만 제거.)

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run src/heatmap/HeatmapBoard.test.tsx`
Expected: FAIL (`seriesByCode` 미존재 / `.candle-glyph` 없음).

- [ ] **Step 3: HeatmapFolder.tsx**

(a) `HeatmapFolderProps`에서 `seriesByCode?: Map<string, number[]>;`(주석 포함) 제거.
(b) 구조분해에서 `seriesByCode` 제거: `{ folder, entries, quoteByCode, sortMode, onPick, onReorder, onRowMenu }`.
(c) `rows` 매핑 두 분기에서 `series={seriesByCode?.get(e.code)}` 제거 → `open/high/low` 추가:
```tsx
    return draggable ? (
      <SortableHeatmapRow key={e.code} code={e.code} name={e.name}
        price={q?.price ?? null} pct={q?.change_pct ?? null}
        open={q?.open ?? null} high={q?.high ?? null} low={q?.low ?? null}
        onPick={() => onPick(e.code)} onContextMenu={ctxFor?.(e.code, e.name)} />
    ) : (
      <HeatmapRow key={e.code} name={e.name} price={q?.price ?? null} pct={q?.change_pct ?? null}
        open={q?.open ?? null} high={q?.high ?? null} low={q?.low ?? null}
        onClick={() => onPick(e.code)} ariaLabel={`${e.name} ${e.code} 차트 열기`}
        testId={`heatmap-row-${e.code}`} onContextMenu={ctxFor?.(e.code, e.name)} />
    );
```
(d) `SortableHeatmapRow` props 타입에서 `series?: number[];` 제거 → `open?: number|null; high?: number|null; low?: number|null;` 추가; 내부 `<HeatmapRow>`에 `series={props.series}` 제거 → `open={props.open} high={props.high} low={props.low}` 추가.

- [ ] **Step 4: HeatmapBoard.tsx**

(a) `HeatmapBoardProps`에서 `seriesByCode?: Map<string, number[]>;`(주석 포함) 제거.
(b) 구조분해에서 `seriesByCode` 제거.
(c) `<HeatmapFolder>` 호출에서 `seriesByCode={seriesByCode}` 제거.
(d) `columnWidth: '12rem'` → `'16.5rem'`. 주석(@21–26) 교체:
```tsx
/** 신문형 멀티칼럼 보드. 빈 그룹만 제외(미분류 포함 — ADR-0068 G3). columnWidth 는 행
 *  그리드의 측정 min-content(합성 하니스 실측 ≈314px, 글리프 2.5rem+현재가+칩, :root 20px
 *  ≈15.7rem) 위로 올린 16.5rem floor. multicol 은 column-width 를 '최소'로 보고 칼럼수를
 *  올림한 뒤 칼럼을 board 폭까지 늘리므로, 플로어가 행 min-content 미만이면 특정 board 밴드
 *  (칼럼수 올림→stretch폭<행min)에서 카드(overflow-hidden·break-inside-avoid)가 등락칩을
 *  잘랐다 — v0.7.15.0 글리프 칼럼(3.5rem)이 12rem 에 미반영돼 생기던 잠재 버그. 플로어 ≥ 행
 *  min-content 로 그 클리핑 밴드를 제거. (board 자체가 ~16rem 미만이면 — 관심목록 패널 열림
 *  + 좁은 뷰포트 → 단일칼럼 — 어떤 플로어로도 클립 불가피; 레이아웃 붕괴는 아님.) */
```

- [ ] **Step 5: Run — verify pass**

Run: `npx vitest run src/heatmap/HeatmapBoard.test.tsx src/heatmap/HeatmapFolder.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add frontend/src/heatmap/HeatmapFolder.tsx frontend/src/heatmap/HeatmapBoard.tsx frontend/src/heatmap/HeatmapBoard.test.tsx
git commit -m "feat(heatmap): Folder/Board OHLC 배선 + columnWidth 16.5rem(클리핑 밴드 수정)"
```

---

## Task 6: 프론트 — Heatmap.tsx 스파크라인 배선 제거

**Files:**
- Modify: `frontend/src/pages/Heatmap.tsx`
- Test: `frontend/src/pages/Heatmap.test.tsx`

- [ ] **Step 1: Update Heatmap.test.tsx**

(a) `import { useSparklineStore } from '../state/sparklineStore';` 삭제.
(b) `beforeEach` 의 `useSparklineStore.getState().reset();` 줄 삭제. (open-mock·scrollIntoView 스텁은 유지.)
(c) 누적/캡션 테스트 3개 삭제: "open 폴이 since-open store에 누적된다", "closed phase면 누적 안 함", "정직 캡션 — 장중 추세". (CandleGlyph는 mock quote에 OHLC가 없으면 안 그려지므로 페이지 테스트에선 캔들 단언 불필요 — 컴포넌트 테스트가 커버.)
(d) `useLiveQuoteOverlay` mock(파일 상단 + beforeEach)의 quote 객체에 OHLC를 넣지 않아도 됨(없으면 빈 캔들 — 기존 페이지 단언 불변).

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run src/pages/Heatmap.test.tsx`
Expected: FAIL (삭제한 store import/누적 테스트가 아직 소스에 의존 → 또는 소스 미수정 상태라 캡션 등 잔존).

- [ ] **Step 3: Heatmap.tsx 정리**

삭제:
- import: `import { SectorTempStrip }`는 **유지**. `import { useSparklineStore } from '../state/sparklineStore';`, `import { useSparklineSeries } from '../heatmap/useSparklineSeries';` 삭제.
- 본문: `const appendBatch = useSparklineStore(...)`, `const seriesByCode = useSparklineSeries();`, `const lastAppendedRef = useRef(0);`, 누적 `useEffect(...)` 블록 전체 삭제.
- 렌더: 캡션 `<div ...>스파크라인 = 장중 추세</div>` 삭제. `<HeatmapBoard ... seriesByCode={seriesByCode} ...>` 에서 `seriesByCode={seriesByCode}` 제거.
- `import { useEffect, useMemo, useRef, useState } from 'react';` → 누적 effect 제거 후 `useEffect`/`useRef` 미사용이면 `import { useMemo, useState } from 'react';`로 정리(`scrollToFolder`·SectorTempStrip 은 effect/ref 불요).

(SectorTempStrip·scrollToFolder·헤더·정렬토글·배너·RowMenu 전부 유지.)

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run src/pages/Heatmap.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.test.tsx
git commit -m "refactor(heatmap): 페이지에서 스파크라인 누적 배선 제거(캔들로 대체)"
```

---

## Task 7: 스파크라인 파일 삭제 + 잔존참조 0 확인

**Files:**
- Delete: `frontend/src/heatmap/Sparkline.tsx`, `frontend/src/heatmap/Sparkline.test.tsx`, `frontend/src/heatmap/useSparklineSeries.ts`, `frontend/src/state/sparklineStore.ts`, `frontend/src/state/sparklineStore.test.ts`

- [ ] **Step 1: Delete files**
```bash
cd frontend
git rm src/heatmap/Sparkline.tsx src/heatmap/Sparkline.test.tsx \
       src/heatmap/useSparklineSeries.ts \
       src/state/sparklineStore.ts src/state/sparklineStore.test.ts
```

- [ ] **Step 2: Verify no dangling refs**

Run: `grep -rnE "Sparkline|sparklineStore|useSparklineSeries|seriesByCode" src --include="*.ts" --include="*.tsx" | grep -v "BrokerTrajectoryTable"`
Expected: **출력 없음**(빈 결과). (`sidebar/BrokerTrajectoryTable.tsx` 의 동명 로컬 Sparkline 은 무관 — grep 에서 제외.)

- [ ] **Step 3: Typecheck + heatmap tests green**

Run: `npx tsc -p tsconfig.app.json --noEmit && npx vitest run src/heatmap src/pages/Heatmap.test.tsx`
Expected: tsc 0에러, 테스트 전부 PASS.

- [ ] **Step 4: Commit**
```bash
git commit -m "chore(heatmap): since-open 스파크라인 스택 삭제(5파일)"
```

---

## Task 8: DESIGN.md 규칙 + 전체 검증

**Files:**
- Modify: `DESIGN.md`

- [ ] **Step 1: DESIGN.md 규칙 교체**

기존 "Price-direction sparkline (관심맵 행 전용)" 항목을 교체:
```markdown
- **Price-direction candle glyph (관심맵 행 전용):** `frontend/src/heatmap/CandleGlyph.tsx` 가
  당일 시·고·저·종을 1봉으로 그린다(고-저 심지 + 시-종 몸통). 색 = **종가 vs 시가**(strict):
  종가>시가 양봉 `--price-up`(적)·종가<시가 음봉 `--price-down`(청)·도지 `--fg-dim`. 이는
  *당일 시가 대비* 흐름으로 *전일대비* 등락칩(`change_pct`)과 다른 기준(다른 시간창). 가격
  방향 카테고리 준수(새 색 없음) — `heat.ts` 배경 확장의 캔들 버전.
```
(v0.7.15.0 의 "sparkline" 항목이 남아있지 않으면 §Color 의 heat-ramp 항목 아래에 신규 추가.)

- [ ] **Step 2: Commit**
```bash
git add DESIGN.md
git commit -m "docs(design): 방향성 캔들 글리프 규칙(스파크라인 규칙 대체)"
```

- [ ] **Step 3: 전체 검증**

Run(백엔드): `uv run pytest tests/unit/live/ -q`
Expected: PASS.

Run(프론트): `cd frontend && npx vitest run && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: vitest 전부 PASS, tsc 0에러, build 성공(exit 0).

- [ ] **Step 4: 수동 검증 — 캔들 렌더 + 클리핑 실측 (`/browse`, 장중 권장)**

워크트리 vite 는 backend CORS(:5173 한정)로 실시세가 안 올 수 있다(메모리). 가능한 경로:
- `:5173`(메인 dev 서버, CORS 허용)에서 머지 후 확인, **또는** 워크트리 vite + 프록시.
- 확인 항목: (1) 각 행에 당일 캔들(양봉 적·음봉 청), 새로고침·페이지 이동 후 즉시 동일(상태 없음). (2) **칩 클리핑 0**: 실시세(멀티자리 칩) 채운 채 1366·1820px(관심목록 패널 닫힘/열림)에서 등락칩이 카드 우측에 안 잘림 + 칼럼수 1회 실측. '—'/한자리 칩은 위양성 → 실시세 필수; 데몬 resize 안 되면 합성 하니스로.
- pre_open/closed: pre_open 빈 캔들, closed 당일 최종 캔들 고정.

- [ ] **Step 5: (검증 중 수정 있으면) 파일별 커밋**

---

## Self-Review (작성자 체크 — 완료)

**Spec coverage:** §1 백엔드 OHLC→Task1·2, §2 CandleGlyph→Task3, liveQuotes optional→Task4, HeatmapRow→Task4, Folder/Board+columnWidth→Task5, Heatmap.tsx→Task6, 삭제 5파일→Task7, DESIGN.md→Task8, Testing(백+프론트)→각 Task Step1·Task8 Step3, Manual 클리핑 실측→Task8 Step4. 그릴링 8결정 전부 매핑(pre_open 숨김 T2, strict `>` T3, _parse_ohlc_field/단일return T1, optional 필드 T4, columnWidth T5, place()/clamp T3, closed 무가드 T2, 테스트/삭제 T1·2·7). 갭 없음.

**Placeholder scan:** TBD/TODO 없음 — 전 코드·명령·기대출력 완전 기술.

**Type consistency:** `KisQuote(... open/high/low: int|None = None)`(T1) ↔ positional 픽스처(T2). `LiveQuote`(BaseModel, T2)·프론트 `LiveQuote`(optional, T4) 분리 일관. `CandleGlyphProps{open?,high?,low?,close?}`(T3) ↔ HeatmapRow open/high/low + close=price(T4) ↔ Folder q?.open ?? null(T5). `.candle-glyph`(T3) ↔ 셀렉터(T3·4·5). `seriesByCode`/`series`/`Sparkline`/`sparklineStore` 전 제거(T4·5·6·7), grep 0 확인(T7).
