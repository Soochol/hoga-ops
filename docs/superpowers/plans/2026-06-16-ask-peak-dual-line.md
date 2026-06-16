# Today Ask Peak Dual Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 당일 매도 최대벽 지표에서 오늘은 체결가격 기준 최대벽과 미체결 포함 최대벽을 동시에 표시한다.

**Architecture:** 과거 `RangeBundle.ask_peaks` / parquet 산출은 건드리지 않는다. 오늘 live stream 경로에 작은 상태 객체를 두고, WS `TRADE` tick으로 오늘 연속거래 체결 가격 set을 누적하고, WS `OB` tick으로 두 ratchet을 갱신한다. `/api/live/series`가 이 today ask peak 상태를 같이 내려주고, 프론트는 오늘 항목만 2라인으로 그린다.

**Tech Stack:** Python, FastAPI, React, TypeScript, Zustand, lightweight-charts custom primitive, pytest, Vitest.

---

## Engineering Decision

Only **today** is in scope.

Do not change:

- `hoga/tables/snapshots.py::query_day_ask_peak`
- `hoga/api/bundle.py::build_range_bundle`
- `RangeBundle.ask_peaks`
- past-day `AskPeak` wire shape

Reason: the user only wants the 당일 behavior. Extending historical parquet/API shape would touch more than 15 files and solve a different problem.

## Data Flow

```text
KIS WS ticks
  |
  v
LiveStream.on_tick
  |
  +-- TRADE side=+1/-1 price ----> TodayAskPeakState.traded_prices
  |
  +-- OB continuous-book asks ----> all-price ratchet
                              |
                              +--> traded-price ratchet
                                   only if ask.price in traded_prices
  |
  v
LiveBuffer.publish
  |
  v
GET /api/live/series
  |
  +-- snapshots/trades/brokers
  +-- ask_peak_today
  |
  v
useDayAskPeaks / LiveAskPeakSegments
  |
  v
candle-pane overlay: 1 or 2 horizontal lines for today
```

## Semantics

- **체결가격 기준 최대벽**: 오늘 서버가 관측한 연속거래 체결 가격 set에 포함된 ask price level 중 가장 큰 qty.
- **미체결 포함 최대벽**: 오늘 서버가 관측한 eligible ask price level 전체 중 가장 큰 qty.
- `askPeakIntraMax`:
  - OFF: per bucket close representative 기준으로 오늘 2개 라인 선택.
  - ON: raw continuous OB tick 기준으로 오늘 2개 라인 선택.
- 새 표시 토글:
  - `askPeakShowAllPrices`, 기본 ON.
  - ON이면 체결가격 기준 라인과 미체결 포함 라인이 다를 때 2개 표시.
  - OFF이면 체결가격 기준 라인만 표시.
- 서버가 장 시작 이후 계속 떠 있지 않았다면 coverage는 partial이다. v1은 상태에 `coverage: 'full' | 'partial'`를 싣되, UI 경고 표시는 후속으로 둘 수 있다.
- 아직 체결가격 기준 peak가 없으면 미체결 포함 라인만 표시한다. 체결가격 기준 peak는 오늘 서버가 관측한 체결 가격이 이후 OB 후보에 다시 나타날 때부터 생긴다.

---

### Task 1: Live Today AskPeak State

**Files:**
- Create: `hoga/live/ask_peak_state.py`
- Test: `tests/unit/live/test_ask_peak_state.py`

- [ ] **Step 1: Add tests for pure state transitions**

Create tests covering:

- trade tick adds `price` to `traded_prices` only for `side in (1, -1)`.
- OB tick updates all-price peak from all eligible ask levels.
- OB tick updates traded-price peak only for ask levels whose price is already in `traded_prices`.
- If a later trade occurs at a price that already had a large OB wall earlier, the traded-price peak does not retroactively change unless that wall appears again later.
- Intra-max mode can use raw tick peaks, while close mode is updated by bucket close snapshots if the caller supplies close representative events.

- [ ] **Step 2: Implement a small pure accumulator**

Create `TodayAskPeakState` with:

```python
@dataclass
class Peak:
    price: int
    qty: int
    t_ms: int

@dataclass
class TodayAskPeakState:
    traded_prices: set[int] = field(default_factory=set)
    traded_peak: Peak | None = None
    all_peak: Peak | None = None
    coverage: Literal["full", "partial"] = "partial"

    def ingest_trade(self, *, price: int, side: int) -> None: ...
    def ingest_orderbook(self, *, t_ms: int, asks: Sequence[Mapping[str, int]]) -> None: ...
    def snapshot(self) -> dict | None: ...
```

Keep it independent of FastAPI, LiveBuffer, and JSONL writer.

- [ ] **Step 3: Run tests**

```bash
pytest tests/unit/live/test_ask_peak_state.py -q
```

Expected: PASS.

---

### Task 2: Wire State Into LiveStream

**Files:**
- Modify: `hoga/live/stream.py`
- Modify: `hoga/live/lifecycle.py` if a shared getter needs to be exposed
- Modify: `hoga/live/api.py`
- Test: existing live stream/API tests plus a focused API test

- [ ] **Step 1: Add state ownership**

Attach one `TodayAskPeakState` per active code in the live runtime layer. Preferred owner: `LiveStream`, because it already sees raw `TRADE` and `OB` ticks before downsampling.

- [ ] **Step 2: Ingest raw ticks**

In `LiveStream.on_tick`:

- On `SnapshotKind.TRADE`, loop `payload.trades` and call `ingest_trade`.
- On `SnapshotKind.OB`, call `ingest_orderbook` with `asks`.
- Preserve current `LiveBuffer.publish` and `TickDownsampler` behavior unchanged.

