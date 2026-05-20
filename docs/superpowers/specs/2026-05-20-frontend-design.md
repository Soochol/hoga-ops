# Frontend Design — Multi-Day Orderbook Replay Viewer

**Status:** Draft (awaiting user review)
**Date:** 2026-05-20
**Spec owner:** blessp@naver.com
**Related:**
- `DESIGN.md` (repo root) — design system tokens (colors, fonts, spacing, motion). **Source of truth for any visual question this spec does not answer.**
- `docs/superpowers/designs/2026-05-20-replay-viewer.html` — interactive HTML mockup of Replay Viewer with realistic dummy data. **Source of truth for layout pixels.**
- `docs/superpowers/specs/2026-05-19-hoga-ops-design.md` — backend spec.
- `CONTEXT.md` — domain language.

**Authority order if these disagree:** This spec (WHAT and WHY) → `DESIGN.md` (visual tokens) → HTML mockup (pixel reference). If the mockup contradicts `DESIGN.md`, the mockup is stale and must be regenerated.

---

## 1. Goal

Build a browser frontend for the existing hoga-ops local API that lets the user:

1. Navigate between pages via a **persistent left navigation** (Replay Viewer, Inventory, Capture, Search, Notes, Settings). v1 ships only Replay Viewer with usable content; the other items appear in nav but are stub pages.
2. On the Replay Viewer page, open **multiple analysis sessions as browser-style tabs** along the top — each tab independently holds its own (code, date range, cursor, cached data). Switching tabs is instant if data is cached.
3. Within an active tab: search/pick a Code, pick a date range (1..N **Stock-Dates**), and load.
4. See a TradingView-style multi-pane chart with **candles + volume** across multiple Stock-Dates stitched on a compressed time axis (Regular Session only by default).
5. See three time-series supporting indicators ALWAYS visible alongside the candles, sharing the same x-axis:
   - 호가비 (bid/ask total-quantity ratio) — line.
   - 매물대 (volume profile) — horizontal histogram overlay on the candle pane.
   - 호가잔량 intensity — heatmap (time × price, color = aggregated depth).
6. See three cursor-following indicators in a right sidebar that update as the user moves the chart crosshair:
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
| Server state | `@tanstack/react-query` | Built-in caching, dedupe, debouncing via `keepPreviousData`. Cache keys are tab-scoped. |
| Client state | Zustand | Tiny; holds `tabs[]`, `activeTabId`, plus per-tab `{code, dateRange, cursorMs}`. |
| Styling | Tailwind CSS + CSS variables driven by design tokens (§5.1) | Dark theme only in v1. |
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

## 5. Layout & Design System

### 5.1 App shell

```
┌──nav──┬──────main──────────────────────────────────────┐
│ Logo  │  Tab strip (Replay Viewer page only)           │
│       ├────────────────────────────────────────────────┤
│ Items │  Toolbar (per-tab: stock + date range + Load)  │
│       ├────────────────────────────────────────────────┤
│       │  Price strip (per-tab: current price + OHLC)   │
│       ├────────────────────────────────────────────────┤
│       │  Workarea: 4 chart panes (left) + sidebar (right)│
└───────┴────────────────────────────────────────────────┘
```

**Left nav (210 px, persistent across pages):**
- Brand block at top (`hoga-ops` + `orderbook replay`).
- Three sections separated by small-caps labels:
  - **Workspace** — Replay Viewer (v1 active, badge = open tab count), Inventory (badge = captured Stock-Date count), Capture.
  - **Tools** — Search, Notes.
  - **System** (bottom) — Settings.
- Footer shows API status dot and version.
- v1: only Replay Viewer renders real content. Other nav items render a placeholder page with the section title and a "coming soon" stub.

**Tab strip (Replay Viewer page only, 40 px tall):**
- Each tab is an **independent analysis session** holding its own `{code, dateRange, cursorMs, cachedData}`.
- Tab content: status dot (loaded / loading / empty), code (mono, teal), name, date-range hint.
- Active tab has a 2 px teal top accent and background matching the toolbar; inactive tabs are dimmer.
- `[+ 새 분석]` button creates a new empty tab. Soft cap of 8 simultaneous tabs (shown as `N / 8 open`) to bound memory; the 9th opens a confirmation modal warning that the oldest tab will be evicted.
- Tabs are reorderable (drag), closeable (X on hover), keyboard-navigable (Ctrl+Tab / Ctrl+Shift+Tab).
- Closing the last tab leaves a single empty tab (never zero-tab state).

