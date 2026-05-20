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
4. See a TradingView-style multi-pane chart with **candles + volume** across multiple Stock-Dates stitched on a compressed time axis. v1 shows the **trading-active window 09:00–16:00** per Stock-Date — Regular Session (09:00–15:30, including the closing **Auction Window** 15:20–15:30) plus the After-Hours Trading window (15:30–16:00, continuous matching at the closing price).
5. See four time-series supporting indicators ALWAYS visible alongside the candles, sharing the same x-axis — all pre-aggregated by the backend and shipped in the session bundle (§4.1):
   - 호가 imbalance (signed bid/ask quantity imbalance, 0-centered) — line. Formula in §4.1.
   - 매물대 (volume profile) — horizontal histogram overlay on the candle pane.
   - 호가잔량 intensity — split heatmap (x = time, y = price). Each cell's color intensity is the **bid OR ask quantity** at that (time, price); bid cells use one hue, ask cells use another. The natural orderbook structure makes ask cells cluster above the mid-price and bid cells below — no explicit divider line needed.
   - 체결 강도 (fill strength) — per-minute buy vs sell volume bars under the chart.
6. See three cursor-following indicators in a right sidebar that update as the user moves the chart crosshair — all raw event streams fetched as a spot lookup at the cursor's `t`:
   - 10호가 테이블 — orderbook snapshot at cursor `t`.
   - 거래원 입체 분석 — net (buy − sell) by broker at cursor `t`.
   - 체결 데이터 그래프 — recent trades around cursor `t` (small tape).

## 2. Non-goals (v1)

- Real-time / live streaming. Replay only — data is already captured.
- Drawing tools, alerts, custom indicators, multi-symbol overlays.
- Authentication, multi-user, persistence of user state across reloads (other than URL params).
- Mobile layout. Desktop-only, dark theme only.
- Pre-market display (~08:40–09:00 per `CONTEXT.md` Data Window). v1 shows 09:00–16:00 only; extending the left edge to pre-market is a follow-up.

## 3. Stack

| Layer | Choice | Rationale |
|---|---|---|
| Build | Vite + React + TypeScript | CORS already whitelists `:5173`; matches existing intent. |
| Charts | `lightweight-charts` v5 (TradingView, Apache 2.0) | Native candle + multi-pane + crosshair sync; small (~200 KB). |
| Custom overlays | Plain `<canvas>` layered on chart panes | For volume profile and intensity heatmap (not built into lightweight-charts). |
| Bundle fetch | `@tanstack/react-query` | One `/api/session` query per tab, per date. Retry/dedupe on bundle only. |
| Cursor fetch | Tiny custom `useSpot<T>` hook (~30 LoC) | 30 ms debounce + LRU cap (100 entries/tab) — predictable memory, no react-query cache key growth. |
| Client state | Zustand | Per-tab `{selection, cursorMs, bundles[date], spotLRU}` plus `tabs[]` and `activeTabId`. |
| Styling | Tailwind CSS + CSS variables driven by design tokens (§5.1) | Dark theme only in v1. |
| Date picker | `react-day-picker` v9 | Per-day disable for sparse capture inventory (native `<input type="date">` only supports continuous min/max). Headless — styled with DESIGN.md tokens. ~25 KB gzip. |
| Tests | Vitest + Testing Library; Playwright for one smoke E2E | Match local-tool ethos — light, fast. |

Frontend source lives in `frontend/` at repo root (new directory). It is **not** bundled or served by FastAPI; it's a standalone Vite dev server. Production deploy is out of scope.

**Runtime config**: the API URL is read at app start from `/config.json` (served from `frontend/public/`), not baked at build time. Default shape:

```json
{ "api_url": "http://localhost:8000" }
```

The user can change the API port by editing `public/config.json` and reloading — no rebuild needed. If `/config.json` is missing or unparseable, the app falls back to `http://localhost:8000` with a non-blocking warning banner. Future config keys (theme overrides, feature flags) slot into the same file.

## 4. Backend API

Two-tier API split that matches the UI:

- **Session bundle (§4.1)** — one big fetch on Load. Contains everything pre-aggregated for the always-visible chart panes (candles + 4 indicator series). All sized in KB or low MB, never grows with stock activity beyond a tight bound. The four chart panes read entirely from this bundle.
- **Cursor spot endpoints (§4.2)** — three small per-cursor fetches as the user moves the crosshair. Each request returns one event (or a small window) at the cursor's `t`. Used by the three sidebar cards. Bounded LRU cache on the client.

