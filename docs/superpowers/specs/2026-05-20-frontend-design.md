# Frontend Design — Multi-Day Orderbook Replay Viewer

**Status:** Draft (awaiting user review)
**Date:** 2026-05-20
**Spec owner:** blessp@naver.com
**Related:** `docs/superpowers/specs/2026-05-19-hoga-ops-design.md` (backend), `CONTEXT.md`

---

## 1. Goal

Build a single-page browser frontend for the existing hoga-ops local API that lets the user:

1. Search/pick a Code, pick a date range (1..N **Stock-Dates**), and load.
2. See a TradingView-style multi-pane chart with **candles + volume** across multiple Stock-Dates stitched on a compressed time axis (Regular Session only by default).
3. See three time-series supporting indicators ALWAYS visible alongside the candles, sharing the same x-axis:
   - 호가비 (bid/ask total-quantity ratio) — line.
   - 매물대 (volume profile) — horizontal histogram overlay on the candle pane.
   - 호가잔량 intensity — heatmap (time × price, color = aggregated depth).
4. See three cursor-following indicators in a right sidebar that update as the user moves the chart crosshair:
   - 10호가 테이블 — orderbook snapshot at cursor `t`.
   - 거래원 입체 분석 — net (buy − sell) by broker at cursor `t`.
   - 체결 데이터 그래프 — recent trades around cursor `t` (small tape + intra-window strength bar).

## 2. Non-goals (v1)

- Real-time / live streaming. Replay only — data is already captured.
- Drawing tools, alerts, custom indicators, multi-symbol overlays.
- Authentication, multi-user, persistence of user state across reloads (other than URL params).
- Mobile layout. Desktop-only, dark theme only.
- Data Window display. v1 shows Regular Session only; extending to Data Window is a follow-up.

## 3. Stack

| Layer | Choice | Rationale |
|---|---|---|
| Build | Vite + React + TypeScript | CORS already whitelists `:5173`; matches existing intent. |
| Charts | `lightweight-charts` v5 (TradingView, Apache 2.0) | Native candle + multi-pane + crosshair sync; small (~200 KB). |
| Custom overlays | Plain `<canvas>` layered on chart panes | For volume profile and intensity heatmap (not built into lightweight-charts). |
| Server state | `@tanstack/react-query` | Built-in caching, dedupe, debouncing via `keepPreviousData`. |
| Client state | Zustand | Tiny; only holds {code, dateRange, cursorMs, hoveredPane}. |
| Styling | Tailwind CSS + CSS variables for theme | Dark theme only in v1. |
| Tests | Vitest + Testing Library; Playwright for one smoke E2E | Match local-tool ethos — light, fast. |

Frontend source lives in `frontend/` at repo root (new directory). It is **not** bundled or served by FastAPI; it's a standalone Vite dev server. Production deploy is out of scope.

## 4. New backend endpoints (3)

The three "always visible" indicators are time-series derived from already-stored Parquet tables. To keep the frontend simple and fast, the backend computes them with DuckDB and returns compact arrays. All three follow the existing per-Stock-Date pattern (one date per request); the frontend stitches dates client-side.

### 4.1 `GET /api/quote-ratio?code&date&bucket_ms=1000`

Returns the **bid/ask total-quantity ratio** sampled at fixed buckets (default 1 s).

```json
{
  "bucket_ms": 1000,
  "points": [
    {"t": 1747526400000, "bid_total": 12345, "ask_total": 9876}
  ]
}
```

- Backend returns raw directional totals only. The **client** computes the ratio and flips orientation for display (매수>매도 → bid/ask, else ask/bid; ratio always ≥1). Keeps the API symmetric and the directional-flip rule in one place.
- Source: `snapshots.parquet`, summed across all 10 levels, last snapshot per bucket.

### 4.2 `GET /api/depth-intensity?code&date&bucket_ms=1000&price_bins=200`

Returns a 2-D grid for the heatmap: time buckets × price bins → aggregated total depth visible at that (time, price).

