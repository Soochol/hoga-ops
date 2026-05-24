# ADR-0028: Drawing pane binding by stable `paneId`, not array index

**Status:** Accepted
**Date:** 2026-05-24
**Spec:** docs/superpowers/specs/2026-05-24-drawing-on-indicator-panes-design.md

## Context

Until this change, **Drawing**s (hline, trendline, pencil) could only live
on the candle pane (`paneIndex = 0`). The Drawing Overlay was hard-wired
to a single `priceSeries` prop and clipped all rendering to pane 0. The
new design lets users draw on any indicator pane (volume, ratio,
quoteTotals, fillStrength).

To do that, each Drawing must remember **which pane it belongs to** —
both for clip-rect math and for Y-coordinate interpretation (price means
KRW on the candle pane, share count on the volume pane, signed −1..1 on
the ratio pane).

Three candidate encodings:

1. **`paneIndex: number`** — store the lightweight-charts pane index
   (matching the `PANE_SPECS` array position). Cheapest at the
   library-API boundary; one number per drawing.
2. **`paneId: PaneId` (stable string ID)** — store `PaneSpec.name`
   verbatim (`'candle'`, `'volume'`, `'ratio'`, etc.). Resolve to a
   numeric index at runtime when calling lightweight-charts.
3. **Normalised pane-relative Y (0..1)** — abandon "which pane" entirely
   and store the drawing as a fraction of pane height plus an
   inferred-at-load anchor.

## Decision

Persist Drawings with a **`paneId: PaneId` string**. Resolve to a numeric
`paneIndex` at runtime via a cached lookup over the live `PANE_SPECS`
array.

`PaneId` is a typed literal union of the existing `PaneSpec.name`
values: `'candle' | 'volume' | 'ratio' | 'quote-totals' | 'fill-strength'`.
The `name` field is already the stable identifier used elsewhere in the
codebase (`data-pane` HTML attribute, E2E selectors); this ADR promotes
it to the persistence layer too.

`PaneSpec.name` becomes a versioned identifier: **renaming an existing
name is a breaking change** that strands users' saved drawings. New
panes append new names. A top-of-file comment in `paneSpecs.ts` records
this invariant; code reviewers enforce it.

## Consequences

**PANE_SPECS reorder safety (the reason for this ADR).** The PANE_SPECS
array's element order is a code-layout detail and reordering it is a
one-line change. Encoding the array index into persisted user data
couples every saved drawing to that ordering — a future reorder would
silently shift drawings to the wrong pane with no data-shape change to
detect. Stable IDs are immune to reordering by construction.

**Pane addition / removal.** Inserting a new pane between two existing
ones leaves all stored drawings on their correct panes. Removing or
hiding a pane leaves orphaned drawings in storage; the renderer skips
them (`paneSeries.get(d.paneId) === undefined`), so they reappear if
the pane is restored. No silent data loss.

**Runtime cost.** One small `Map<PaneId, number>` lookup per Drawing per
draw frame. Negligible — far cheaper than the per-vertex
`priceToCoordinate` and `axis.toVirtual` calls each draw already does.

**Migration.** Legacy `localStorage` payloads (no `paneId`) backfill
to `paneId = 'candle'` on load. A defensive branch also accepts any
in-flight `paneIndex` field by resolving through PANE_SPECS. Persistence
schema version stays at `v: 1` — the change is a forward-compatible
superset (older readers ignore the new field).

**Alternatives considered.**

- **`paneIndex` (option 1)** was the brainstorming-time default
  ("matches the lightweight-charts API, simple"). The grill pass surfaced
  the silent-reorder risk: a developer editing `paneSpecs.ts` to put
  RATIO above VOLUME has no way to know they just moved every user's
  saved drawings to the wrong pane. The robustness cost of `paneId`
  (a small map lookup) is far smaller than the cost of an undetectable
  data corruption.
- **Normalised Y (option 3)** was rejected during brainstorming: an
  hline meaning "10만 주" on the volume pane reads as a *value*, not a
  height ratio; users expect the line to follow autoscale, not to drift
  with pane resizes. The pane's own price scale already does the
  right thing — re-implementing it in the drawing layer adds work and
  loses meaning.

**Relationship to ADR-0024.** ADR-0024 fixed the *time* coordinate
encoding (real Unix-ms, not virtual-ms). This ADR fixes the *pane*
binding (stable string, not array index). Together they define the
range-independent, ordering-independent coordinate system that
Drawings persist in.
