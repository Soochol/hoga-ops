# Frontend Design — Multi-Day Orderbook Replay Viewer

**Status:** Draft (awaiting user review)
**Date:** 2026-05-20
**Spec owner:** blessp@naver.com
**Related:**
- `DESIGN.md` (repo root) — design system tokens (colors, fonts, spacing, motion). **Source of truth for any visual question this spec does not answer.**
- `docs/superpowers/designs/2026-05-20-replay-viewer.html` — interactive HTML mockup of Replay Viewer with realistic dummy data. **Source of truth for layout pixels.**
- `docs/superpowers/specs/2026-05-19-hoga-ops-design.md` — backend spec.
- `docs/adr/0003-api-time-encoding.md` — API timestamps are Unix epoch ms (UTC). Backend dependency this spec relies on.
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
   - 체결 데이터 (recent trades tape) — table of recent trades around cursor `t`, no chart.

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
| Router | `react-router` v7 (declarative data routers) | Six routes (`/replay`, `/inventory`, `/capture`, `/search`, `/notes`, `/settings`) under one nav shell; URL state encoding for `/replay` query params (§7). Battle-tested, well-documented. ~25 KB gzip. |
| Tab drag-reorder | `@dnd-kit/core` + `@dnd-kit/sortable` | Smooth tab reordering with proper drop indicators, ESC-to-cancel, keyboard accessibility. Native HTML5 drag is too rough at this UX level. ~20 KB gzip combined. |
| Real-time inventory push | Browser native `EventSource` (SSE) + backend `sse-starlette` + `watchdog` | One persistent connection per app for `/api/events`. Backend pushes `inventory_added` / `inventory_removed` events; frontend invalidates the `stock-dates` query and the combobox updates without a manual refresh. |
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

### Time encoding (backend dependency)

**All API responses and requests must use Unix epoch milliseconds (UTC) for every timestamp field**, regardless of how the underlying Parquet tables store time. This is a backend requirement that this spec depends on.

Today the parsed Parquet tables use two different time encodings (verified 2026-05-20 against `hoga/tables/trades.py` and `hoga/tables/candles.py`):

| Source table | `ts_ms` encoding | Example for 15:30:00 |
|---|---|---|
| `trades.parquet` (`Trade.ts_ms`) | HHMMSSmmm decimal-packed | `153000000` |
| `snapshots.parquet` (`Orderbook.ts_ms`) | HHMMSSmmm decimal-packed | `153000000` |
| `brokers.parquet` (`BrokerRow.ts_ms`) | HHMMSSmmm decimal-packed | `153000000` |
| `candles.parquet` (`Candle.ts_ms`) | ms-from-midnight | `55800000` |
| `info.tsv` session_open / session_close | HHMMSSmmm decimal-packed | `153000000` |

Mixing these encodings in the frontend would silently produce wrong cursors and misaligned virtual axes. **The frontend treats every `ts_ms` field from the API as Unix ms** and uses a single time axis throughout (chart, cursor parameter, virtual stitching, URL).

The backend converts at the API boundary, not at the Parquet write boundary — Parquet tables stay untouched; only `ApiTrade`, `ApiCandle`, `ApiOrderbookSnapshot`, `ApiBrokerEntry`, and `Meta.regular_session_open_ms` / `close_ms` change to ship Unix ms. Cursor `t` query params (`/api/orderbook?t=`, etc.) accept Unix ms too. The (date YYYYMMDD + intra-day offset) → Unix ms conversion is one helper in `hoga/api/`.

This is a backend change the frontend depends on, captured as **ADR 0003** (`docs/adr/0003-api-time-encoding.md`).

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

Backend runs the 5 DuckDB queries in parallel internally and returns one cohesive response (~4–6 MB JSON uncompressed, ~1–2 MB gzipped on the wire). Either all five succeed or the request fails — partial bundles aren't useful.

**`candles`** — 1-minute OHLCV bars from `candles.parquet`, ts converted to Unix ms per §4 time encoding. Each: `{t, o, c, h, l, vol}`. ~420 rows/day across 09:00–16:00.

Candles cover the entire trading-active window including the single-price phases:
- **Continuous Trading 09:00–15:20**: normal OHLC with real intra-minute price variation. ~320 rows.
- **Closing Auction Window 15:20–15:30**: hogaplay produces a candle per minute even though no continuous trades happen. Empirical pattern (confirmed against the captured pre-market 08:30 candle in `tests/fixtures/tiny_tsv/chart.tsv`): OHLC are all equal to the converging expected match price; `vol_a` reflects accumulated/expected matched quantity for that minute. 10 rows.
- **Closing Auction Cross 15:30:00**: one candle whose `vol_a` includes the auction cross volume; OHLC sit at the cross price.
- **After-Hours Trading 15:30–16:00**: 30 candles. OHLC all equal to the closing price (after-hours matching is single-price at the close); `vol_a` reflects each minute's executed after-hours volume.