This split eliminates the previous "many-keyed react-query cache" memory hazard: the bundle is one stable object per (tab, date), and spot fetches are bounded by LRU.

### Time domain (what data exists when)

For one Stock-Date, hogaplay returns the following within the v1 display window 09:00–16:00:

| Window | Time | snapshots.parquet | trades.parquet |
|---|---|---|---|
| Continuous Trading | 09:00:00 – 15:20:00 | ✓ continuous | ✓ continuous (`side = ±1`) |
| Closing **Auction Window** | 15:20:00 – 15:30:00 | ✓ continuous (잔량 변화만) | ✗ no trades during window |
| Closing Auction Cross | 15:30:00.000 | (final auction snapshot) | 1 row, `side = 0` |
| After-Hours Trading | 15:30:00 – 16:00:00 | ✓ continuous (잔량) | ✓ continuous, all trades at closing price (`side = ±1`) |
| After 16:00 | 16:00:00 → | ✗ none | ✗ none |

Implications for the bundle indicators:
- **quote_ratio** and **depth_intensity** are continuous across the full 09:00–16:00 window — snapshots fill every bucket.
- **fill_strength** shows a gap during the closing Auction Window (no trades) followed by a single tall bar at 15:30:00 for the Auction Cross, then resumes for After-Hours Trading at lower volume.
- **volume_profile** has a visible spike at the closing price because all After-Hours Trading volume aggregates into that one bin (accurate, not a bug — reflects market structure).
- Pre-market (~08:40–09:00) is part of the **Data Window** per `CONTEXT.md` but is out of v1 scope. When v1+1 adds it, the same table extends with an opening Auction Window.

### 4.1 `GET /api/session?code&date` — Session bundle (new)

Returns one bundle aggregating every time-series and aggregate the always-visible chart panes need. Fetched once on Load; all four chart panes (and the volume-profile overlay) read from this bundle without further network calls.

Response shape:

```json
{
  "code": "005930",
  "date": "20260518",
  "session_open_ms": 1747526400000,
  "session_close_ms": 1747551600000,
  "candles":         { ... },
  "quote_ratio":     { ... },
  "depth_intensity": { ... },
  "volume_profile":  { ... },
  "fill_strength":   { ... }
}
```

Backend runs the 5 DuckDB queries in parallel internally and returns one cohesive response (~1–2 MB JSON, ~300–600 KB gzipped). Either all five succeed or the request fails — partial bundles aren't useful.

**`candles`** — 1-minute OHLCV bars from `candles.parquet`, as-is. Each: `{t, o, c, h, l, vol}`. ~390 rows/day.

**`quote_ratio`** — bid/ask total quantities sampled in 1 s buckets. Backend ships **raw totals**; client computes the signed imbalance for display (formula below).

```json
"quote_ratio": {
  "bucket_ms": 1000,
  "points": [{"t": 1747526400000, "bid_total": 12345, "ask_total": 9876}, ...]
}
```

Source: `snapshots.parquet`, summed across all 10 levels, last snapshot per bucket.

Client-side imbalance metric:

```ts
// 0 = balanced. Positive = sell-heavy. Negative = buy-heavy.
function quoteImbalance(bid: number, ask: number): number {
  if (bid <= 0 || ask <= 0) return 0;
  return ask >= bid ? (ask / bid - 1) : -(bid / ask - 1);
}
```

A 1.2× sell-heavy state plots at `+0.2`; 1.2× buy-heavy at `−0.2`; balance at `0`. The line crosses `0` continuously when imbalance flips. Y-axis ticks formatted back to the ratio: `1.2× SELL`, `1.5× SELL`, `BALANCE`, `1.2× BUY`, `1.5× BUY`. Range capped at ±2.0 (≈ 3× ratio); larger values clip.

**`depth_intensity`** — two parallel 2-D heatmap grids (one for bid quantities, one for ask) sharing the same time + price axes. The pane renders bid cells in one hue (typically the buy/up color) below the natural mid-price cluster and ask cells in another hue (sell/down color) above. The two grids never overlap in practice (orderbook invariant: `bid_max < ask_min` outside the Auction Window cross moment).

