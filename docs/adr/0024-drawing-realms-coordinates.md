# ADR-0024: Drawing persistence uses real Unix-ms, not virtual-ms

**Status:** Accepted
**Date:** 2026-05-24
**Spec:** docs/superpowers/specs/2026-05-24-replay-chart-pan-lock-and-drawing-tools-design.md

## Context

The chart in the Replay Viewer renders on a **Virtual Axis** that stitches several **Stock-Date** sessions end-to-end with a 1-second compressed inter-session gap. Drawings (horizontal lines, trendlines, freehand strokes) need to persist across page reloads and be re-rendered correctly when the user reopens the same **Code** at a possibly different **Stock-Date Range**.

The drawing's time coordinate could be encoded in either of two ways:

1. **Virtual-ms** — the value emitted by `axis.toVirtual(realMs)` and fed directly to `timeScale.timeToCoordinate`. Cheapest render path (zero conversion at draw time).
2. **Real Unix-ms** — the value used everywhere else in the project (`Cursor`, `frontier_ms`, `segments[*].session_open_ms`). One extra `axis.toVirtual` call per vertex at draw time.

## Decision

Drawings persist their time coordinates as **real Unix-ms (UTC)**. The renderer converts to virtual-ms via `axis.toVirtual(realMs)` and then to canvas X via `timeScale.timeToCoordinate(virtualMs / 1000)` per vertex per frame.

## Consequences

**Range-independent persistence (the reason for this ADR).** Virtual-ms is computed relative to the first segment's `sessionOpenMs` (per `util/virtualAxis.ts`). A drawing stored as virtual-ms is therefore tied to one specific **Virtual Axis** construction, i.e. one specific **Stock-Date Range**. Storing drawings per **Code** with virtual-ms would silently corrupt their position whenever the user reopened the same **Code** at a different Range. Real Unix-ms is invariant under Range changes.

**Alignment with ADR-0003.** All time on the API and UI contracts is real Unix-ms. Drawings inherit the same encoding, so any future server-side persistence (e.g. sync across devices) reuses the existing serialization without translation.

**Per-vertex conversion cost.** The render path now does one binary search inside `axis.toVirtual` plus two coordinate calls per vertex per frame. For the cardinalities users actually produce (< 50 drawings, < 5000 vertices total per pencil), this is far below frame budget.

**Out-of-range vertex behavior.** When a vertex's `realMs` falls outside every segment, `axis.toVirtual` returns the prior-segment-end sentinel. The renderer treats those vertices as "skip and break the polyline" (pencil) or "clip to canvas bound along the slope" (trendline) rather than stacking the geometry on the sentinel — a virtual-ms representation could not preserve this information at all.

## Alternatives considered

- **Per-Range storage of virtual-ms.** Rejected: the analyst expectation is "my trendline on 005930 is still there next time I look at 005930", not "still there if I happen to pick the same week". Per-Range keys would multiply storage and create UX confusion.
- **Pixel coordinates.** Rejected for the same reason as in the spec — they desync on any pan/zoom.
- **Encoding the source Range alongside virtual-ms.** Rejected as more complex than just storing realMs and getting Range-independence for free.

## See also

- CONTEXT.md: **Drawing**, **Drawing Overlay**, **Drawing Tool**, **Virtual Axis**
- ADR-0003: API time encoding (Unix-ms)
- ADR-0013: RangeBundle single read path