```json
{
  "bucket_ms": 1000,
  "price_min": 67500, "price_max": 71200, "price_step": 50,
  "times": [1747526400000, 1747526401000, ...],
  "grid": [[0, 0, 12000, 8500, ...], ...]   // shape: len(times) × price_bins
}
```

- For each (time bucket, price bin), the value is the **max quantity** observed at that price during the bucket across all 20 orderbook levels (bid + ask treated together — color hue handled client-side by comparing to mid-price).
- Source: `snapshots.parquet`. DuckDB unpivots the 20 level columns then bins.
- Response size guard: `len(times) × price_bins` capped at 200 × 1000 = 200k cells. Server enforces.

### 4.3 `GET /api/volume-profile?code&date&price_bins=100`

Returns a price-binned histogram of executed volume for one Stock-Date.

```json
{
  "price_min": 67500, "price_max": 71200, "price_step": 50,
  "bins": [{"price_low": 67500, "qty": 12340, "buy_qty": 7000, "sell_qty": 5340}, ...]
}
```

- Uses continuous-trading rows only (`side != 0`) per the **Auction Cross** convention in `CONTEXT.md`.
- `buy_qty` = sum where `side = +1`, `sell_qty` = sum where `side = -1`.

### 4.4 Endpoints unchanged (cursor-following)

`/api/orderbook?t`, `/api/brokers?t`, `/api/trades?from&to` — already exist, used as-is.

### 4.5 Stock-date search

`/api/stock-dates` already returns the inventory with `name`. Frontend uses it to power name+code search (client-side filter on a small list — single-user local tool).

## 5. Frontend architecture

### 5.1 Module layout

```
frontend/
  src/
    main.tsx
    App.tsx
    api/
      client.ts            # fetch wrapper, base URL from env
      queries.ts           # react-query hooks per endpoint
      types.ts             # shared with backend (hand-mirrored)
    state/
      session.ts           # Zustand: code, dateRange, cursorMs
      timeAxis.ts          # multi-day compressed-axis math
    chart/
      ChartStage.tsx       # owns lightweight-charts instance + pane composition
      CandlePane.tsx
      VolumePane.tsx
      RatioPane.tsx
      IntensityPane.tsx    # custom canvas layer
      VolumeProfileOverlay.tsx  # custom canvas overlay on CandlePane
      FillStrengthPane.tsx
    sidebar/
      CursorSidebar.tsx
      OrderbookTable.tsx
      BrokerNetTable.tsx
      FillTape.tsx
    header/
      StockPicker.tsx
      DateRangePicker.tsx
      LoadButton.tsx
    util/
      format.ts            # KRW, qty, timestamp formatting
```

Each module has one clear purpose, communicates via props + the session store, and can be tested in isolation. No file should exceed ~250 lines; if a pane grows past that, split overlay logic into a sibling.

### 5.2 Compressed multi-day time axis

**Problem:** Concatenating multiple Stock-Dates raw leaves a 17.5-hour gap between consecutive Regular Sessions, wasting screen space.

**Solution:** A virtual "session time" axis. The frontend builds a mapping table:

```ts
type Segment = { date: string; sessionOpenMs: number; sessionCloseMs: number; virtualStart: number };
// virtualStart of segment N = sum of (sessionCloseMs - sessionOpenMs) of segments 0..N-1
```

- `realToVirtual(realMs, segment)` → virtual ms used on the chart.
- `virtualToReal(virtualMs)` → finds the segment by binary search, returns the real ms used for cursor-following API calls.
- Day boundaries are rendered as faint vertical guides with the date as a label.
- All four panes use the same virtual axis (lightweight-charts handles sync automatically when they share a chart instance).

This logic lives in `state/timeAxis.ts` and is the single source of truth for time conversion. Every API call out is real-ms; every chart coordinate is virtual-ms.

### 5.3 Data flow

