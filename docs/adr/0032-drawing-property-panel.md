# 0032 — Drawing property panel (supersedes ADR-0030 in part)

**Status:** accepted (2026-05-25)
**Supersedes (in part):** ADR-0030 (post-commit clears selection) — only the post-commit clause; the empty-click-deselects companion is preserved.

## Decision

The **Replay Viewer** ships a **Drawing Property Panel** that floats over the chart whenever a **Drawing** is selected in `select` mode. The panel lets the user edit color (16-entry palette), stroke width ({1,2,3,4,5} px), and line style (solid / dashed / dotted), and delete the drawing. The user's last-picked style values are persisted globally to `localStorage["replay.drawingDefaults.v1"]` as **Drawing Defaults** and seed the next new drawing of any kind.

To make the panel always point at a clear target, after a drawing tool commits a new shape the active tool reverts to `select` **and `selectedId` is set to the new drawing's id** — restoring halo + 2× stroke on the freshly-committed shape. This reverses the post-commit clause of ADR-0030.

The empty-click-deselects companion from ADR-0030 is **kept**: clicking on empty chart space in `select` mode clears `selectedId`, hiding the panel.

## Why this supersedes ADR-0030

ADR-0030 argued that a halo on a shape the user had not clicked read as visual noise — *"select mode = nothing selected"* was the user's mental model and a fresh halo broke it. That argument depended on there being **no DOM affordance** that pointed at the freshly-drawn shape: the halo had nothing to anchor.

Once a property panel exists, the halo *is* the visual anchor for the panel. Removing it would make the panel float over the chart with no indication of which drawing it controls. The 2026-05-25 brainstorm session re-examined the trade-off with the panel feature in scope and re-decided the post-commit clause.

The empty-click-deselects clause from ADR-0030 stands because it is independent of the panel: it solves the orthogonal problem of stale selection lingering after unrelated chart interactions.

## Why the palette is fixed

Free-form colour entry would (a) break `DESIGN.md`'s colour-token discipline by introducing arbitrary hex values, (b) add a non-trivial input surface (hex parsing, eyedropper, contrast accessibility), and (c) tempt users into per-drawing colour tweaking that produces noisy charts. Sixteen palette entries cover the practical needs (system / market / strong / muted / grayscale) while keeping the colour vocabulary disciplined.

The palette is registered in `DESIGN.md` as a fourth "user annotation layer" category alongside the existing three (system / status / market direction), because annotations are user-authored content rather than UI chrome — distinct in intent and provenance.

## Why session-only panel position

Persistent panel position would be feature creep — the panel's role is "edit this drawing now," not "remember where I parked the panel for this line." Two questions would also have to be answered (per-drawing? per-stock? what about pan/zoom?) for a feature whose return is "the panel reopens 30 pixels to the left of where it would otherwise." We chose to skip the question and accept that the panel re-anchors per selection.

## Consequences

- `Drawing.lineStyle` field added; legacy hydration defaults to `'solid'`.
- `useDrawingsStore` gains a `defaults` slice; `update(id, patch)` syncs style fields into defaults.
- `ToolCtx` loses `accentColor` and gains `defaults: DrawingDefaults`.
- `revertToSelectMode(newId)` regains its `newId` argument and selects the just-added shape; the Escape handler in `DrawingOverlay.tsx` still clears explicitly (Escape's "return to neutral" semantic is unchanged).
- `setStroke` writes `setLineDash(dashPattern(lineStyle, width))` and switches `lineCap` to `'round'` for dotted (round-cap zero-length-dash dot trick).
- A new component `DrawingPropertyPanel.tsx` mounts as a sibling of `DrawingOverlay` in `ChartStage`.
- ADR-0030's status header is updated to "superseded in part by ADR-0032."
- CONTEXT.md's `Drawing Tool` entry is rewritten to cite ADR-0032 for the post-commit description; the `Drawing Property Panel` and `Drawing Defaults` glossary entries were added during the brainstorm grill and remain accurate.

## Alternatives considered

- **Keep ADR-0030 verbatim; show the panel without restoring selection.** Rejected — the panel would point at a drawing rendered in the same style as every other drawing; the user could not tell which one is being edited.
- **Free-form hex input.** Rejected — colour-token discipline + accessibility cost (see "Why the palette is fixed").
- **Persistent panel position.** Rejected — feature creep with low return.
- **Locked drawings.** Out of scope for v1. The model doesn't need a `locked` field yet; if added later, the panel grows a lock toggle.
