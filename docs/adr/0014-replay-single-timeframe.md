# 0014 — All Replay series share a single Timeframe

**Status:** accepted (2026-05-22)

## Decision

The Replay Viewer's five pre-aggregated series (`candles`, `quote_ratio`,
`depth_intensity`, `fill_strength`, `volume_profile`) are aggregated at a
**single Timeframe** per `RangeBundle` request. The Timeframe is one of
the six fixed values surfaced through the toolbar's `TimeframeSelector`
(1m / 3m / 5m / 10m / 15m / 30m) and travels on the wire as
`bucket_ms` (60_000 / 180_000 / 300_000 / 600_000 / 900_000 / 1_800_000).

There are no per-series Timeframe overrides. There is no "Auto" mode
that switches Timeframe based on zoom level. The user-selected Timeframe
applies uniformly across all panes; volume_profile's price axis is
time-aggregation-agnostic but still respects the Range bounds.

## Why

The pre-existing wire models each carried independent `bucket_ms`
defaults: `quote_ratio` was 1s, `depth_intensity` 5s, `fill_strength`
60s, `candles` a hard-coded 1m. Letting each pane keep its own
resolution under a multi-day Range Selection produces visually
incoherent panes — at the same x-coordinate, candle pane shows one
minute of OHLC, ratio pane shows the snapshot from one specific second
inside that minute, intensity pane shows max-over-5-seconds, fill pane
shows the minute metric. A user reading "is this minute bearish?"
across panes has to mentally reconcile four different time grids.

Unifying on one Timeframe makes the visual story coherent: every pane
at x-coordinate T represents "what happened during the Timeframe
window starting at T". Zoom and scroll move the entire stack as a unit.

We considered an "Auto" mode that picks Timeframe per zoom level
(1m when zoomed in, 30m when zoomed out across days). Rejected for v1
because (a) it requires a defined mapping policy that is itself
arguable, (b) it hides the resolution change from the user — the same
chart appears to "smooth out" magically, which obscures the underlying
data, and (c) explicit selection matches TradingView's idiom which the
user invoked by name. Auto mode remains possible as a future addition
on top of explicit selection.

Per-series overrides were also considered (e.g. "show 1m candles but
keep 1s ratio"). Rejected because (a) the coherent-x-coordinate
property is the main value of the multi-pane layout, (b) it would
require per-series wire `bucket_ms` parameters and per-series
`TimeframeSelector` UI, and (c) no user need surfaced during
brainstorming.

## Trade-offs and what we considered

- **(chosen) Single Timeframe across all series.** Visual coherence,
  one-click UX, smallest API surface.
- **(rejected) Auto-Timeframe from zoom level.** Less explicit, hides
  resolution shifts, requires a non-obvious mapping policy.
- **(rejected) Per-series Timeframe overrides.** Maximum flexibility
  but breaks the coherent-x-coordinate property; no demand signal.
- **(rejected) Keep current per-series defaults, add Timeframe only
  to candles.** Smallest change but leaves the multi-pane coherence
  problem unsolved.

## Consequences

- The `/api/range` endpoint takes a single `bucket_ms` query parameter
  that propagates to all five series builders.
- Three of the five existing series builders (`quote_ratio`,
  `depth_intensity`, `fill_strength`) already accept `bucket_ms` —
  this ADR formalises that the value is uniform per request.
- `candles` gains a new server-side downsampler (`downsample_candles`)
  that re-aggregates the 1m parquet rows into OHLC at the requested
  `bucket_ms`. At `bucket_ms == 60_000` this is identity.
- `volume_profile` is time-agnostic (price-bin distribution); the
  Timeframe choice does not affect it, but a Range Selection still
  bounds which trades feed into it.
- Sampling semantics per series are documented in the spec
  (`docs/superpowers/specs/2026-05-22-replay-zoom-density-design.md`
  §5.3) and are NOT considered part of this ADR's scope — they are
  data-model decisions belonging to each series module, not
  cross-cutting policy.

## Out of scope

- The Auto-Timeframe-by-zoom-level idea (deferred, possibly indefinitely).
- Sub-minute Timeframes (10s, 30s). The underlying `candles` parquet
  is 1m fixed; sub-minute candles would require a parser change.
- Custom user-defined Timeframes (7m, 2h, 1d, etc.). The six fixed
  values are deliberate to keep the selector compact.
