# hoga-ops

Single-user local tool that captures Korean stock orderbook + trade replay data from `hogaplay.com` and exposes it for analysis.

## Language

**Regular Session**:
The continuous-trading window of the KRX day, 09:00:00–15:30:00 (includes the closing single-price auction 15:20–15:30).
_Avoid_: "session" alone, "market hours"

**Data Window**:
The full span of data hogaplay returns for a stock-date, broader than the Regular Session. Includes pre-market single-price activity from ~08:40 and any closing-auction residuals. Outer bounds are the earliest and latest event timestamps in the captured TSV.
_Avoid_: "session" alone, "trading day"

**Code**:
A 6-digit KRX ticker, e.g. `005930`. Strings, not integers — leading zeros matter.
_Avoid_: "symbol", "ticker"

**Stock-Date**:
The unit of capture and storage: one (Code, YYYYMMDD) pair. All paths and queries are scoped to a Stock-Date.

**Page**:
One `first.php` HTTP response. Bounded in size (~500–1000 events). Multiple Pages cover one Stock-Date's Data Window.
_Avoid_: "chunk", "batch", "section" (overloaded — see TSV Section below)

**Full Capture**:
The union of all Pages for one Stock-Date, deduplicated. The artifact the collector must produce before the parser runs.

**TSV Section**:
The first field of every row in a Page's TSV (`1` = events that occurred before the requested `time`, `2` = events from the requested `time` onward). A presentation marker dependent on the call's `time` parameter — *not* an intrinsic property of an event. The same event can appear as TSV Section 1 in one Page and TSV Section 2 in another with all other fields identical (verified 2026-05-19). Dropped during parsing.
_Avoid_: "section" alone (ambiguous with Regular Session, Page)

**Global Sequence (global_seq)**:
Field 4 of every event row. Strictly increasing per-Stock-Date counter across all event types. The dedup key when merging Pages into a Full Capture: verified unique-within-Page and stable-across-Pages.

**Page Step**:
The increment applied to the `time` query parameter between successive collector calls. Variable, not fixed. Default 60000ms (1 minute) matching hogaplay's UI step; collector halves the step (30s, 15s, ...) when a response fails to cover the requested window — indicating the response cap was hit before reaching `time + step`. A stagnation guard (ADR-0017) terminates the loop if `max_event_time` and `new_seqs` both fail to advance for `MAX_STAGNANT_PAGES` (200) consecutive iterations — protecting against hogaplay response freezes that would otherwise loop forever in the cap-hit branch.

**Auction Cross**:
A trade matched via a call auction (단일가 매매), not continuous trading. Occurs at the open (~09:00:00.000), the close (~15:30:00.000), and pre-market single-price periods. Recognizable in the trade schema by **absence of `+`/`-` sign** on the qty field (event type 1) OR by being an event type 3 row (single-price summary, used for both opening and closing auctions — confirmed in production 2026-05-20). Stored as `side = 0` (distinct from continuous-trading `+1` buy-aggressor / `-1` sell-aggressor). Excluded from CVD, aggressor-based metrics, and `cum_vol` monotonicity validation (`side=0` rows carry `cum_vol=0`).
_Avoid_: "auction trade" alone, "opening trade", "closing trade"

