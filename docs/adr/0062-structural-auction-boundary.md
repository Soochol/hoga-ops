# 0062 — Closing-auction boundary is detected by orderbook structure, not the 15:20 clock

**Status:** accepted (2026-06-03)

## Decision

The closing **Auction Window** boundary that gates 호가비·**Quote Totals** bucket
representative selection is detected from **orderbook structure**, not a
`session_close − 10min` wall-clock threshold. A snapshot is *continuous-trading*
iff its book shows depth beyond level 3 (any of `ask_q4..ask_q10` /
`bid_q4..bid_q10` is nonzero); the closing auction collapses every book to exactly
3 levels. The boundary
is `last_continuous_ms` — the last continuous snapshot at/before the session close
— and any snapshot after it is the closing auction.

Applies to both read paths: `build_quote_ratio_slice` (past Stock-Dates) — whose
bucketing SQL lives in `snapshots_tbl.query_bucketed_ratio` per ADR-0001 — computes
`last_continuous_ms` from `snapshots.parquet`; `bucketHogaSeries` (today live)
computes it from the SSE ob buffer's `asks`/`bids`. The representative-selection
machinery (backend 2-tier `ORDER BY (pre_auction) DESC, ts DESC`; frontend
`seenPre` fallback) is unchanged — only the definition of "pre-auction" moved from
time to structure.

The `<= session_close` upper bound on the `last_continuous_ms` search is
load-bearing: every captured stock shows a post-cross book re-expansion (~15:30:14)
that, unbounded, would pull the threshold past the auction window and leak the
auction back in.

Scope (v1): closing auction only, calculation layer only. Intraday **VI**
single-price runs sit before the threshold and are retained. The display Auction
Mask stays time-based; the wire contract is unchanged.

## Why

The prior boundary (`session_close − 10min` = 15:20:00.000, ADR-0029 amendment
2026-06-03) assumed the continuous→auction transition happens exactly at 15:20.
It does not: across the captured corpus the transition lands at 15:20:01.xx and
drifts ±seconds per Stock-Date/code. A fixed-time boundary therefore mis-slices
the tail bucket in both directions — a 3-level snapshot timestamped 15:19:55 was
treated as continuous (contaminating the bucket), and a continuous snapshot at
15:20:03 was treated as auction (dropping real data). This was the user-reported
"1분봉에서도 안 됨 / 동시호가가 새어들어옴".

The orderbook structure marks the transition exactly and time-independently. Cross-
stock verification: the continuous→auction transition is a clean monotonic step
(0/368 stocks show a continuous book re-appearing inside the auction after it
starts), and every intraday 3-level run is a sustained VI single-price period
(all runs length ≥10, zero singleton flickers) — never a thin continuous book —
so structure never misclassifies genuine continuous trading. See the
**Single-Price Book Signature** entry in CONTEXT.md.

## Alternatives considered

**Keep the time boundary, widen the window.** Rejected — any fixed offset still
mis-slices when the real transition drifts, and a wider window drops legitimate
late-continuous data.

**Pure structural (mask every 3-level snapshot, incl. intraday VI).** Deferred,
not rejected — it is simpler (no threshold, no `session_close` bound) and matches
"any single-price = no indicator", but masking intraday VI buckets requires a
structural marker to reach the projector (a wire field) and a mid-session
line-gap rendering decision (ADR-0029's transparent-color trick assumes the
day-end). Tracked as the v2 "모든 단일가 제외" follow-up in the spec.

**Carry `is_auction` on the wire now.** Deferred — v1's contamination fix needs
only calculation-layer changes; the closing auction is already time-bounded for
the existing display mask. The wire field is required only for the v2 VI work.

## Consequences

- `_CLOSING_AUCTION_WINDOW_MS` removed from `hoga/tables/snapshots.py` (its ADR-0001
  home), replaced by `_AUCTION_BOOK_DEPTH` + derived deep-level sums;
  `AUCTION_WINDOW_LENGTH_MS` no longer used by `buildLiveBundle` (still used by
  `sessionTime`/overlays).
- `query_bucketed_ratio` runs one extra aggregate scan to derive the threshold.
- Half-day (12:30 close) past Stock-Dates are handled with no `−10min` offset.
  The frontend today-live half-day tail remains uncleaned (15:30 fallback close_ms
  loosens the load-bearing bound) — an inherited limitation, root-fixed when the
  backend sends today's real `close_ms`.
- The display Auction Mask boundary stays time-based in v1, so calc and the cosmetic
  band can disagree by the boundary minute — re-anchoring the band to the structural
  boundary is the deferred display task.

## Amendment (2026-06-05) — fully-auction buckets, 10호가 sidebar, crosshair marker

Three follow-ups landed after the v1 boundary, all keyed to the same structural
boundary:

- **Fully-auction buckets emit 0, not the auction fallback.** A bucket whose
  representative row is *not* pre-auction (no continuous member at all — e.g. the
  closing `15:21–15:30` buckets) previously fell back to the last auction 3-level
  book. Now both read paths exclude it: `query_bucketed_ratio` selects
  `CASE WHEN is_pre THEN total ELSE 0`, and `bucketHogaSeries` emits
  `{ask_total:0, bid_total:0}`. The point is kept (at 0), not dropped, so the
  display mask / overlay band / day-boundary connector handling stay intact. The
  호가비 pane renders these flat at 0 for free via `quoteImbalance`'s degenerate
  (≤0 → 0) contract — no projector-level NaN guard (an earlier guard was dead code;
  removed).
- **10호가 sidebar matches the indicator representative.** `/api/orderbook` with
  `bucket_ms` now routes through `query_bucket_representative`, which mirrors the
  same structural `pre_auction DESC, ts DESC` selection. A straddle bucket no
  longer shows the 15:20+ auction book in the sidebar while the indicator shows
  the last continuous book.
- **총잔량 crosshair marker survives the connector-break.** The Auction Mask
  transparents the last pre-auction point's per-point `color` to break the
  outgoing connector; for a `LineSeries` that color also drives the crosshair
  marker, so the marker vanished on hover (1분봉 15:19). `crosshairMarkerBackgroundColor`
  pins it to a solid series color, matching the `BaselineSeries` 호가비 pane (whose
  marker color is series-level, not per-point).

**Known limitation (v1).** The structural `(0,0)` exclusion is boundary-by-structure,
but the display Auction Mask is still clock-based (`[close−10min, close]`). A
**sustained single-price run (intraday VI / halt) that abuts the close with no
continuous resumption** pushes `last_continuous_ms` minutes before 15:20, so buckets
like `[15:18,15:19)` emit `(0,0)` yet fall *outside* the clock mask — rendering as a
plotted multi-minute drop to 0 in the unmasked region (most visible in 총잔량; 호가비
returns to the neutral 0 baseline). No corruption/crash. This extends the
"calc and the cosmetic band can disagree by the boundary minute" consequence above
to multi-minute under a VI-to-close, and is resolved by the same deferred work:
re-anchor the display band to the structural boundary (or carry `is_auction` on the
wire, per the v2 "모든 단일가 제외" follow-up).

Reference: `docs/superpowers/specs/2026-06-03-auction-structural-boundary-design.md`.