```json
"depth_intensity": {
  "bucket_ms": 1000,
  "price_min": 67500, "price_max": 71200, "price_step": 50,
  "times":    [1747526400000, 1747526401000, ...],
  "bid_grid": [[0, 0, 12000, 8500, ...], ...],   // shape: len(times) × price_bins
  "ask_grid": [[0, 0, 14000, 9100, ...], ...]    // shape: len(times) × price_bins
}
```

Per cell semantics: for each (time bucket, price bin), `bid_grid[t][p]` is the **max bid quantity** observed at that price across all 10 bid levels during the bucket; `ask_grid[t][p]` is the corresponding **max ask quantity** across all 10 ask levels. Most cells are 0 (each snapshot has 10 nonzero bid levels + 10 nonzero ask levels out of `price_bins` possible).

Source: `snapshots.parquet`. DuckDB unpivots the 20 level columns, splits by side (level 1–10 ask vs level 1–10 bid), bins by price.

Response size: each grid capped at 200 × 1000 = 200k cells; bundle ships both = up to 400k cells per Stock-Date (~3–4 MB JSON). Still within bundle target. Server enforces cap by widening `bucket_ms` or downsampling `price_bins` if the raw resolution would exceed it.

**Auction Window note:** during 15:20–15:30 the orderbook briefly allows `bid_price >= ask_price` (overlapping orders awaiting the single-price cross). In this window both grids may have nonzero values at the same (time, price) cell. The client renders both cells stacked (additive alpha) — the visual overlap is the analyst's signal that the auction is converging.

**`volume_profile`** — price-binned histogram of executed volume.

```json
"volume_profile": {
  "price_min": 67500, "price_max": 71200, "price_step": 50,
  "bins": [{"price_low": 67500, "qty": 12340}, ...]
}
```

`qty` is **total executed volume** at each price bin — includes both continuous-trading (`side = ±1`) and auction-cross (`side = 0`) rows. The volume profile answers "where did trades happen", and KRX opening/closing auctions are a meaningful slice of that signal (often 5–15% of daily volume for large caps). The `CONTEXT.md` Auction Cross exclusion rule applies to aggressor-based metrics (CVD), not plain volume aggregation. No buy/sell split.

**Multi-day rendering** (when the user selects N Stock-Dates):
- **Default = per-day side-by-side.** Each Stock-Date's `volume_profile` is rendered as its own vertical histogram strip at the right edge of that day's segment on the compressed time axis. Days are visually comparable side-by-side.
- **Toggle = single combined.** A small toggle in the Price/Volume/Profile pane header switches to one combined histogram at the right edge of the whole chart. Client rebins the N per-day grids onto a common price scale (union of all `[price_min, price_max]` ranges, 100 bins) and sums. Rebinning is coarse interpolation — acceptable since the histogram itself is a coarse summary.
- Backend ships per-Stock-Date `volume_profile` always; the toggle is a client-side rendering choice with no extra fetch.

**`fill_strength`** — per-minute aggregated buy vs sell volume for the chart pane.

```json
"fill_strength": {
  "bucket_ms": 60000,
  "points": [{"t": 1747526400000, "buy_qty": 1500, "sell_qty": 2200}, ...]
}
```

Source: `trades.parquet` summed per minute. `side = +1` → `buy_qty`, `side = -1` → `sell_qty`, `side = 0` → excluded (per the `CONTEXT.md` Auction Cross rule — this IS an aggressor-based metric). The pane shows stacked bars; the closing Auction Cross at 15:30:00 produces an explicit zero-bar minute followed by `side = 0` excluded — visible as a natural gap.

**Bundle size summary:** stock activity affects only `depth_intensity` (capped) and `quote_ratio` (~25k points = ~200 KB). Bundle is fixed-size regardless of stock activity: ~1–2 MB / Stock-Date.

### 4.2 Spot endpoints (existing, unchanged)

Used by the three cursor-following sidebar cards. All return small responses; client wraps them in an LRU cache bounded to ~100 entries per tab.

| Endpoint | Returns | Used by | Approx response size |
|---|---|---|---|
| `GET /api/orderbook?code&date&t` | 10-level snapshot at-or-before `t` | 10호가 sidebar card | ~500 B |
| `GET /api/brokers?code&date&t` | Top-5 buy + top-5 sell broker state at `t` | 거래원 sidebar card | ~200 B |
| `GET /api/trades?code&date&from&to&limit` | Trades within `[from, to]` | 체결 sidebar tape (`from=t-5000ms, to=t, limit=20`) | ~1 KB |