The Price/Volume/Profile pane therefore shows a normal candle pattern through 15:20, a flat (single-price) segment for the closing Auction Window with non-zero volume bars, a single tall volume bar at 15:30 (auction cross), then a continued flat line through 16:00 with variable volume. This is the data's true shape, not a rendering artifact.

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

A 1.2× sell-heavy state plots at `+0.2`; 1.2× buy-heavy at `−0.2`; balance at `0`. The line crosses `0` continuously when imbalance flips.

**Y-axis auto-fits the actual data range — no clipping.** If imbalance spikes to ±4 (5× ratio), the axis expands to show it. The whole line is always visible regardless of magnitude. Tick labels formatted back to the ratio (`1.2× S`, `1.5× S`, `2× S`, `0`, `1.2× B`, `1.5× B`, `2× B`, etc., with `S` = SELL, `B` = BUY). At y = 0, a thin teal dashed baseline marks balance and visually separates the sell-heavy region (above) from the buy-heavy region (below).

**`depth_intensity`** — two parallel 2-D heatmap grids (one for bid quantities, one for ask) sharing the same time + price axes. The pane renders bid cells in one hue (typically the buy/up color) below the natural mid-price cluster and ask cells in another hue (sell/down color) above. The two grids never overlap in practice (orderbook invariant: `bid_max < ask_min` outside the Auction Window cross moment).

```json
"depth_intensity": {
  "bucket_ms": 5000,
  "price_min": 67500, "price_max": 71200, "price_step": 100,
  "times":    [1747526400000, 1747526405000, ...],
  "bid_grid": [[0, 0, 12000, 8500, ...], ...],   // shape: len(times) × price_bins
  "ask_grid": [[0, 0, 14000, 9100, ...], ...]    // shape: len(times) × price_bins
}
```

**Price binning = KRX tick size (호가단위), exactly.** Every bin represents one tradable price point. No aliasing, no information loss. `price_step` is determined by KRX's price-tier table applied to the request's effective `price_max`:

| Price range (KRW) | Tick size (`price_step`) |
|---|---|
| `< 2,000` | 1 |
| `2,000 – 5,000` | 5 |
| `5,000 – 20,000` | 10 |
| `20,000 – 50,000` | 50 |
| `50,000 – 200,000` | 100 |
| `200,000 – 500,000` | 500 |
| `≥ 500,000` | 1,000 |

`price_bins = (price_max − price_min) / price_step + 1`. Examples: 삼성전자 ~70,000 with day range 67,500–71,200 → tick 100 → 38 bins. SK하이닉스 ~150,000 with day range 145,000–155,000 → tick 100 → 101 bins.

**Tier-crossing edge case:** if the price crosses a tier boundary intra-day (e.g., 49,900 → 50,100 changes tick 50 → 100), the server picks the tick at `price_max` (the larger tick) and rebins lower-price snapshots onto that grid. Snapshots at finer-tick prices get assigned to the nearest coarser bin — minor accuracy loss only for the tier-crossing portion of the day. Rare in practice (most stocks stay in one tier for one day).

**Multi-day unified price grid.** When the user selects N Stock-Dates, the four chart panes must align on a single y-axis so the analyst can compare price levels across days. The client computes the **union price range** across all selected dates using `price_min` / `price_max` fields already present in each `/api/stock-dates` inventory entry (so no extra round trip), then includes that range as query params when fetching each per-date session bundle:

```
GET /api/session?code=005930&date=20260518&price_min=67500&price_max=72500
GET /api/session?code=005930&date=20260519&price_min=67500&price_max=72500
GET /api/session?code=005930&date=20260520&price_min=67500&price_max=72500
```

Backend bins all three days onto the same tick-aligned grid (e.g., 67,500–72,500 / tick 100 → 51 bins). Each day's `depth_intensity` arrives with identical `times` length (per day's 09:00–16:00) but **identical** `price_min`/`price_max`/`price_step` and shared bin indices. The client stacks them along the compressed virtual time axis with perfect vertical alignment.

For single-Stock-Date loads, query params are omitted and the backend uses that day's natural range — backward compatible with the simple case.

This requires `/api/stock-dates` to include `price_min` / `price_max` per entry (small additions to existing inventory model, ~16 bytes per entry). Captured as backend dependency in §11 follow-ups if missing.

Per cell semantics: for each (time bucket, price bin), `bid_grid[t][p]` is the **max bid quantity** observed at that price across all 10 bid levels during the bucket; `ask_grid[t][p]` is the corresponding **max ask quantity** across all 10 ask levels.

Source: `snapshots.parquet`. DuckDB unpivots the 20 level columns, splits by side, bins by tick-aligned price.

**Default time resolution: 5 s buckets.** Trading day 09:00–16:00 has 25,200 s → 5,040 time columns per day. For 삼성전자 (38 bins): 5,040 × 38 × 2 grids = ~383k cells = ~3 MB JSON. For wider-range stocks (~100 bins): ~5 MB. Configurable via `?depth_bucket_ms=` query param (e.g., 1000 for 1 s precision when the analyst wants it; backend caps total cells per grid at 2M to prevent runaway responses, widens bucket if exceeded).