Multi-**Stock-Date** generalisation: each **Stock-Date** in a **Stock-Date Range** has its own opening Auction Cross (~09:00:00) and its own closing **Auction Window** + closing Auction Cross (15:20:00–15:30:00). Frontend consumers (e.g. CandlePane's "muted color from 15:20 onward" rule) must compute the threshold per segment, not from a single global `session_open_ms`. The wire surfaces this implicitly: each `RangeBundle.segments[i]` carries its own `session_open_ms` / `session_close_ms`.

**Auction Window**:
The period leading up to an **Auction Cross** during which limit orders accumulate but no continuous matching happens. KRX has two within the Regular Session: the closing **Auction Window** runs 15:20:00–15:30:00 and resolves with a cross at 15:30:00.000. The opening Auction Window (pre-market, part of the Data Window) is symmetric. **Snapshots are present and meaningful during an Auction Window** — bid/ask quantities at each level accumulate visibly. **Trades are absent** during the window itself; the cross at the window's close produces a single `side = 0` trade. UI metrics that read **raw snapshot quantities** (**Quote Totals**) render continuously across an Auction Window — the accumulating levels are themselves the signal. UI metrics that compute **derived ratios** from those quantities (**호가비** — `ask_total / bid_total`) are dominated by one-sided order accumulation during the window and read as misleading extremes; the RatioPane therefore masks Auction-Window values to 0 by default, controlled by a per-tab `auctionWindowMask` toggle in the Settings modal. UI metrics that rely on continuous trades (**FillStrength**) show a natural gap then a single bar at the cross.
_Avoid_: "auction period", "auction phase", "auction time" (all overloaded)

**Auction Mask**:
The composite UI state that gates whether a _derived ratio_ visualization should be suppressed at a given moment. Active iff (1) the per-tab `auctionWindowMask` toggle is `true` AND (2) the current **Cursor** falls inside the closing **Auction Window** (per `VirtualAxis.inClosingAuctionWindow`). The toggle alone is _intent_ ("mask when applicable"); the mask is the _activated decision_ for a specific cursor moment. Consumed by `RatioPane` (per-point on the time series) and by spot views (`TotalQtyBar` on the sidebar) — anywhere a ratio reading from one-sided order accumulation would otherwise read as a misleading extreme. The frontend hook `useAuctionMaskActive(axis)` returns the boolean for spot views; series projectors that loop over many `t` values inline the same predicate (`auctionWindowMask && axis.inClosingAuctionWindow(t)`) because they are not React-tree code and cannot call hooks. CandlePane's "muted color from 15:20 onward" rule deliberately does _not_ participate in the Auction Mask — see ADR-0018. Candle muting is a visual cue about price-formation regime (call auction vs continuous trading), not a misleading-value suppression, and the two intents share only a predicate.
_Avoid_: "mask" alone (overloaded with any UI hide rule); "auctionWindowMask" used to mean the activated state (that name belongs to the underlying toggle, not the derived decision).

**Half-Day Session**:
A KRX trading day whose **Regular Session** is materially shorter than the typical 6h30m — year-end (12월 30일), 추석 / 설 전 영업일, etc. — and closes at 12:30 KST instead of 15:30. The closing **Auction Window** is still the last 10 minutes of the session (12:20–12:30 on these days), not a fixed wall-clock band. Session bounds are always read per-Stock-Date from the parsed TSV (`hoga/parser/__init__.py` parses `regular_session_open_ms` / `regular_session_close_ms`), never assumed — `sessionOpenMs + 6h20m` is a half-day footgun and the `SessionTime` predicates encode the duration-anchored rule.
_Avoid_: "short day", "early close" alone (ambiguous with intraday halts).

**SessionTime**:
The frontend module (`frontend/src/util/sessionTime.ts`) that owns KRX session-phase classification — pre-open auction, regular trading, closing auction, gap, pre-axis, post-axis. New chart and sidebar code consumes the named predicates (`isRegularSession`, `isClosingAuction`, `isPreOpen`, `sessionPhaseAt`) rather than re-deriving inequalities locally. Legacy `VirtualAxis.contains` and `VirtualAxis.inClosingAuctionWindow` delegate here for backward compatibility, so the bug class where pre-open auction closes leaked into MA windows or where half-day sessions disabled all auction masking cannot recur.
_Avoid_: hand-rolled `realMs >= sessionOpenMs && realMs <= sessionCloseMs` checks; new domain timing rules belong in `sessionTime.ts`.

**After-Hours Trading**:
The KRX 장후 시간외 종가매매 window that runs from the closing Auction Cross at 15:30:00 to 16:00:00. All trades during this window match at the closing price (the cross price from 15:30:00) — so the price stays flat while volume continues to accumulate. Both snapshots and trades are present in hogaplay's capture across this window. Trades have continuous-trading `side = ±1` (not `side = 0`) — they are aggressor-matched at a fixed price, not auction crosses. Outside `CONTEXT.md`'s strict Regular Session definition (09:00–15:30) but inside hogaplay's Data Window and inside the v1 frontend display range.
_Avoid_: "after-hours" alone (ambiguous with overnight or block-trade markets), "post-market"

**Price Tick**:
A 3-field `section=3 type=5 price` heartbeat broadcast emitted by hogaplay throughout the session. Carries only the current price — no qty, side, or seq. Discovered during E2E validation 2026-05-20. Parser drops these rows entirely; the same information is already present in trade events.

**Entity**:
The in-memory frozen-dataclass representation of one row of table data inside hoga-ops. Carries every field including **forensic** ones — fields whose meaning is partially or fully undecoded (`unknown_14`, `unknown_16`, `unknown_17`, `unknown_18`) kept to enable later decoding without re-collection. Used by the parser on the write path. Internal — never returned by the API. Examples: `Trade`, `Orderbook`, `BrokerRow`, `Candle` in `hoga/tables/*`.
_Avoid_: "model", "domain object", "record"

**Cursor**:
A single Unix-ms (UTC) point on the API contract — the value of the `?t=`
query parameter on spot endpoints (`/api/orderbook`, `/api/brokers`,
`/api/trades`), the frontend tab's `cursorMs`, and the right edge of the
viewport published by `ChartStage`. Always a real Unix-ms per ADR 0003 —
never the native HHMMSSmmm or ms-from-midnight encodings the Parquet
tables use. Conversion to native happens once at the route boundary via
`hoga.api.cursor::cursor_to_native`, which raises HTTPException(400) when
the Cursor falls outside the requested **Stock-Date**.
_Avoid_: "timestamp" alone (ambiguous with Entity ts_ms and Wire Model
ts_ms which may differ in encoding), "t param".

**Capture Frontier**:
The collector's next-request position for an in-flight **Full Capture** — the `t` value the next `first.php` call will use, equivalently the upper bound of the Data Window range already processed. Internally tracked as HHMMSSmmm (matches hogaplay's `first.php` `time` parameter and the `last_time_ms` field written to `_progress.json`, sourced from `PageStepController.next_t`); surfaced through the capture API as `frontier_ms` in Unix-ms per ADR-0003. Distinct from **Cursor** (which is an API/UI contract concept on the read path).
_Avoid_: "cursor" (overloaded with the API/UI **Cursor**), "current position", "progress timestamp", "last_time_ms" (the internal HHMMSSmmm field name — don't use on the API surface)

**Wire Model**:
The pydantic model returned by API endpoints — the shape clients see. Strips forensic fields (and any other internal-only data). Each table module pairs an **Entity** with its Wire Model: `Trade`↔`ApiTrade`, `Orderbook`↔`ApiOrderbookSnapshot`, `BrokerRow`↔`ApiBrokerEntry`, `Candle`↔`ApiCandle`. Query helpers (`query_at`, `query_up_to`, etc.) return Wire Models directly — there is no intermediate dict materialization.
_Avoid_: "API model" alone (ambiguous with response containers like `OrderbookResponse`), "DTO"

**Stock-Date Range**:
A `(Code, fromDate, toDate)` tuple bounding N consecutive **Stock-Date**s (`fromDate <= toDate`, both YYYYMMDD KST). `fromDate == toDate` is the degenerate single-Stock-Date case; otherwise multiple. The unit the Replay Viewer's `DateRangePicker` produces and the `Workarea` consumes. Distinct from the **Data Window**'s intra-day range (08:40–16:00 of one **Stock-Date**) and from the collector's loop range / scrubber range surfaced via **Capture Frontier**. Maximum span enforced server-side (currently 90 days).
_Avoid_: "date range" (collides with Data Window range and capture loop range — both pre-existing), "range" alone (ambiguous across three meanings now), "selection" alone (what is being selected is unclear — use the compound).

**RangeBundle**:
The Wire Model returned by `GET /api/range` for one **Stock-Date Range** — bundles four pre-aggregated time-series (`candles`, `quote_ratio`, `volume_profile_range` / `volume_profile_by_day`, `fill_strength`) aggregated at the requested **Timeframe**'s `bucket_ms`, plus a `segments` array carrying each in-range **Stock-Date**'s `session_open_ms` / `session_close_ms`. The series with a per-day price-grid binding (`volume_profile_by_day`) ships as a per-segment list; series with flat point arrays (`quote_ratio.points`, `fill_strength.points`, `candles`) are concatenated across segments (the **Regular Session** bounds, in Unix ms per ADR 0003). `len(segments) == 1` is the degenerate single-**Stock-Date** case. The displayed window each segment covers spans the **Regular Session** plus the closing **Auction Window** plus the trailing **After-Hours Trading**. Built in `hoga/api/bundle.py::build_range_bundle`. The frontend hook `useRange(code, from, to, timeframe)` calls this endpoint; the frontend type `RangeBundle` mirrors the Wire Model verbatim per ADR-0004. RangeBundle is the single read-path Wire Model for **Stock-Date Range** queries — there is no separate single-day variant (the prior `SessionBundle` / `/api/session` was retired in ADR-0013; see relationships note below). A fifth series `depth_intensity_by_day` was retired alongside the IntensityPane removal — see the 2026-05-23 Quote Totals Pane design.
_Avoid_: "MultiSessionBundle", "StockDateBundle", dropping the "Bundle" suffix — "the range" alone collides with **Stock-Date Range** and is _Avoid_'d. Canonical reference: "the RangeBundle for {code}/{from}..{to}@{timeframe}".

**Quote Totals**:
The 매수 1–10호가 / 매도 1–10호가 quantity sums per **Timeframe** bucket — the raw orderbook depth metric from which **호가비** is derived. Exposed on the wire as `quote_ratio.points[*].bid_total` and `ask_total`, computed in `hoga/api/bundle.py::build_quote_ratio_slice` via `SUM(bid_q1..bid_q10)` / `SUM(ask_q1..ask_q10)` over each bucket. Rendered by the Replay Viewer's `QuoteTotalsPane` (chart pane 3) as two `LineSeries` — green = bid total, red = ask total — sharing a single auto-scaled price axis so the two values read on the same Y. Quote Totals and 호가비 share one wire field; the field's name reflects the historical (derived ratio) view but the underlying value pair is the primary data.
_Avoid_: "depth totals" (collides with the retired `depth_intensity_by_day` grid), "잔량" alone (ambiguous with broker net 잔량), "bid/ask total" alone (loses the 1–10호가 scope and may be read as a cumulative aggregate over time).

**Volume Profile**:
The per-price-bucket cumulative volume histogram derived from a **RangeBundle**'s trade aggregation — surfaced on the wire as two sibling series with the same shape but different scoping: `volume_profile_range` (one profile spanning the entire **Stock-Date Range**) and `volume_profile_by_day` (one profile per in-range **Stock-Date**, indexed by `segments[i]`). The Replay Viewer's `VolumeProfileOverlay` renders one of the two based on the per-tab `volumeProfileMode: 'range' | 'per-day'` preference; the UI surface for that toggle lives in the Settings modal's "차트" category (relocated from the sidebar header per the 2026-05-23 Volume Profile Settings Relocation design). `range` mode paints a single profile anchored to the right ~30% of the entire viewport; `per-day` mode paints one profile per segment, each anchored to its own segment's right ~30%.
_Avoid_: "volume histogram" alone (collides with the candle-pane volume bars — distinct concept), "bid/ask profile" (loses the trade-volume scope and may be read as orderbook depth), "VP" abbreviation (unclear to readers outside the chart layer).

**호가비**:
The signed bid/ask imbalance ratio derived from **Quote Totals** per **Timeframe** bucket. Positive when asks are heavier (sell-side pressure, formatted "Nx S"); negative when bids are heavier (buy-side pressure, "Nx B"); zero-centered when balanced. Computed frontend-side in `frontend/src/util/imbalance.ts` from `quote_ratio.points[*].{bid_total, ask_total}` and rendered by the Replay Viewer's `RatioPane` (chart pane 2) as a single teal `LineSeries`. Sibling of **Quote Totals** — same source field, different question: 호가비 reads "which side is heavier", Quote Totals reads "how much is on each side".
_Avoid_: "quote ratio" alone (the wire field name; the user-facing concept in Korean is 호가비), "imbalance" alone (ambiguous with **FillStrength**'s buy/sell trade imbalance), "ratio" alone (overloaded across price ratio / time ratio).

**RangeSeriesPane**:
The deep module that owns chart-pane lifecycle for any indicator derived from a **RangeBundle**. Replaces the prior pattern of five near-clone pane components (CandlePane, VolumePane, RatioPane, QuoteTotalsPane, FillStrengthPane), each repeating the same useEffect → addSeries → `axis.contains` filter → `axis.toVirtual` mapping → `setData` → `try { removeSeries } catch` shape with only the per-series projection differing. Takes a **PaneSpec** describing series count, type, options, and a `(bundle, axis, ctx?) => DataPoint[]` projection per series; the module owns the lifecycle invariants (pre-open auction point drop, real-ms → virtual-second mapping, ChartErrorBoundary teardown race guard around `removeSeries`). New indicators add one PaneSpec entry instead of a new component file; cross-cutting policy changes (e.g., a chart-wide setting toggle, a label format change) land in one place. Lives at `frontend/src/chart/RangeSeriesPane.tsx`; the five historical panes survive as named PaneSpec exports (`CANDLE_SPEC`, `VOLUME_SPEC`, `RATIO_SPEC`, `QUOTE_TOTALS_SPEC`, `FILL_STRENGTH_SPEC`).
_Avoid_: "ChartPane" (collides with lightweight-charts' own "pane" terminology), "BundlePane" (loses the per-`paneIndex` series semantic), "SeriesView" (loses the multi-series-per-pane semantic).

**Virtual Axis**:
The stitched, gap-compressed ms time axis on which the Replay Viewer's chart renders. Constructed from a **Stock-Date Range**'s `segments`: each segment's `[sessionOpenMs, sessionCloseMs]` interval is laid end-to-end with a fixed 1-second `INTER_SEGMENT_GAP_MS` separating adjacent segments, so the inter-session **Day Boundary** gap (~17.5 hours of weekday non-trading) collapses to a single second on the axis. The 1-second gap is too small to perceive at any realistic bar spacing but large enough to keep day N's closing candle (`sessionCloseMs`) and day N+1's opening candle (`sessionOpenMs`) on distinct integer-second `UTCTimestamp` values — otherwise lightweight-charts' `setData` rejects the N-1 boundary collisions for multi-day ranges. A real Unix-ms value `t` inside any segment maps to `virtualMs = segments[i].virtualStart + (t - segments[i].sessionOpenMs)`; values in a Day Boundary map to the prior segment's virtual end (the gap "belongs to the day just closed"); values before the first segment map to the axis sentinel (no preceding real time). Lives in `frontend/src/util/virtualAxis.ts` as a frozen factory: `createVirtualAxis(rawSegments)` returns a `VirtualAxis` with `axis.segments` (frozen), `axis.dayBoundaries` (derived), `axis.toVirtual(ms)` / `axis.toReal(ms)` (projections), `axis.findByReal(ms)` / `axis.findByVirtual(ms)` (lookups), and `axis.contains(ms)` / `axis.isInGap(ms)` (predicates). All consumer panes receive `axis: VirtualAxis` as a single prop rather than threading raw `segments`. lightweight-charts receives virtual-ms values directly; tick labels are rebuilt into KST via a custom `tickMarkFormatter` (see spec §6.6(b) — implementation detail kept out of this glossary per grill D4).
_Avoid_: "compressed timeline" alone (ambiguous with replay-speed compression), "virtual time" (ambiguous with synthetic time / mock clocks in tests), "axis" alone (chart has price axis too — always qualify).

**Day Boundary**:
The non-trading gap between two adjacent **Stock-Date**s in a **Stock-Date Range** — from segment `i`'s `session_close_ms` (15:30 KST) to segment `i+1`'s `session_open_ms` (09:00 KST), plus any tail past the final segment's close. Compressed to a 1-second `INTER_SEGMENT_GAP_MS` on the chart's virtual axis (see `util/time.ts`) — visually contiguous but large enough to keep boundary candles on distinct `UTCTimestamp` values — and surfaced as a thick vertical line plus a `MM/DD` chip at each boundary. The frontend predicate `isDayBoundary(segments, realMs)` returns true exactly when `realMs` falls inside such a gap. Distinct from intra-day non-trading periods (lunch break does not exist in KRX continuous trading; pre-open auction at 08:40–09:00 is part of the **Data Window** but outside any segment's **Regular Session** bounds — those are NOT Day Boundaries, they sit before `segments[0].sessionOpenMs`). A **Stock-Date Range** with N segments has N-1 Day Boundaries plus a post-tail region; N=1 has zero Day Boundaries.
_Avoid_: "overnight gap" (collides with after-hours overnight quote moves that aren't part of this codebase's window), "session gap" alone (ambiguous — Regular Session is part of the term).

**Timeframe**:
Chart candle time resolution. Six fixed values: 1m / 3m / 5m / 10m / 15m / 30m. Surfaced as `bucket_ms` on the wire (60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000). All five **RangeBundle** series share the same Timeframe — `candles` re-aggregates OHLC, the other four use their existing `bucket_ms` parameter set to the same value. User-selectable via the Replay Viewer's `TimeframeSelector` in the toolbar. Distinct from **Page Step** (collector loop's `time` increment, write-path concept) and from the Cursor's intra-Stock-Date sampling resolution.
_Avoid_: "interval" (collides with **Page Step**), "resolution" (ambiguous with chart pixel density / display resolution), "bucket" alone (overloaded — `bucket_ms` is fine as a field name, but "the bucket" in prose is unclear).

**Symbol Master**:
The catalog of `(Code, name, market)` tuples sourced from pykrx — the lookup layer that lets a user type a Korean name fragment (e.g., "삼성") and resolve it to a **Code** (`005930`). **Disk-persisted** at `~/.local/share/hoga-ops/symbol-master.json` (machine-global XDG path; see ADR-0015) and mirrored in memory by `hoga/api/symbols.py` as module-level state (`_cache`, `_fetched_at_ms`, `_state: SymbolCacheState`) per ADR-0006's single-module pattern. Surfaced through `GET /api/symbols/all` (full catalog with per-Code captured-Stock-Date breakdown), `GET /api/symbols?q=…` (in-memory search), `GET /api/symbols/info` (lightweight metadata for the Settings page), and `POST /api/symbols/refresh` — **the sole pykrx entry point**. Boot and read endpoints never trigger fetches; a fetch happens only when the user explicitly clicks Update (Settings page) or Refresh (SymbolSearch unavailable/stale states). The catalog has no automatic-refresh TTL — staleness is signalled by the Settings page's "Last fetched: N days ago" row and by an empty-result nudge in SymbolSearch when the disk file is ≥ 7 days old. The frontend's `useSymbols()` hook and `SymbolSearch` component (`frontend/src/capture/`) bind to these endpoints. This compound is sanctioned despite the bare "symbol" noun being _Avoid_'d elsewhere — the established class names across backend (`SymbolHit`, `SymbolsAllResponse`, `SymbolMasterInfo`, `SymbolCacheState`) and frontend (`SymbolSearch`, `useSymbols`) make it the canonical term. Do not rename to `CodeCatalog` or `TickerMaster`; the compound is the term.
_Avoid_: bare "symbol" (use **Code** for the 6-digit ticker, or **Symbol Master** for the catalog/lookup layer), "ticker", "symbol list" (use "the Symbol Master" or "Symbol Master entries"), "force re-fetch" (the predecessor 24h-TTL model is gone — refresh is always user-initiated, never "forced" over an automatic schedule). The class names `SymbolHit` and `SymbolSearch` are sanctioned compounds — do not rewrite them in prose as bare "symbol".

## Relationships

- A **Stock-Date** has exactly one **Data Window** and exactly one **Full Capture**.
- A **Stock-Date**'s **Regular Session** sits inside its **Data Window**.
- A **Full Capture** is built from N **Pages**; consecutive Pages may overlap.
- The collector captures the entire **Data Window**; UI and analysis default to the **Regular Session** but can extend to the **Data Window**.
- Each Parquet table has one **Entity** type (for the parser write path) and one **Wire Model** type (for the API read path). Both live in the same `hoga/tables/*.py` module.
- A **Stock-Date Range** contains N consecutive **Stock-Date**s (N ≥ 1). The **RangeBundle** is its sole read-path Wire Model; the prior single-day `SessionBundle` was retired in ADR-0013 in favor of unifying the read path on RangeBundle. Each in-range **Stock-Date** appears as one element of `RangeBundle.segments` carrying that day's **Regular Session** bounds; series data is concatenated across segments on a stitched virtual axis.

## Flagged ambiguities

- "session" was used ambiguously to mean both **Regular Session** (info.tsv's `session_open`/`session_close` fields) and **Data Window** (collector loop range, scrubber range) — resolved 2026-05-19: these are distinct, use the precise term.
- "cursor" was used in early Capture UI mockups to label the collector's progress marker; this clashes with the API/UI **Cursor** — resolved 2026-05-21: in-flight progress is **Capture Frontier**, **Cursor** is reserved for read-path API/UI use.
- "symbol" was used as a bare noun in early `symbols.py` code and the 2026-05-22 KRX env spec — clashes with the **Code** glossary entry that _Avoid_'s "symbol" — resolved 2026-05-22: bare "symbol" remains _Avoid_'d (use **Code** for the 6-digit ticker), but the compound **Symbol Master** is sanctioned as the catalog/lookup-layer term, mirroring the **SessionBundle** precedent. Class names `SymbolHit`, `SymbolsAllResponse`, `SymbolSearch`, `useSymbols` are sanctioned compounds — not renamed.