**Toolbar (60 px, per-tab):**
- 종목 combobox: searchable dropdown sourced from `/api/stock-dates` inventory, shows code + name + captured-dates count.
- 기간: from/to date fields. Disabled dates are those not captured for the selected code.
- 빠른 범위 presets: 1D / 3D / 1W / 2W / 사용자. Selecting a preset adjusts `to` to the latest available date and `from` to (`to` − preset days), clamped to the captured range.
- `데이터 불러오기` primary button: triggers prefetch for the current tab.

**Price strip (52 px, per-tab):**
- Symbol block (code + name), current price (mono 22 px), delta chip (pos = green tint, neg = rose tint).
- OHLC + Vol values at cursor `t` (compact mono).
- Right side: cursor indicator (pulsing dot + virtual timestamp).

**Workarea:**
- Left 1fr / right 320 px sidebar.
- Left: 4 panes stacked vertically with `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` — Price/Volume/Profile, Bid/Ask Ratio, Depth Intensity, Fill Strength.
- Right: 3 cards stacked — Orderbook 10 Levels, Broker Net Flow, Recent Fills.

### 5.2 Design tokens

**Source of truth:** `DESIGN.md` at the repo root (created via `/design-consultation`, 2026-05-20). It defines every color, font, spacing value, border radius, and motion easing as a named token.

Implementation: `src/styles/tokens.css` is a 1:1 mirror of `DESIGN.md` as CSS custom properties (`--bg`, `--accent`, etc.). Tailwind is configured to read these variables. Tokens are never hardcoded in components — only the variable name appears in code.

The aesthetic direction is **Industrial/Utilitarian × Modern Professional** ("Modern Trading Lab"). The full rationale and discipline rules (e.g., teal accent reserved for UI state, never data; up/down colors reserved for data, never chrome) live in `DESIGN.md`.

**Visual reference:** `docs/superpowers/designs/2026-05-20-replay-viewer.html` is the approved interactive mockup. Open it in a browser to see every token rendered with realistic dummy data.

### 5.3 Pages (v1 scope)

| Nav item | Page | v1 content |
|---|---|---|
| Replay Viewer | `/replay` | Full Replay Viewer with multi-tab analysis sessions. |
| Inventory | `/inventory` | Stub page with table of captured Stock-Dates (read-only). |
| Capture | `/capture` | Stub — placeholder ("v1: 외부 collector CLI 사용"). |
| Search | `/search` | Stub — placeholder. |
| Notes | `/notes` | Stub — placeholder. |
| Settings | `/settings` | Stub showing data dir path (read from `/api/meta` or env) and API URL. |

Stub pages render the nav and a simple "준비 중" card so the nav is always navigable.

## 6. Frontend architecture

### 6.1 Module layout

```
frontend/
  src/
    main.tsx
    App.tsx                  # router shell + nav
    styles/
      tokens.css             # design tokens (§5.2)
    api/
      client.ts              # fetch wrapper, base URL from env
      queries.ts             # react-query hooks per endpoint
      types.ts               # shared with backend (hand-mirrored)
    state/
      tabs.ts                # Zustand: tabs[], activeTabId, addTab/closeTab/...
      timeAxis.ts            # multi-day compressed-axis math (per-tab)
    nav/
      LeftNav.tsx
      NavItem.tsx
    pages/
      ReplayViewer.tsx       # tabs + toolbar + price strip + workarea
      Inventory.tsx          # stub
      Capture.tsx            # stub
      Search.tsx             # stub
      Notes.tsx              # stub
      Settings.tsx           # stub
    replay/
      TabStrip.tsx
      Tab.tsx
      Toolbar.tsx
      StockCombobox.tsx
      DateRangePicker.tsx
      RangePresets.tsx
      PriceStrip.tsx
    chart/
      ChartStage.tsx         # owns lightweight-charts instance + pane composition
      CandlePane.tsx
      RatioPane.tsx
      IntensityPane.tsx      # custom canvas layer
      VolumeProfileOverlay.tsx
      FillStrengthPane.tsx
    sidebar/
      CursorSidebar.tsx
      OrderbookTable.tsx
      BrokerNetTable.tsx
      FillTape.tsx
    util/
      format.ts              # KRW, qty, timestamp formatting
```