**Auction Window note:** during 15:20–15:30 the orderbook briefly allows `bid_price >= ask_price` (overlapping orders awaiting the single-price cross). In this window both grids may have nonzero values at the same (time, price) cell. The client renders both cells stacked (additive alpha) — the visual overlap is the analyst's signal that the auction is converging.

**`volume_profile`** — price-binned histogram of executed volume.

```json
"volume_profile": {
  "bin_count": 24,
  "price_min": 67500, "price_max": 71200, "bin_width": 154,
  "bins": [{"price_low": 67500, "qty": 12340}, ...]
}
```

Standard volume-profile representation: the day's `[price_min, price_max]` range is divided into **N equal-width bins** (default `N = 24`, TradingView-like). Each bin's `qty` is the total executed volume at any price falling into that bin's range. Bins are **not** tick-aligned — they are a rough overview of "where did volume happen" across the day, intentionally coarser than `depth_intensity` (which IS tick-aligned and answers a different question: precise per-tick book depth at each moment).

Configurable via `?vp_bins=N` query param (range 10–100). Bigger N = finer resolution, more horizontal-bar rows but more visual noise.

`qty` is **total executed volume** at each price bin — includes both continuous-trading (`side = ±1`) and auction-cross (`side = 0`) rows. The volume profile answers "where did trades happen", and KRX opening/closing auctions are a meaningful slice of that signal (often 5–15% of daily volume for large caps). The `CONTEXT.md` Auction Cross exclusion rule applies to aggressor-based metrics (CVD), not plain volume aggregation. No buy/sell split.

**Rendering — horizontal bar overlay across the candle pane:**

The matprofile is drawn as a horizontal-bar histogram **overlaid on the candle pane**, not as a strip on the right edge. For each price bin (y-axis horizontal slice), one teal bar extends from the **left edge of the day's segment toward the right**, with length proportional to that price bin's volume.

**Z-order and opacity** (candles must stay readable over the overlay):
- Matprofile bars layer: **20% opacity teal**.
- POC (Point of Control — price bin with max volume) bar: **50% opacity teal** — emphasized but still translucent.
- Candles draw **on top** of the matprofile (z-order: candles > matprofile). The matprofile lives as background tint.
- VAH (Value Area High) line: solid 1 px teal with a small `VAH 70,500` label at the right edge of the day segment.

The Value Area is the cumulative top-volume bins covering 70% of day volume, scanned outward from POC. v1 ships only the VAH line; the lower bound (VAL) is deferred.

**Toggle in the pane header.** A small `매물대` toggle (default **on**) lives in the Price/Volume/Profile pane header. Off hides all matprofile bars, POC emphasis, and the VAH line — so the analyst can read raw candles without the overlay. Toggle state is per-tab, in-session only (resets to on after page reload). URL encoding of pane toggles is deferred to v1+1.