All three already exist per the backend spec (`docs/superpowers/specs/2026-05-19-hoga-ops-design.md`). v1 frontend uses them as-is; no signature changes.

### 4.3 Stock-date search

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
- Tabs are reorderable via drag (native HTML5 drag-and-drop, no library — 8 tab max keeps it simple) and closeable via the X button shown on hover.
- **The last remaining tab has its close X disabled** (hidden on hover, no click affordance). The app never reaches a zero-tab state and never re-creates a tab the user just tried to close. If the user wants to clear everything, they leave one empty tab — explicitly the intended "blank slate".

**Toolbar (60 px, per-tab):**
- 종목 combobox: searchable dropdown sourced from `/api/stock-dates` inventory, shows code + name + captured-dates count.
- 기간: from/to date fields, each opens a `react-day-picker` calendar popover. Days not in the captured inventory for the selected code are disabled (greyed, unclickable). Disabled-day set comes from `/api/stock-dates` filtered to the active code. For single-day analysis, the user sets `from = to`.
- **Changing the stock clears the date range.** When the user picks a different code in the combobox, `from`/`to` reset to empty and the user re-selects dates against the new code's inventory. Avoids the "I selected 5/20 which exists for 005930 but not for 000660" silent-mismatch problem, and forces the user to consciously re-scope after switching symbols.
- `데이터 불러오기` primary button: triggers prefetch for the current tab.

No quick-range presets in v1. Analysts pick specific captured Stock-Dates, not sliding windows; presets like "1W" don't map cleanly to the capture-driven workflow. A "fill-from-to back N captures" shortcut may be added later if calendar clicking proves slow.

**Price strip (52 px, per-tab):**
- Symbol block (code + name).
- **Current price** (mono 22 px) — the close of the candle at the **right edge of the visible viewport**. Viewport-dependent: as the user pans/zooms, this value updates via `timeScale().subscribeVisibleTimeRangeChange()`. When fully zoomed out, it equals the last loaded candle's close.
- **Delta chip** — `(current_price − viewport_left_edge_close) / viewport_left_edge_close × 100%`. Also viewport-dependent: the "change" answers "how did price move across what I'm currently looking at". Sign drives the chip tint (pos = green tint, neg = rose tint).
- **OHLC + Vol** at cursor `t` (compact mono) — independent of viewport; tracks the crosshair.
- Right side: cursor indicator (pulsing dot + virtual timestamp).

The viewport-dependent current price + viewport-dependent delta + cursor-dependent OHLC give three semantically distinct readings: "where I'm looking", "how price moved across what I'm looking at", and "what's at my cursor right now". Edge cases: viewport ≤ 1 candle wide → delta shows `—`; viewport extends beyond loaded data → current price uses the last available candle on that side.

**Workarea:**
- Left 1fr / right 320 px sidebar.
- Left: 4 panes stacked vertically with `grid-template-rows: 1fr 0.5fr 1fr 0.6fr` — Price/Volume/Profile, Bid/Ask Ratio, Depth Intensity, Fill Strength.
- Right: 3 cards stacked — Orderbook 10 Levels, Broker Net Flow, Recent Fills.

**Pane header controls:** the Price/Volume/Profile pane header carries a small toggle for the matprofile rendering mode — default "per-day" (side-by-side histograms per Stock-Date), alternate "combined" (single histogram across all selected dates). See §4.1 `volume_profile` for the underlying data and rebinning behavior.

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
| Settings | `/settings` | Stub showing the API URL (read at runtime from `/config.json`) and the app version. Data dir path, capture stats, and disk usage need a new `/api/config` endpoint (deferred to v1+1, §11). |

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
      session.ts             # react-query hook for the /api/session bundle
      useSpot.ts             # ~30 LoC: 30 ms debounce + LRU(100) for cursor fetches
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

type SessionBundle = {
  code: string;
  date: string;
  sessionOpenMs: number;
  sessionCloseMs: number;
  candles: Candle[];
  quoteRatio: { bucketMs: number; points: QuoteRatioPoint[] };
  depthIntensity: DepthIntensityGrid;
  volumeProfile: VolumeProfile;
  fillStrength: { bucketMs: number; points: FillStrengthPoint[] };
};