Each module has one clear purpose, communicates via props + the tabs store, and can be tested in isolation. No file should exceed ~250 lines.

### 6.2 Tab state model

```ts
type TabId = string;  // nanoid

type TabSelection = {
  code: string;
  fromDate: string;     // YYYYMMDD
  toDate: string;       // YYYYMMDD
};

type Tab = {
  id: TabId;
  selection: TabSelection | null;   // null until user clicks Load
  cursorMs: number | null;          // real-ms (pre-stitch)
  pinned: boolean;                  // cursor pinning state
  status: 'empty' | 'loading' | 'loaded' | 'error';
  errorMessage?: string;
};

type Store = {
  tabs: Tab[];
  activeTabId: TabId;

  // actions
  newTab: () => TabId;
  closeTab: (id: TabId) => void;
  setActive: (id: TabId) => void;
  setSelection: (id: TabId, sel: TabSelection) => void;
  setCursor: (id: TabId, ms: number, pinned: boolean) => void;
};
```

- Tab limit enforcement (8) happens in `newTab()`; over-limit shows a confirm modal then evicts the oldest.
- React-query keys are tab-scoped: `[tabId, 'candles', code, date]` — so closing one tab's NAVER data doesn't evict another tab's NAVER data. (Trade-off: duplicate fetch if two tabs hold the same Stock-Date. Acceptable in v1 for state isolation; revisit with a shared cache layer if needed.)
- Cursor pinning is per-tab.

### 6.3 Compressed multi-day time axis

**Problem:** Concatenating multiple Stock-Dates raw leaves a 17.5-hour gap between consecutive Regular Sessions, wasting screen space.

**Solution:** A virtual "session time" axis, computed per tab. Each tab builds its own mapping table:

```ts
type Segment = { date: string; sessionOpenMs: number; sessionCloseMs: number; virtualStart: number };
// virtualStart of segment N = sum of (sessionCloseMs - sessionOpenMs) of segments 0..N-1
```

- `realToVirtual(realMs, segment)` → virtual ms used on the chart.
- `virtualToReal(virtualMs)` → finds the segment by binary search, returns the real ms used for cursor-following API calls.
- Day boundaries are rendered as faint vertical guides with the date as a label.
- All four panes within a tab use the same virtual axis (lightweight-charts handles sync automatically when they share a chart instance).

This logic lives in `state/timeAxis.ts` and is the single source of truth for time conversion. Every API call out is real-ms; every chart coordinate is virtual-ms.

### 6.4 Data flow

```
Active tab's Toolbar (code + dateRange + Load)
    │
    ▼
store.setSelection(tabId, sel) ──► react-query keys: [tabId, endpoint, code, date]
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
- **Tab switching:** swapping `activeTabId` swaps which tab's queries are read. Inactive tabs keep their data cached (react-query default 5 min stale, 30 min gc). Switching back is instant.
- **Cursor:** `lightweight-charts` exposes `subscribeCrosshairMove`. The handler reads virtual ms, converts to (date, realMs), updates the active tab's `cursorMs`. React-query hooks keyed on `(tabId, code, date, t)` fetch automatically with 30 ms debounce.
- **Pinning:** clicking the chart pins the cursor (stops following mouse) so the user can hover the sidebar without losing the snapshot. Second click unpins. Pin state is per-tab.

### 6.5 Error handling

| Failure mode | Behavior |
|---|---|
| API 404 (no data for date) | Show date chip in red on that tab, exclude from chart, continue with other dates. |
| API 5xx | Toast scoped to the tab + retry button; cached dates still render. |
| Empty result (e.g. no brokers at `t`) | Sidebar shows "—" placeholder, no error. |
| Backend unreachable | Full-page banner over the workarea; nav still works. |

No silent fallbacks — every missing pane shows an explicit empty state with the reason.

## 7. URL state

State is serialized to the URL so reloading restores the workspace and links are shareable across the local machine:

```
/replay?t=005930.20260518-20260520;000660.20260519-20260520*;035420.20260520
                    ↑                ↑                          ↑
                tab 0          tab 1 (active = `*`)         tab 2
