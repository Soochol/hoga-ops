# 0016 — Retire depth_intensity heatmap; pane 3 hosts Quote Totals

**Status:** accepted (2026-05-23)

## Decision

The Replay Viewer's pane 3 stops rendering the `depth_intensity` heatmap
and instead hosts **Quote Totals** — two `LineSeries` showing per-bucket
sums of 매수 1–10호가 (green) and 매도 1–10호가 (red), sourced from the
`bundle.quote_ratio.points[*].{bid_total, ask_total}` pair that already
exists for **호가비**'s derivation.

In the same change, the entire depth_intensity pipeline is deleted:

- `hoga/api/bundle.py::build_depth_intensity_slice` is removed.
- `hoga/api/models.py::DepthIntensity` and the
  `RangeBundle.depth_intensity_by_day` field are removed.
- `frontend/src/api/types.ts::DepthIntensity` and the matching bundle
  field are removed.
- `frontend/src/chart/IntensityPane.tsx` and its test are deleted.

There is no transitional deprecation. The data and the consumer
disappear together, mirroring the retirement style of ADR-0013.

## Why

The heatmap was implemented and Phase 0 spike-validated, but in practice
its 28-bin price-grid × time surface answers questions users were not
asking. The dominant question on pane 3 in daily use is "which side of
the orderbook is heavier, and by how much?" — and the answer is already
in the totals that **호가비** derives its ratio from. Two `LineSeries`
on a shared price axis present that comparison directly and let the user
read both sides' absolute magnitudes at the cursor.

The underlying signal (1–10호가 잔량) is preserved exactly. What is
dropped is the per-price-bin distribution within those ten levels —
information the heatmap exposed but the user's workflow did not depend
on. If a later use case revives that need, a follow-on ADR can
reintroduce it (likely as an on-demand inspector rather than a
permanent pane).

A secondary motivation: the heatmap path accumulated architectural
friction. The portal-canvas overlay pattern hit two separate bugs in
the prior session (z-index stacking under lightweight-charts' internal
canvases; `ResizeObserver` capturing a stale canvas reference across
React's portal remount). Both were fixable, but they signal that
`canvas`-in-pane overlays are a higher-maintenance pattern than the
native `LineSeries` `RatioPane` uses. Switching pane 3 to a `LineSeries`
pane removes the only remaining production user of the overlay pattern.

## Trade-offs and what we considered

- **(chosen) Delete depth_intensity, host Quote Totals on pane 3.**
  Simpler payload (one fewer wire series), simpler frontend (no
  canvas portal, no anchor `LineSeries`, no `ResizeObserver`), immediate
  bid-vs-ask comparability at the cursor. Loses per-bin distribution.
- **(rejected) Keep depth_intensity, add Quote Totals as a new pane.**
  Payload retains its ~330 KB depth_intensity block (003490 × 2 days × 1 m
  bucket measurement) for a feature no longer surfaced. Either both
  panes compete for screen, or the heatmap becomes dead code on the
  wire — a worse outcome than removing it cleanly.
- **(rejected) Aggregate the heatmap (e.g., 5 bins) and keep.** Reduces
  payload but does not fix the legibility problem; the heatmap is still
  a surface, still requires the user to "read intensity at a coordinate"
  to extract information that two lines convey at a glance.
- **(rejected) Make the heatmap toggleable.** Adds UI plumbing and a
  new tab-level pref for a feature the user actively opted out of. Cost
  is not justified by the demand.

## Consequences

- **Wire surface change.** `RangeBundle` ships four pre-aggregated
  series instead of five. Any external consumer (notebook, script,
  cached payload) that reads `depth_intensity_by_day` breaks at the
  next fetch. Inside this repo, `IntensityPane.tsx` is the only reader;
  outside-repo consumers are not anticipated for this worktree.
- **ADR-0013 partial supersession.** ADR-0013's consequence block
  describes `depth_intensity_by_day` as one of the two per-day
  price-grid series (the other being `volume_profile_by_day`). The
  per-day price-grid pattern continues to apply to
  `volume_profile_by_day`; the depth_intensity instance of it is
  retired. ADR-0013's principle ("each read-path domain object → one
  Wire Model") is unchanged.
- **PANE_STRETCH rebalance.** Pane 3's stretch factor drops from 0.8
  to 0.4. Total stretch falls 3.3 → 2.9. CandlePane's proportional share
  rises from ≈42 % to ≈48 %; this is intentional — two lines need less
  vertical space than a heatmap.
- **CONTEXT.md.** Two new glossary entries land alongside this ADR:
  **Quote Totals** (the raw bid/ask total pair) and **호가비** (the
  derived imbalance). The **RangeBundle** entry drops to "four series".
  The **Auction Window** entry's UI-metric example list switches from
  "(호가비, depth intensity)" to "(호가비, Quote Totals)".
- **Test coverage.** `frontend/src/chart/IntensityPane.test.tsx` is
  deleted. The new `QuoteTotalsPane` gets a test that mirrors the
  existing pane-test pattern (mock `addSeries` → fixture bundle →
  assert `setData` calls and unmount cleanup). Backend
  `build_quote_ratio_slice` tests remain unchanged and now stand as
  the implicit data-correctness check for the new pane.

## Out of scope

- VolumeProfileOverlay's overlay-canvas-not-painting bug (canvas buffer
  stays at default 300×150). Same architectural pattern as the
  IntensityPane portal-overlay class of bugs and likely fixable with
  the same `paneEl`-in-deps + explicit z-index trick, but it does not
  block this change.
- Reintroducing per-price-bin liquidity in a different surface form
  (e.g., on-demand inspector, hover-only popover). The current decision
  is to ship without it; a future ADR may revisit.
- Renaming the `quote_ratio` wire field to something that reflects "it
  carries both raw totals and is the source for the derived ratio".
  Considered briefly during brainstorming and deferred — the rename
  ripples through backend models, frontend types, tests, and any
  cached payloads, and the naming dissonance is small enough to handle
  with a glossary entry (`Quote Totals`) plus an inline comment at the
  consumer site.