type Tab = {
  id: TabId;
  selection: TabSelection | null;       // null until user clicks Load
  cursorMs: number | null;              // real-ms (pre-stitch); follows mouse, no pin state
  status: 'empty' | 'loading' | 'loaded' | 'error';
  errorMessage?: string;
  bundles: Map<string, SessionBundle>;  // keyed by YYYYMMDD date
  spotLRU: LRUMap<string, unknown>;     // keyed by `${endpoint}:${t}` — capped at 100
};

type Store = {
  tabs: Tab[];
  activeTabId: TabId;

  // actions
  newTab: () => TabId;
  closeTab: (id: TabId) => void;
  setActive: (id: TabId) => void;
  setSelection: (id: TabId, sel: TabSelection) => void;
  setCursor: (id: TabId, ms: number | null) => void;
};
```

- Tab limit enforcement (8) happens in `newTab()`; over-limit shows a confirm modal then evicts the oldest.
- **Bundles** are tab-scoped (`tab.bundles[date]`). Closing a tab drops its bundles entirely. Two tabs holding the same Stock-Date fetch twice — acceptable in v1 (shared series cache is a follow-up, §11).
- **Spot LRU** is per tab, capped at 100 entries. Trivial memory bound (~200 KB worst case); evicted on tab close.
- **Cursor follows the mouse only**; when the mouse leaves the chart, `cursorMs` stays at its last value and the sidebar keeps showing that data. No pin/lock concept in v1.

**Tab UI by state:** before a tab has loaded data, the workarea (chart + sidebar) renders an **onboarding card** that walks the user through the required steps. The card replaces both the chart panes and the sidebar; once `status === 'loaded'`, the card disappears and the chart + sidebar take over.

| Tab state | `selection` | `status` | Workarea content |
|---|---|---|---|
| Fresh tab | `null` | `empty` | Onboarding card. Step 1 (`종목 선택`) is highlighted. Toolbar shows empty inputs. |
| Stock chosen, no date | partial in toolbar (not yet committed to `selection`) | `empty` | Onboarding card. Step 2 (`기간 선택`) highlighted; Step 1 shows `✓ 005930 · 삼성전자`. |
| Both chosen, Load not clicked | partial in toolbar | `empty` | Onboarding card. Step 3 (`데이터 불러오기 클릭`) highlighted; Load button visually emphasized to match. |
| Loading | committed | `loading` | Onboarding card replaced by spinner card with current step ("3 / 3 — 데이터 가져오는 중"). |
| Loaded | committed | `loaded` | Onboarding card gone. Chart panes + sidebar render normally. |
| Load failed (5xx) | committed | `error` | Chart panes render available dates; failed date segments are red with `Retry`. Tab status dot also red. |

Toolbar inputs are **always visible and always interactive** — even when `status === 'loaded'`, the user can change the stock or dates and click Load again. The onboarding card is purely workarea content, not chrome.

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
- **Intra-day segments are NOT visually distinguished.** The Auction Window (15:20–15:30) and After-Hours Trading (15:30–16:00) share the same background as Continuous Trading. The analyst reads the time from the x-axis to know which segment they're in. Rationale: this is a single-user tool, the user already knows the KRX session structure, and visual segmentation would add chrome that doesn't help analysis.
- All four panes within a tab use the same virtual axis (lightweight-charts handles sync automatically when they share a chart instance).

This logic lives in `state/timeAxis.ts` and is the single source of truth for time conversion. Every API call out is real-ms; every chart coordinate is virtual-ms.

### 6.4 Data flow

```
Active tab's Toolbar (code + dateRange + Load)
    │
    ▼
store.setSelection(tabId, sel)
    │
    ▼
For each Stock-Date in dateRange (parallel):
    GET /api/session?code&date  ──► one bundle per Stock-Date (~1–2 MB)
    │
    ▼
tab.bundles[date] = bundle    (cached in Zustand per tab, lives until tab close)
    │
    ▼
All four chart panes render from tab.bundles (no further network)

────────────────────────────────────────────────────────────────────
[user moves mouse]
    │
    ▼
lightweight-charts crosshair → virtualMs → realMs (date, t)
    │
    ▼ (30 ms debounce)