- [ ] **Step 3: Expose in `/api/live/series`**

Extend the response with:

```json
"ask_peak_today": {
  "date": "20260616",
  "coverage": "partial",
  "traded_price": 25100,
  "traded_qty": 3000,
  "traded_t_ms": 1780000000000,
  "all_price": 25200,
  "all_qty": 9000,
  "all_t_ms": 1780000005000
}
```

Return `null` until at least one eligible OB peak exists.

- [ ] **Step 4: Run backend tests**

```bash
pytest tests/unit/live -k "ask_peak or stream or lifecycle" -q
```

Expected: PASS.

---

### Task 3: Frontend Types and Store Preferences

**Files:**
- Modify: `frontend/src/api/liveSeries.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/state/chartPrefs.ts`
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/livePage.ts`
- Test: matching frontend state/type tests

- [ ] **Step 1: Add live response type**

Add:

```ts
export type LiveTodayAskPeak = {
  date: string;
  coverage: 'full' | 'partial';
  traded_price: number;
  traded_qty: number;
  traded_t_ms: number;
  all_price: number;
  all_qty: number;
  all_t_ms: number;
};
```

Extend `LiveSeriesResponse`:

```ts
ask_peak_today: LiveTodayAskPeak | null;
```

- [ ] **Step 2: Add display toggle**

Add `CHART_TOGGLES` entry:

```ts
{
  key: 'askPeakShowAllPrices',
  label: '미체결 가격 최대벽도 표시',
  description: '오늘 체결가격 기준 최대벽과 미체결 포함 최대벽이 다르면 두 라인을 함께 표시합니다.',
  default: true,
  category: 'indicator-modal',
}
```

- [ ] **Step 3: Add separate all-price style**

Add persisted style:

```ts
askPeakAllPriceColor: string;
askPeakAllPriceLineWidth: 1 | 2 | 3 | 4;
setAskPeakAllPriceStyle(...)
```

Recommended defaults:

```ts
color = '#F97316'
lineWidth = 1
```

Keep existing `askPeakColor` / `askPeakLineWidth` as the traded-price baseline style.

- [ ] **Step 4: Run frontend state/type tests**

```bash
npm --prefix frontend test -- liveSeries chartPrefs liveIndicatorsPersistence --run
```

Expected: PASS.

---

### Task 4: Render Today Dual Lines

**Files:**
- Modify: `frontend/src/live/useDayAskPeaks.ts`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx`
- Modify: `frontend/src/live/LiveAskPeakSegments.test.tsx`

- [ ] **Step 1: Thread `ask_peak_today`**

Pass `live.initial?.ask_peak_today` from `LivePage` into `useDayAskPeaks` or directly into `LiveAskPeakSegments`.

- [ ] **Step 2: Keep past behavior unchanged**

For past seed entries from `RangeBundle.ask_peaks`, keep current single-line behavior. This plan is today-only.

- [ ] **Step 3: Build today segments**

For today:

- Always emit traded-price segment if present.
- If `askPeakShowAllPrices` is true and all-price triple differs, emit all-price segment.
- Use separate styles.

- [ ] **Step 4: Handle no traded peak yet**

Before any trade price matches an ask wall:

- emit all-price line only if `askPeakShowAllPrices` is true, or
- emit nothing if the master ask peak indicator is intended to mean "traded baseline only".

Recommendation: emit all-price line only. It is better than a blank indicator during early market.

- [ ] **Step 5: Run projection tests**

```bash
npm --prefix frontend test -- LiveAskPeakSegments useDayAskPeaks LivePage --run
```

Expected: PASS.

---

### Task 5: Indicator Panel UI

**Files:**
- Modify: `frontend/src/live/indicators/AskPeakConfig.tsx`
- Modify: `frontend/src/live/indicators/IntraMaxConfigRows.test.tsx`

- [ ] **Step 1: Show two toggles**

Render:

```tsx
<IndicatorPrefRows toggleKeys={['askPeakIntraMax', 'askPeakShowAllPrices']} />
```

- [ ] **Step 2: Show two style pickers**

Labels:

- `체결가격 기준 선`
- `미체결 포함 선`

- [ ] **Step 3: Run UI tests**

```bash
npm --prefix frontend test -- AskPeakConfig IntraMaxConfigRows IndicatorPanel --run
```

Expected: PASS.

---

## Test Diagram

```text
Backend unit
  trade before OB      -> traded peak can update
  OB before trade      -> no retroactive traded peak
  OB all-price only    -> all peak updates, traded stays null
  side=0/2 trade       -> ignored for traded price set

Backend API
  /api/live/series     -> ask_peak_today null or populated

Frontend pure
  today traded only    -> 1 baseline line
  today all differs    -> 2 lines when toggle ON
  today all same       -> 1 line, no duplicate
  toggle OFF           -> traded line only

Regression
  past RangeBundle.ask_peaks behavior unchanged
```

---

## GSTACK REVIEW REPORT

| Run | Status | Findings |
|---|---|---|
| Step 0 scope challenge | DONE | Reduced scope from historical + today 2x2 model to today-only live state. This avoids touching parquet/range APIs. |
| Architecture review | DONE | Recommended server-owned live accumulator. Frontend buffer-only approach rejected because 15-minute retention corrupts semantics. |
| Code quality review | DONE | New state must be pure and independent from FastAPI/JSONL writer to keep the diff contained. |
| Tests review | DONE | Backend accumulator tests and frontend segment tests are required before implementation. |
| Performance review | DONE | State is O(number of traded prices + constant peaks) per code. No raw trade retention required. |

VERDICT: Use a backend live accumulator for today-only dual ask peak lines.

NO UNRESOLVED DECISIONS