```

- Format: semicolon-separated tabs; each tab = `code.fromDate-toDate`; trailing `*` marks active.
- Cursor `cur=<ms>` may be appended after a `?` separator for the active tab; updated on pin only — not on every mouse move, to avoid history churn.
- For non-Replay pages, URL is just `/inventory`, `/settings`, etc.

If parsing fails (malformed URL), the app shows an empty Replay Viewer with one fresh tab and a non-blocking warning toast.

## 8. Testing strategy

- **Unit (Vitest):** `timeAxis.ts` (virtual↔real conversion, day boundaries, edge cases at session open/close), `state/tabs.ts` (add/close/active, 8-tab limit, cursor pinning), URL serialization round-trip, formatters, query-key construction.
- **Component (Testing Library):** TabStrip (active state, close, add), StockCombobox (filter, select), OrderbookTable, BrokerNetTable, FillTape with fixture JSON. Chart panes are NOT unit-tested (canvas) — covered by E2E screenshot only.
- **E2E (Playwright, one smoke):** open a tab, load a known Stock-Date from a fixture data dir, assert chart renders, move crosshair, assert sidebar updates, open a second tab with a different code, assert isolation (data doesn't leak between tabs). Run against a backend started with a test fixture data dir.
- **Backend additions:** the three new endpoints get DuckDB-driven unit tests in `tests/api/` using existing parquet fixtures, mirroring the pattern in current `tests/`.

## 9. Open questions resolved

| Question | Decision | Why |
|---|---|---|
| Multi-day stitching: backend or frontend? | Frontend (per Stock-Date fetches + virtual axis) | Keeps backend per-date API symmetric with existing endpoints. |
| Series indicator computation: backend or frontend? | Backend (3 new endpoints) | DuckDB is faster, fewer bytes over the wire, indicators are reusable. |
| Chart library? | lightweight-charts | Matches "TradingView 스타일" target, free, mature. |
| Cursor API strategy? | react-query + 30 ms debounce, key per `(tabId, code, date, t)` | Caches naturally, no extra debouncer code, tab-isolated. |
| Auction crosses in volume profile? | Excluded (`side != 0`) | Matches `CONTEXT.md` Auction Cross rule for aggressor-based metrics. |
| Multi-stock analysis pattern? | Browser-style tabs (per-tab state) | Mirrors how analysts work — keep multiple stocks open, compare. |
| Tab data sharing between tabs? | Tab-scoped react-query keys, no shared cache in v1 | Simpler state isolation; revisit if duplicate fetches become a pain. |
| Soft tab limit? | 8 simultaneous tabs | Bounds memory; older tabs evicted with confirmation. |
| Where do non-Replay pages live in v1? | Render as stubs, nav stays consistent | Builds the shell once; future pages slot in without nav rework. |

## 10. Risks and mitigations

- **Intensity heatmap response size.** Capped server-side (200 × 1000 cells/day). At 3 days × 1 tab = 600k cells = ~5 MB JSON; at 8 tabs × 3 days = ~40 MB if all active. Acceptable for localhost; tabs cache lazily (only fetched when activated).
- **lightweight-charts custom pane limits.** v5 supports multiple panes well, but custom canvas overlays (volume profile, intensity) must be hand-wired to its time-scale. Spike this first in the plan.
- **Memory growth with many tabs.** 8-tab cap + react-query gc (30 min default) bounds it, but a long session with frequent tab swaps could still climb. Add a "memory used" indicator in nav footer as v1+1 follow-up.
- **Tab isolation duplicate fetches.** Opening two tabs on the same Stock-Date fetches twice. Acceptable for v1 (local API, fast); fix with a shared series cache keyed by `(code, date)` if it becomes annoying.
- **Date range size.** No hard cap in v1, but rendering >10 days will get slow. Document, don't enforce.

## 11. Out of scope, captured for follow-ups

- Data Window toggle (show pre-market and closing auction).
- Export current view as PNG.
- Shared series cache across tabs (deduplicate fetches when two tabs hold the same Stock-Date).
- Reordering tabs via drag (v1 supports close + add only; reorder is keyboard/drag follow-up).
- Persist open tabs across reloads in localStorage (v1 uses URL only).
- Broker history time-series (already-aggregated server-side is a separate ticket).
- Real implementations of Inventory / Capture / Search / Notes pages.