Three parallel spot fetches: orderbook(t), brokers(t), trades(t-5s, t)
    │
    ▼
Sidebar cards render from spot responses (each cached in tab.spotLRU)
```

- **Bundle prefetch on Load:** one `/api/session` call per selected Stock-Date, fired in parallel with `Promise.allSettled`. Per §6.5: 404 results drop silently from the virtual axis; 5xx results render a red retry segment. Other dates still render either way. Backend computes the 5 bundle slices via concurrent DuckDB queries; total time on localhost ~300–800 ms per Stock-Date.
- **Bundle lookup is synchronous:** every chart pane reads from `tab.bundles[date]` directly. No React Suspense, no react-query for bundles. Once Load finishes, scrolling and zooming don't fetch anything.
- **Spot fetches on cursor move:** three small GETs at 30 ms debounce. Each ~500 B – 1 KB. Total per cursor move = ~2 KB on the wire.
- **Spot LRU cache:** per tab, capped at 100 entries each. Recently visited cursor positions stay hot; far-away keys evict. Cache shape: `Map<keyHash, response>` with LRU eviction. Memory bound: ~200 KB/tab worst case.
- **Tab switching:** instant. Bundles for inactive tabs stay in memory; spot LRU stays per tab. Switching back is `tab.bundles[date]` lookup + `tab.cursorMs` re-broadcast.
- **Cursor persists when mouse leaves the chart.** `cursorMs` holds its last value while the mouse is over the sidebar or anywhere off the chart; sidebar cards keep their data. Re-entering the chart at a new position updates the cursor normally. No explicit pin/lock action — the persistence is automatic.
- **No react-query for cursor data.** The 30 ms debounce + spot LRU is implemented as a small hook (`useSpot<T>(key, fetcher)`) — ~30 LoC. react-query is reserved for the bundle fetch where its retry/dedupe shine.

### 6.5 Error handling

| Failure mode | Behavior |
|---|---|
| `/api/session` 404 (date not in inventory — market closed, not captured, or removed) | **Silently drop that date from the tab's virtual axis.** No segment rendered, no chip. Other dates continue rendering normally. Reachable only via URL direct entry (the date picker disables non-captured dates). |
| `/api/session` 5xx / network error | Render an explicit **red error segment** on the virtual axis with `Load failed` label and a `Retry` button that re-fetches only that date. Other dates still render. The tab's status dot turns red until all dates succeed. |
| Spot endpoint 404 (no orderbook/brokers/trades at `t`) | Sidebar card shows `—` placeholder; no error. |
| Spot endpoint 5xx | Sidebar card shows compact inline error with retry icon; other cards still render. |
| Backend unreachable | Full-page banner over the workarea; nav still works. |

The 404 vs 5xx split is deliberate: a 404 from the bundle endpoint is the **expected state** for any date not in inventory (KRX holidays, weekends, uncaptured dates), so it should look normal — no visual noise. A 5xx is a genuine error worth surfacing.

This cooperates with the collector layer: when the hogaplay capture for a date returns no data, the collector is expected to skip rather than create an empty Stock-Date directory. Inventory then naturally reflects only dates with real data, and the frontend never needs a separate KRX trading calendar to decide what to disable.

## 7. URL state

State is serialized to the URL so reloading restores the workspace, the browser back/forward buttons work, and a user can open the same analysis in a second browser tab by copying the URL.

```
/replay?tabs=005930:20260518:20260520,000660:20260519:20260520,035420:20260520:20260520&active=1
```

**Format:**
- `tabs` — comma-separated list. Each tab is `code:fromDate:toDate`, **always 3 colon-separated parts**. Single-date analysis writes `fromDate = toDate` explicitly; no shorter form is allowed.
- `active` — zero-indexed integer pointing at the active tab in `tabs`. Required.
- Dates are `YYYYMMDD` (no hyphens) per `CONTEXT.md` Stock-Date convention.
- All characters used (`:`, `,`, digits, letters) are URL-safe — no encoding needed, no server interpretation collisions.

**Examples:**
- Single tab, single date: `/replay?tabs=005930:20260520:20260520&active=0`
- Two tabs, second active: `/replay?tabs=005930:20260518:20260520,000660:20260520:20260520&active=1`
- Empty Replay (fresh launch): `/replay` (no `tabs` param → app creates one fresh empty tab)

**Cursor position is not serialized.** Cursor follows the mouse and is transient; encoding every move would churn history endlessly. Reloading restores tabs and date ranges; cursor starts unset until the user hovers the chart.

**Non-Replay pages:** URL is just the path — `/inventory`, `/settings`, etc. No query params.

**Parse errors:**
- Unknown `code`, malformed date, `active` out of bounds, or any other parsing failure → app opens an empty Replay Viewer with one fresh tab and shows a non-blocking warning toast naming the issue.
- Duplicate tab specs (same code + same range twice) are kept as-is; the user might intentionally want two views of the same selection (e.g., different cursor positions).

## 8. Testing strategy

- **Unit (Vitest):** `timeAxis.ts` (virtual↔real conversion, day boundaries, edge cases at session open/close), `state/tabs.ts` (add/close/active, 8-tab limit, bundle storage, cursor persistence on mouse leave), `useSpot` hook (debounce timing, LRU eviction at 100 entries), `quoteImbalance` formula, URL serialization round-trip, formatters.
- **Component (Testing Library):** TabStrip (active state, close, add, drag-reorder), StockCombobox (filter, select), OrderbookTable, BrokerNetTable, FillTape with fixture JSON. Chart panes are NOT unit-tested (canvas) — covered by E2E screenshot only.
- **E2E (Playwright, one smoke):** open a tab, click Load, assert `/api/session` fires once per Stock-Date, assert all 4 chart panes render from the bundle, move crosshair and assert exactly 3 spot fetches per debounce tick (orderbook + brokers + trades), assert sidebar updates, open a second tab with a different code, assert bundle isolation (data doesn't leak between tabs). Run against a backend started with a test fixture data dir.
- **Backend additions:** the new `/api/session` endpoint gets DuckDB-driven unit tests in `tests/api/` covering each of the 5 bundle slices independently, plus one integration test asserting the full bundle structure. Existing per-cursor endpoints (`orderbook`, `brokers`, `trades`) already have tests in current `tests/`.

## 9. Open questions resolved

| Question | Decision | Why |
|---|---|---|
| Multi-day stitching: backend or frontend? | Frontend (per Stock-Date fetches + virtual axis) | Keeps backend per-date API symmetric with existing endpoints. |
| Time-series indicator computation: backend or frontend? | **Backend, bundled in one `/api/session` response** | DuckDB-side aggregation is cheap; one cohesive bundle simplifies client + bounds bundle size regardless of stock activity. |
| Time-series shipping: bundle endpoint or split endpoints? | **One `/api/session` bundle** | One round-trip on Load, atomic success/failure, simpler client mental model. |
| Auction crosses in volume profile? | **Included** (all `side` values aggregated, single bar per bin) | "Where did trades happen" needs auction volume too — KRX opening/closing auction is 5-15% of daily volume. CONTEXT.md's `side=0` exclusion rule applies to aggressor-based metrics (CVD), not plain volume aggregation. |
| Auction crosses in fill_strength? | **Excluded** (`side != 0`) | fill_strength IS an aggressor-based metric per CONTEXT.md — auction crosses have no aggressor. |
| Quote-ratio orientation? | **Backend ships raw bid/ask totals**; client computes signed imbalance (formula in §4.1) | One representation lives in the client; backend stays domain-neutral. |
| Chart library? | lightweight-charts | Matches "TradingView 스타일" target, free, mature. |
| Cursor fetch strategy? | **3 spot fetches (orderbook + brokers + trades-window), 30 ms debounce, custom LRU (100/tab)** | Avoids the previous "cursor-keyed react-query cache" memory hazard; constant memory regardless of mouse activity. |
| Tab data sharing between tabs? | Per-tab bundles + per-tab spot LRU, no shared cache in v1 | Simpler state isolation; revisit shared cache if duplicate fetches become a pain. |
| Multi-stock analysis pattern? | Browser-style tabs (per-tab state) | Mirrors how analysts work — keep multiple stocks open, compare. |
| Soft tab limit? | 8 simultaneous tabs | Bounds memory; older tabs evicted with confirmation. |
| Where do non-Replay pages live in v1? | Render as stubs, nav stays consistent | Builds the shell once; future pages slot in without nav rework. |
| Date picker library? | `react-day-picker` v9 | Per-day disable for sparse capture inventory; headless and token-friendly. |
| Quick range presets? | **Removed in v1** | Captured-date-driven analysis doesn't map to sliding "1W" windows — analysts pick specific dates. |
| Current price meaning at price strip? | Close of the candle at the **viewport's right edge** (dynamic on pan/zoom) | Tracks "what I'm looking at right now". OHLC separately tracks the cursor. |
| Delta chip baseline? | `(current price − viewport's left-edge close) / left-edge close` | Same viewport-bound model; answers "how price moved across what I'm looking at". |
| Intra-day segment shading (Continuous / Auction Window / After-Hours)? | **No** — analyst reads time off the x-axis | Single-user tool; visual segmentation is chrome the user doesn't need. |
| `depth_intensity` representation? | Two parallel grids (`bid_grid`, `ask_grid`) sharing axes | Required to color bid/ask separately; orderbook invariant `bid_max < ask_min` means they never overlap (except auction-cross moment). |
| `volume_profile` for multi-day? | Per-day side-by-side **(default)** with toggle to combined single histogram | Per-day comparison is the more useful first view; combined available for whole-period perspective. |
| Cursor pin/lock? | **None in v1** | Mouse-driven cursor with automatic persistence on chart leave covers the analytics workflow; pin adds UI surface without clear payoff. |
| API URL configuration? | Runtime `/config.json` (defaults to `http://localhost:8000`) | Re-port without rebuild; future config keys slot in. |
| 404 vs 5xx for missing dates? | 404 = silently dropped from virtual axis; 5xx = red retry segment | 404 is the expected state for non-captured / market-closed dates and should look normal. |
| Last tab close behavior? | Close X disabled on the last remaining tab | Never re-creates a tab the user just tried to close. |
| Stock change clears date range? | **Yes** | Avoids silent date-mismatch when switching to a code with a different capture inventory. |
| URL state encoding? | `?tabs=code:from:to,...&active=N` (always 3 colon parts, comma-separated, zero-indexed active) | URL-safe characters, unambiguous, easy to parse. |
| Date range hard cap? | **None** | Single-user tool; analyst is in control. Sluggishness past ~10 days is documented, not enforced. |

## 10. Risks and mitigations

- **Bundle compute time.** All 5 DuckDB queries run in parallel; total backend time is dominated by `depth_intensity` (unpivot + split by side + bin, two grids). Spike this first — target <1 s per Stock-Date on a representative captured day. If slower, add server-side caching (`depth_intensity` for the same `(code, date)` is deterministic).
- **lightweight-charts custom pane limits.** v5 supports multiple panes well, but custom canvas overlays (volume profile, intensity heatmap) must be hand-wired to its time-scale. Spike this first too.
- **Tab isolation duplicate fetches.** Opening two tabs on the same Stock-Date fetches the same bundle twice. Acceptable for v1 (local API, fast); fix with a shared bundle cache keyed by `(code, date)` if it becomes annoying.
- **Date range size.** No hard cap, no warning, no modal in v1 — the analyst is in control. 10 days × 1.5 MB = 15 MB per tab is fine; chart rendering past ~10 days starts to feel sluggish; 30+ days will be slow. Documented here, not enforced in the UI. If sluggishness becomes a real complaint, add a soft warning chip in v1+1.
- **Bundle size for top-tier stocks** (삼성전자, SK하이닉스). `depth_intensity` is capped, `quote_ratio` is bucketed — bundle size is activity-independent. The cost shifts to backend compute time (more snapshots to scan), not to wire size.

## 11. Out of scope, captured for follow-ups

- Data Window toggle (show pre-market and closing auction).
- Export current view as PNG.
- Shared bundle cache across tabs (deduplicate fetches when two tabs hold the same Stock-Date — currently each tab fetches its own bundle).
- Keyboard shortcuts for tab navigation (Ctrl+Tab / Ctrl+Shift+Tab). v1 is mouse-only; keyboard shortcuts are a follow-up.
- Persist open tabs across reloads in localStorage (v1 uses URL only).
- Broker history time-series (already-aggregated server-side is a separate ticket).
- Real implementations of Inventory / Capture / Search / Notes pages.
- `GET /api/config` (or `/api/system`) — backend endpoint exposing global state (data dir path, captured Stock-Date count, disk usage). Needed for a real Settings page; deferred to v1+1.