**Multi-day rendering** (when the user selects N Stock-Dates):
- **Default = per-day**, one matprofile inside each day's segment. The bars for day D start at the left edge of D's segment on the compressed virtual time axis and extend rightward up to (their proportion × the segment's width). Each day has its own POC bar and VAH line. Days are visually comparable across the chart.
- **Toggle = single combined.** A small toggle in the Price/Volume/Profile pane header switches to one combined matprofile that spans the **full chart width** (all days). Bars start at the very left edge of the chart and extend rightward proportionally. Client rebins the N per-day grids onto the unified price grid (per the §4.1 multi-day unified price grid rule), sums, then renders. One combined POC bar and one combined VAH line.
- In both modes, direction is the same: **qty 0 at the left, max qty at the right**, bars are horizontal, stacked vertically along the y-axis (one bar per price bin).
- Backend ships per-Stock-Date `volume_profile` always; the toggle is a client-side rendering choice with no extra fetch.

**`fill_strength`** — per-minute aggregated buy vs sell volume for the chart pane.

```json
"fill_strength": {
  "bucket_ms": 60000,
  "points": [{"t": 1747526400000, "buy_qty": 1500, "sell_qty": 2200}, ...]
}
```

Source: `trades.parquet` summed per minute. `side = +1` → `buy_qty`, `side = -1` → `sell_qty`, `side = 0` → excluded (per the `CONTEXT.md` Auction Cross rule — this IS an aggressor-based metric).

**Pane rendering:**
- Vertical bars centered on `y = 0`. Each minute draws a **buy bar pointing up** (height = `buy_qty`, color `--up`) and a **sell bar pointing down** (height = `sell_qty`, color `--down`). The "매수 우세 = 위" convention matches the quote_ratio pane for consistency across the chart stage.
- Y-axis is **absolute volume** (shares), auto-fitted to the actual data range with K/M auto-format on the tick labels (e.g., `2.4M`, `300K`). Not a percentage — analysts want to read magnitude directly.
- Bar width ~70% of a minute slot. One bar pair per minute.
- **Empty minutes:** the closing Auction Window 15:20–15:30 has no `side ≠ 0` trades → no bars (natural visible gap). The 15:30:00 auction cross is `side = 0` and is excluded → still no bar. After-Hours Trading 15:30:00–16:00:00 has continuous-trading rows again → bars resume, typically smaller volumes than the open day.

**Bundle size summary:**

| Stage | Size per Stock-Date |
|---|---|
| Uncompressed JSON (server-side, in-memory build) | **~4–6 MB** (varies with daily price range) |
| gzip on the wire (FastAPI `GZipMiddleware` enabled) | ~1–2 MB |
| Parsed JS objects (browser memory) | ~8–14 MB |

**Independent of stock activity.** Every slice is pre-aggregated (per-second buckets for quote_ratio, per-minute candles, fixed bin counts, tick-aligned depth grids), so a wildly active stock (e.g. 삼성전자, ~2M trades/day) and a quiet small-cap (~2,000 trades/day) produce responses of essentially the same byte size given the same daily price range.

**Mild variation with daily price range.** Because `depth_intensity` now uses tick-aligned price bins (§4.1), a stock that traded across a wider price range that day has more bins → slightly larger grid. Concrete examples: 삼성전자 with ~38 ticks/day ≈ 4.5 MB total bundle; SK하이닉스 with ~100 ticks/day ≈ 6 MB. Stays well within the design budget either way.

What **does** vary with activity is **backend compute time**:
- Active stock: ~500 ms – 1 s per Stock-Date (DuckDB scans more rows)
- Quiet stock: ~50 – 200 ms per Stock-Date

Captured in §10 Risks. Memory math at 5 tabs × 3 days: 5 × 3 × ~12 MB (parsed in browser) = ~180 MB — well within desktop budget.

Raw trades are deliberately **not** in the bundle. Including them would make response size scale with activity (삼성전자 ≈ 160 MB / day). Cursor-following spot fetches (§4.2) handle the trades-around-cursor use case at ~1 KB per request.

### 4.2 Spot endpoints (existing, unchanged)

Used by the three cursor-following sidebar cards. All return small responses; client wraps them in an LRU cache bounded to ~100 entries per tab.

| Endpoint | Returns | Used by | Approx response size |
|---|---|---|---|
| `GET /api/orderbook?code&date&t` | 10-level snapshot at-or-before `t` | 10호가 sidebar card | ~500 B |
| `GET /api/brokers?code&date&t` | Top-5 buy + top-5 sell broker state at `t` | 거래원 sidebar card | ~200 B |
| `GET /api/trades?code&date&from&to&limit` | Trades within `[from, to]` | 체결 sidebar tape (`from=t-5000ms, to=t, limit=20`) | ~1 KB |

All three already exist per the backend spec (`docs/superpowers/specs/2026-05-19-hoga-ops-design.md`). v1 frontend uses them as-is; no signature changes.

### 4.3 `GET /api/events` — Server-Sent Events channel (new)

Long-lived HTTP connection. Backend pushes notifications when the data directory changes (a new capture lands, an existing one is removed) so the frontend can refresh its inventory in near-real-time without polling.

```
Connection: keep-alive
Content-Type: text/event-stream

event: inventory_added
data: {"code":"207940","date":"20260521","name":"삼성바이오로직스","captured_at":1747825200000}

event: inventory_removed
data: {"code":"005930","date":"20260518"}
```

**v1 event types:**
- `inventory_added` — a new Stock-Date directory appeared. Payload: `{code, date, name, captured_at}` (`captured_at` is Unix ms when the directory was created).
- `inventory_removed` — a Stock-Date directory disappeared (user deleted it). Payload: `{code, date}`.
- `heartbeat` — every 30 s, empty payload, so the frontend can detect a stale connection.

**Backend implementation (out of frontend spec scope, but required dependencies):**
- `sse-starlette` for `EventSourceResponse` on FastAPI.
- `watchdog` to observe the `data/parquet/` directory tree and emit `inventory_added` / `inventory_removed` events.
- The watcher runs in the FastAPI `lifespan` context and feeds an asyncio queue that the SSE endpoint drains.

**Frontend wiring:**
- `api/sse.ts` exposes a single `useEventStream()` hook. It opens one `EventSource` to `/api/events` for the lifetime of the app (not per tab).
- On `inventory_added` / `inventory_removed`, the hook calls `queryClient.invalidateQueries(['stock-dates'])` — every place that uses the inventory (combobox dropdown, date picker disabled-day set, nav badge, future Inventory page) refetches automatically.
- The browser's `EventSource` auto-reconnects on transient network failures. If `heartbeat` misses for >60 s, the hook closes and reopens the connection.
- v1 does not push UI for incoming events (no toast). The list just silently updates. If the user wants to see what just changed, the future Inventory page will show a "recently added" affordance.

### 4.4 Stock-date search

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
  - Status dot is driven entirely by the SSE connection (no separate health-check endpoint — SSE liveness implies API liveness, same server):
    - 🟢 `--up` — SSE connected and last `heartbeat` event received within the last 60 s.
    - 🟡 `--accent` (pulsing) — SSE disconnected or no `heartbeat` for >60 s; browser is auto-reconnecting.
    - 🔴 `--down` — SSE error event received OR auto-reconnect failed AND the most recent regular API call returned 5xx. Indicates the backend is likely down.
  - Hover tooltip: `SSE 연결 활성 · 마지막 갱신 HH:MM:SS` (green), `재연결 중...` (yellow), or `백엔드 응답 없음` (red).
- v1: only Replay Viewer renders real content. Other nav items render a placeholder page with the section title and a "coming soon" stub.

**Tab strip (Replay Viewer page only, 40 px tall):**
- Each tab is an **independent analysis session** holding its own `{code, dateRange, cursorMs, cachedData}`.
- Tab content: status dot (loaded / loading / empty), code (mono, teal), name, date-range hint.
- Active tab has a 2 px teal top accent and background matching the toolbar; inactive tabs are dimmer.
- `[+ 새 분석]` button creates a new empty tab. Soft cap of 8 simultaneous tabs (shown as `N / 8 open`) to bound memory; the 9th opens a confirmation modal warning that the oldest tab will be evicted.
- Tabs are reorderable via drag (powered by `@dnd-kit/sortable` — smooth drop indicators, ESC-to-cancel, sensible touch/keyboard fallbacks even though v1 is desktop-only) and closeable via the X button shown on hover.
- **The last remaining tab has its close X disabled** (hidden on hover, no click affordance). The app never reaches a zero-tab state and never re-creates a tab the user just tried to close. If the user wants to clear everything, they leave one empty tab — explicitly the intended "blank slate".

**Toolbar (60 px, per-tab):**
- 종목 combobox: searchable dropdown sourced from `/api/stock-dates` inventory, shows code + name + captured-dates count.
  - **Search matches both 종목명 (name) and 종목코드 (code).** Code uses prefix matching (`005` → 005380, 005930). Name uses substring matching (`삼성` → 삼성전자, 삼성바이오로직스, 삼성SDI).
  - Empty search shows the full inventory.
  - **Default sort: captured-dates count descending** (most-analyzed stocks rise to the top). When search is active, results are ranked by match strength (code-prefix matches first, then name-substring matches); ties break on code ascending.
  - **Keyboard:** ↑ / ↓ navigate, Enter selects, ESC closes — standard combobox conventions.
  - Click anywhere on the field opens the dropdown with the full list visible; the search input is purely a filter.
  - **Hangul initials search** (e.g. `ㅅㅅㅈㅈ` → 삼성전자) is a v1+1 follow-up — useful but needs a small lookup helper.
- 기간: from/to date fields, each opens a `react-day-picker` calendar popover. Days not in the captured inventory for the selected code are disabled (greyed, unclickable). Disabled-day set comes from `/api/stock-dates` filtered to the active code. For single-day analysis, the user sets `from = to`.
- **Changing the stock clears the date range.** When the user picks a different code in the combobox, `from`/`to` reset to empty and the user re-selects dates against the new code's inventory. Avoids the "I selected 5/20 which exists for 005930 but not for 000660" silent-mismatch problem, and forces the user to consciously re-scope after switching symbols.
- `데이터 불러오기` primary button: triggers the bundle prefetch for the current tab.
  - **Disabled until code + `from` + `to` are all filled.** While disabled the button renders in `--fg-dimmer` color with no hover effect; the tab is still on its onboarding card (per §6.2 state table) and the highlighted step explains what's missing. Hovering the disabled button shows the same hint as a tooltip (e.g. `기간을 선택하세요`).
  - Active state: primary teal background, full opacity. Click fires N parallel `/api/session` calls and the workarea transitions from onboarding card → loading card → loaded chart per §6.2.
  - When the tab is already in `loaded` state and the user changes any toolbar input, the button switches to "Reload" labeling to make it explicit a re-fetch will replace cached data; clicking it discards `tab.bundles` and `tab.spotLRU`, then fetches fresh.

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
- Left: **5 panes stacked vertically** with `grid-template-rows: 1.4fr 0.3fr 0.4fr 0.8fr 0.4fr` (~42% / 9% / 12% / 24% / 12% of left area height):
  1. **Price + Matprofile overlay** — candles with the horizontal-bar 매물대 (volume profile) overlay drawn behind them. POC + VAH line live here.
  2. **Volume** — per-minute total volume as a vertical bar, colored to match that minute's candle direction (green if close ≥ open, rose otherwise). Right y-axis with K/M auto-formatting. Standard TradingView-style volume row.
  3. **Bid / Ask Ratio** — signed imbalance line, 0-centered.
  4. **Depth Intensity** — bid + ask heatmap on a single y-axis.
  5. **Fill Strength** — per-minute buy/sell bars, 0-centered.
- Right: 3 cards stacked with `grid-template-rows: 2fr 1fr 1fr` (50% / 25% / 25%) — Orderbook 10호가, Broker Net Flow, Recent Fills.

Volume bars and fill_strength are intentionally not the same signal. Volume bars show **total magnitude per minute, color-keyed to price direction** — the "was that minute up or down, and how heavy". Fill_strength shows **buy vs sell aggressor volume per minute** — the "who was the aggressor". They commonly tell different stories (e.g. green candle + sell-heavy fill_strength means aggressive sellers crossed bids but limit buyers absorbed it).

The 2:1:1 ratio gives Orderbook the breathing room it needs (21 rows = 10 ask + spread + 10 bid). Inside Orderbook, the 21 rows fit when row height is ~14 px in mono 11.5 px — tight but readable. Broker Net Flow and Recent Fills each get ~150 px of vertical space and scroll internally when their content (up to 10 broker rows / 20 fill rows) exceeds the visible area. Every card has `overflow-y: auto` on its body.

**Orderbook (10호가) card:**
- Source: `/api/orderbook?code&date&t` returns the 20-level snapshot — **10 ask levels + 10 bid levels** — per KRX 10호가 (the term "10호가" refers to 10 levels *each side*, not 10 total).
- Layout: 10 ask rows in rose at the top (rank 10 ask price at the very top, rank 1 ask closest to the spread), one `SPREAD · MID <price>` separator row in the middle, then 10 bid rows in green below (rank 1 bid closest to the spread, rank 10 at the very bottom). Spread line vertically centered, fixed position.
- Each row: rank index, price (mono, signed color), qty (mono, right-aligned).
- **Depth bar normalization:** every row has a horizontal gradient bar (rose for asks, green for bids) whose width is normalized **across all 20 levels** — the largest single-level qty among the 20 = 100% width. Smaller levels scale proportionally. So the visual immediately shows where the deepest level of the entire book is, regardless of which side it's on.
- Empty levels (qty = 0 at some rank) show a blank cell, never collapse — keeps the 20-row structure stable.
- Click on a price row: v1 no interaction (display only).

**Recent Fills (체결 데이터) card:**
- Source: `/api/trades?code&date&from=t-5000&to=t&limit=20` returns up to 20 trades from the last 5 seconds before the cursor.
- **Table only, no chart.** Each row: time, price, qty, side icon.
  - Time: `HH:MM:SS` (no milliseconds; millisecond precision shown only in a hover tooltip).
  - Price: green if `side = +1` (buy aggressor), rose if `side = −1` (sell aggressor). 자릿수 콤마 구분.
  - Qty: white, right-aligned, comma-separated.
  - Side icon: ▲ for buy, ▼ for sell — color also encodes (double signal so colorblind users still see direction).
- **Sort:** newest at top. Users always want the most recent row visible without scrolling.
- **Auction Cross rows** (`side = 0`, 15:30:00.000) display in neutral color with the symbol `◆` to mark "auction" instead of `▲/▼`. They never sort above a real trade with the same wall-clock second because the auction cross happens at the boundary.
- **Empty state:** if the 5-second window contains no trades (e.g., cursor sits inside the 15:20–15:30 Auction Window where no continuous trades happen), the card body shows a dim `체결 없음` message, no error.
- No grouping or aggregation — analyst wants the raw stream.

**Broker Net Flow card:**
- Source: `/api/brokers?code&date&t` returns the top 5 buy-side brokers + top 5 sell-side brokers at cursor `t` — up to 10 rows total.
- Each row's `net` is signed: buy-side entries plot as `+qty_today` (positive, green), sell-side entries as `−qty_today` (negative, rose).
- **Sort:** all 10 rows by signed `net` descending — biggest net buyer at top, biggest net seller at bottom. A broker that appears in both lists shows as two separate rows.
- **No visual bar.** Numbers only: 4-char-truncated broker name + signed qty with thousands separators (e.g., `키움증권 +432,100`, `NH투자증 −312,800`).
- Broker names longer than 4 characters are truncated to 4 with an ellipsis only when truncation isn't itself ambiguous (`삼성증권` → `삼성증권`, `한국투자증권` → `한국투자`, `NH투자증권` → `NH투자`). The 4-char rule comes from KRX brokerage naming where the first 4 characters are essentially always unique among large brokers.

**Pane header controls:** the Price/Volume/Profile pane header carries a small toggle for the matprofile rendering mode — default "per-day" (one horizontal-bar overlay within each Stock-Date's segment) and alternate "combined" (one overlay spanning all selected dates). See §4.1 `volume_profile` for the underlying data, the horizontal-bar overlay direction (qty 0 at left → max qty at right), POC emphasis, and the VAH line.

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
      client.ts              # fetch wrapper, base URL from /config.json
      session.ts             # react-query hook for the /api/session bundle
      useSpot.ts             # ~30 LoC: 30 ms debounce + LRU(100) for cursor fetches
      sse.ts                 # EventSource hook for /api/events, app-wide singleton
      stock-dates.ts         # react-query hook for /api/stock-dates inventory
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
      VolumePane.tsx         # per-minute volume bars (separate pane)
      RatioPane.tsx
      IntensityPane.tsx      # custom canvas layer
      VolumeProfileOverlay.tsx  # matprofile overlay on CandlePane
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
- **No cross-tab cursor sync.** Each tab's `cursorMs` is fully independent — moving the mouse in Tab A does not move the cursor in Tab B, even if both tabs hold the same code or the same Stock-Date. Multi-tab is an independent-session pattern; sync would couple tabs that the user explicitly opened to be parallel.

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

### 6.3 Chart zoom, pan, and interaction

Bounded interaction so the chart can't be zoomed/panned into useless states.

**Zoom limits** (configured on `lightweight-charts` time scale):
- **Maximum zoom-in (smallest visible window):** ~5 candles visible. Below this density the OHLC marks blur into a noisy line — no analytical value.
- **Maximum zoom-out (largest visible window):** the full selected date range plus a **10% padding on each side**. The padding gives the chart breathing room at the edges and matches TradingView convention.

**Pan limits:**
- Soft: the user can pan beyond the data into the 10% padding region but not further. lightweight-charts' `rightBarStaysOnScroll: true` + `lockVisibleTimeRangeOnResize: false` keeps drag within bounds.
- The viewport always shows at least 1 actual candle — the app refuses to scroll the entire dataset off-screen.

**Mouse / keyboard:**
- Mouse wheel: zoom (TradingView convention).
- Click and drag: pan.
- Double-click: reset to full-range view (zoom-out to max).
- Box-zoom and keyboard shortcuts (arrow keys, +/−) are not in v1 — added if needed.

**Viewport tracking interactions** (per §5.1 price strip):
- "Current price" = close of the candle at the viewport's **right visible edge**. If the user pans into the right-padding region (no real candle there), the value stays at the rightmost real candle's close — it does not blank out.
- "Delta chip" = same definition relative to the viewport's left edge. Same fallback to last real candle when the left edge is in padding.

### 6.4 Compressed multi-day time axis

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

### 6.5 Data flow

```
Active tab's Toolbar (code + dateRange + Load)
    │
    ▼
store.setSelection(tabId, sel)
    │
    ▼
For each Stock-Date in dateRange (parallel):
    GET /api/session?code&date  ──► one bundle per Stock-Date (~4–6 MB JSON, ~1–2 MB gzipped on wire)
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

- **Bundle prefetch on Load (progressive render):** when the user clicks Load with N Stock-Dates selected, the app fires N `/api/session` calls in parallel and renders **each day's segment as soon as its bundle arrives** — not after all are done. Day 1 may appear at t+500 ms; Day 5 may appear at t+1.2 s. The chart looks like it's filling left-to-right (or in actual response order). Each segment uses `tab.bundles[date]` independently the moment it's populated. The virtual axis preallocates N slots based on `selection`, so partial state has explicit empty slots (not collapsed). Per §6.6: 404 results drop silently from the virtual axis; 5xx results render a red retry segment. Backend computes the 5 bundle slices via concurrent DuckDB queries; total time per Stock-Date on localhost ~300–800 ms.
- **Bundle lookup is synchronous:** every chart pane reads from `tab.bundles[date]` directly. No React Suspense, no react-query for bundles. Once Load finishes, scrolling and zooming don't fetch anything.
- **Spot fetches on cursor move:** three small GETs at 30 ms debounce. Each ~500 B – 1 KB. Total per cursor move = ~2 KB on the wire.
- **All 5 chart panes share the same cursor.** lightweight-charts handles multi-pane crosshair sync natively — wherever the mouse hovers (candle, volume, ratio, intensity, fill_strength), the cursor `t` is the same for all panes and for the sidebar.
- **Initial cursor on Load:** the cursor defaults to the **right edge of the loaded data** (latest available timestamp). The sidebar cards therefore have data the moment the workarea renders — no blank state immediately after Load.
- **Stale-during-fetch behavior:** while a spot fetch is in-flight after a cursor move, the sidebar cards keep showing the previous successful values (stable, slightly stale) rather than blanking. A small pulsing teal dot in each card header marks "fetching"; it disappears when the new response lands. If the LRU cache already has the new key, the swap is instant with no dot. Data stability beats visual flicker.
- **Spot LRU cache:** per tab, capped at 100 entries each. Recently visited cursor positions stay hot; far-away keys evict. Cache shape: `Map<keyHash, response>` with LRU eviction. Memory bound: ~200 KB/tab worst case.
- **Tab switching:** instant. Bundles for inactive tabs stay in memory; spot LRU stays per tab. Switching back is `tab.bundles[date]` lookup + `tab.cursorMs` re-broadcast.
- **Cursor persists when mouse leaves the chart.** `cursorMs` holds its last value while the mouse is over the sidebar or anywhere off the chart; sidebar cards keep their data. Re-entering the chart at a new position updates the cursor normally. No explicit pin/lock action — the persistence is automatic.
- **No react-query for cursor data.** The 30 ms debounce + spot LRU is implemented as a small hook (`useSpot<T>(key, fetcher)`) — ~30 LoC. react-query is reserved for the bundle fetch where its retry/dedupe shine.

### 6.6 Error handling

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
| Inventory refresh when a new capture lands during a session? | **SSE auto-push** via `GET /api/events` | Real-time; the user can run the collector in a separate terminal and the combobox updates without a manual refresh. SSE is one-direction, browser-native, and simpler than WebSocket for this use case. |
| Multi-day bundle fetch: wait or progressive? | **Parallel fetch, progressive render** | Each day appears as soon as its bundle arrives. First data visible in ~500 ms; full chart in ~1 s. |
| Time encoding across the API? | **Unix epoch ms (UTC) everywhere** | Captured in ADR 0003. Parquet stores native hogaplay encodings; the `Api*` boundary converts. |
| Cursor sync between tabs? | **No** — fully independent per tab | Multi-tab is an independent-session pattern by design. Sync would silently couple tabs the user opened to be parallel. |
| Multi-day depth_intensity / matprofile alignment? | **Backend unifies on a single tick-aligned price grid via `price_min` / `price_max` query params** | Same y-axis across all selected dates so heatmap cells align cleanly across day boundaries. Requires `/api/stock-dates` to ship per-Stock-Date price range. |

## 10. Risks and mitigations

- **Bundle compute time.** All 5 DuckDB queries run in parallel; total backend time is dominated by `depth_intensity` (unpivot + split by side + bin, two grids). Spike this first — target <1 s per Stock-Date on a representative captured day. If slower, add server-side caching (`depth_intensity` for the same `(code, date)` is deterministic).
- **lightweight-charts custom pane limits.** v5 supports multiple panes natively for candles/line/histogram, but the three custom visualizations (호가잔량 intensity heatmap, 매물대 horizontal histogram overlay, 체결 강도 stacked buy/sell bars) require hand-drawn `<canvas>` layers wired to the chart's `timeScale` and `priceScale`. Three risks: (a) keeping the overlay's pixel coordinates in sync with the chart on zoom/pan via `subscribeVisibleTimeRangeChange` and `subscribeCrosshairMove`; (b) rendering performance for the heatmap (~200k cells per Stock-Date, must repaint on every zoom change); (c) Z-order stacking against the chart's internal layers.

   **Mandatory pre-implementation spike (1–2 days).** Before the writing-plans phase starts, build a throwaway prototype with one Stock-Date of real captured data showing: candles + volume in lightweight-charts native, the intensity heatmap as a Canvas overlay, and one cursor crosshair crossing both. Confirm zoom/pan stays in sync, repaint stays under 16 ms (60 fps) at the cap'd cell count, and overlay z-order works. If the spike fails or hits a wall on overlay sync, the fallback library is **KLineCharts** (built-in custom series — heatmap, volume profile, fill strength all expressible as `IndicatorSeries`) at the cost of a less TradingView-shaped feel; second fallback is ECharts with bigger bundle / different visual.
- **Tab isolation duplicate fetches.** Opening two tabs on the same Stock-Date fetches the same bundle twice. Acceptable for v1 (local API, fast); fix with a shared bundle cache keyed by `(code, date)` if it becomes annoying.
- **Date range size.** No hard cap, no warning, no modal in v1 — the analyst is in control. 10 days × ~12 MB (parsed) = ~120 MB per tab is fine on desktop; chart rendering past ~10 days starts to feel sluggish; 30+ days will be slow. Documented here, not enforced in the UI. If sluggishness becomes a real complaint, add a soft warning chip in v1+1.
- **Bundle compute time for top-tier stocks** (삼성전자, SK하이닉스). Bundle byte size is ~4–6 MB uncompressed (~1–2 MB gzipped), independent of activity — every slice is pre-aggregated, so the response shape doesn't depend on raw trade count. The cost shifts entirely to backend compute time: active stocks scan more raw rows (~500 ms – 1 s) than quiet stocks (~50 – 200 ms). If active-stock compute time exceeds the <1 s target, cache the deterministic `depth_intensity` per `(code, date)` server-side first.

## 11. Out of scope, captured for follow-ups

- Data Window toggle (show pre-market and closing auction).
- Export current view as PNG.
- Shared bundle cache across tabs (deduplicate fetches when two tabs hold the same Stock-Date — currently each tab fetches its own bundle).
- Keyboard shortcuts for tab navigation (Ctrl+Tab / Ctrl+Shift+Tab). v1 is mouse-only; keyboard shortcuts are a follow-up.
- Persist open tabs across reloads in localStorage (v1 uses URL only).
- Broker history time-series (already-aggregated server-side is a separate ticket).
- Real implementations of Inventory / Capture / Search / Notes pages.
- `GET /api/config` (or `/api/system`) — backend endpoint exposing global state (data dir path, captured Stock-Date count, disk usage). Needed for a real Settings page; deferred to v1+1.
- Hangul initials (초성) search in the stock combobox (e.g. `ㅅㅅㅈㅈ` → 삼성전자) — deferred to v1+1.
- URL encoding of per-pane toggles (e.g. matprofile on/off, future indicator visibility) — deferred to v1+1.