```
Header (code + dateRange + Load)
    │
    ▼
session.setSelection() ──► react-query keys derive from (code, date) per Stock-Date
                                  │
              ┌───────────────────┼─────────────────────────────────────┐
              ▼                   ▼                                     ▼
   per-date prefetch       cursor.onChange (debounced 30ms)      always-on derived
   - candles               - orderbook(t)                         - matches against
   - quote-ratio           - brokers(t)                             cached series
   - depth-intensity       - trades(from=t-2s, to=t+0)             (no fetch)
   - volume-profile             │
              │                  ▼
              ▼            sidebar updates
   ChartStage renders
   (stitched virtual axis)
```

- **Prefetch fan-out:** when Load is clicked, the app fires one parallel batch per selected Stock-Date for the 4 series endpoints. Promise.allSettled — partial failures show a per-date error chip but don't block other dates.
- **Cursor:** `lightweight-charts` exposes `subscribeCrosshairMove`. The handler reads virtual ms, converts to (date, realMs), updates Zustand. React-query hooks keyed on `(code, date, t)` fetch automatically with 30 ms debounce (via `useDeferredValue` + `keepPreviousData`).
- **Pinning:** clicking the chart pins the cursor (stops following mouse) so the user can hover the sidebar without losing the snapshot. Second click unpins.

### 5.4 Error handling

| Failure mode | Behavior |
|---|---|
| API 404 (no data for date) | Show date chip in red, exclude from chart, continue with other dates. |
| API 5xx | Toast + retry button; cached dates still render. |
| Empty result (e.g. no brokers at `t`) | Sidebar shows "—" placeholder, no error. |
| Backend unreachable | Full-page banner; refresh manually. |

No silent fallbacks — every missing pane shows an explicit empty state with the reason.

## 6. URL state

Selection is serialized to the URL so reloading restores the view and links are shareable across the local machine:

```
/?code=005930&from=20260518&to=20260520&t=1747556789000
```

- `t` (cursor) updates on pin only — not on every mouse move, to avoid history churn.

## 7. Testing strategy

- **Unit (Vitest):** `timeAxis.ts` (virtual↔real conversion, day boundaries, edge cases at session open/close), formatters, query-key construction.
- **Component (Testing Library):** OrderbookTable, BrokerNetTable, FillTape with fixture JSON. Chart panes are NOT unit-tested (canvas) — covered by E2E screenshot only.
- **E2E (Playwright, one smoke):** load a known Stock-Date from a fixture data dir, assert chart renders, move crosshair, assert sidebar updates. Run against a backend started with a test fixture data dir.
- **Backend additions:** the three new endpoints get DuckDB-driven unit tests in `tests/api/` using existing parquet fixtures, mirroring the pattern in current `tests/`.

## 8. Open questions resolved

| Question | Decision | Why |
|---|---|---|
| Multi-day stitching: backend or frontend? | Frontend (per Stock-Date fetches + virtual axis) | Keeps backend per-date API symmetric with existing endpoints. |
| Series indicator computation: backend or frontend? | Backend (3 new endpoints) | DuckDB is faster, fewer bytes over the wire, indicators are reusable. |
| Chart library? | lightweight-charts | Matches "TradingView 스타일" target, free, mature. |
| Cursor API strategy? | react-query + 30 ms debounce, key per `(code, date, t)` | Caches naturally, no extra debouncer code. |
| Auction crosses in volume profile? | Excluded (`side != 0`) | Matches `CONTEXT.md` Auction Cross rule for aggressor-based metrics. |

## 9. Risks and mitigations

- **Intensity heatmap response size.** Capped server-side (200 × 1000 cells/day). At 3 days = 600k cells = ~5 MB JSON. Acceptable for localhost; revisit with binary encoding if it becomes a problem.
- **lightweight-charts custom pane limits.** v5 supports multiple panes well, but custom canvas overlays (matprofile, intensity) must be hand-wired to its time-scale. Spike this first in the plan.
- **Date range size.** No hard cap in v1, but rendering >10 days will get slow. Document, don't enforce.

## 10. Out of scope, captured for follow-ups

- Data Window toggle (show pre-market and closing auction).
- Export current view as PNG.
- Saved layouts / multi-tab.
- Broker history time-series (already aggregated server-side is a separate ticket).
