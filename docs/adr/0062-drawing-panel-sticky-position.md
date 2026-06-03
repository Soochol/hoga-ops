# 0062 — Drawing property panel sticky position (supersedes ADR-0032 in part)

**Status:** accepted (2026-06-03)
**Supersedes (in part):** ADR-0032 — only its "Why session-only panel position" *per-selection re-anchor* clause; the *no-persistence* (session-scoped) decision is preserved.

## Decision

The **Drawing Property Panel** becomes **sticky after the first manual drag**. Until the user drags it, the panel still re-anchors near the just-selected **Drawing** on every selection change (the ADR-0032 behaviour). Once the user has dragged it via the grip handle, the panel **keeps that last position across subsequent selections** instead of snapping back to each drawing's computed anchor.

The remembered position is a single global session value (not per-drawing, not per-Code): it lives in component-local state with a `userMovedRef` flag in `DrawingPropertyPanel.tsx`, exactly as the unrestricted position already did. **No localStorage persistence** — a page reload resets the panel to the per-selection anchor, same as ADR-0032.

## Why this supersedes ADR-0032 in part

ADR-0032's "Why session-only panel position" section bundled two distinct decisions under one heading:

1. **No persistence across reloads** (no localStorage). Rationale: avoid the per-drawing / per-Code / pan-zoom questions for a low-return feature.
2. **Re-anchor per selection** — "accept that the panel re-anchors per selection."

Only decision **2** is reversed here. The lived experience of decision 2 was worse than "re-anchors per selection" reads on paper: because hline panels anchor to the chart's horizontal centre (`containerWidth / 2`) and to the line's y, every click on a horizontal line yanked the panel back to centre-above-the-line, discarding wherever the user had just parked it. Users read this as "the toolbar won't stay where I put it." Decision 1's reasoning — *the per-drawing / per-Code / pan-zoom questions* — does **not** apply to a single in-session sticky position, so it is retained untouched: there is exactly one remembered position and it dies with the page.

"Sticky after first drag" (not "sticky always") keeps the helpful default — the very first panel still appears next to the drawing it controls — while honouring an explicit user preference the moment one is expressed by a drag.

## Why absolute freeze, not a relative offset

An alternative was to remember the user's drag *delta* from the anchor and re-apply it to each new selection (`position = anchor + offset`). Rejected: that still relocates the panel on every selection, which is the exact complaint ("it always moves"). A single frozen absolute position is what "keep it where I left it" means. The cost is that the panel can sit far from the selected drawing; the selection halo (ADR-0032) remains the visual indicator of *which* drawing is being edited, so the affordance is not lost.

## Consequences

- `DrawingPropertyPanel.tsx` gains a `userMovedRef` (a `useRef<boolean>`), set `true` inside the drag `onMove` handler (a real drag, not a bare grip mousedown). The re-anchor effect early-returns when it is set. The flag is a ref, not state — it gates an effect that reads it live at run time and needs no re-render, so the existing `react-hooks/exhaustive-deps` suppression on that effect is unchanged.
- After a drag, **drawing a new shape** auto-selects it (ADR-0032's post-commit select) → the re-anchor effect runs → it is frozen → the new shape's panel appears at the parked spot, not near the new shape. This follows from the uniform "keep last position" rule and is intentionally **not** special-cased (special-casing would reintroduce the surprise the rule removes). The user only described clicking existing lines; this is the one case they did not state, called out here for the next reader.
- Cross-kind drags carry a minor visual offset: hline panels use `transform: translate(-50%, -100%)` while trendline / pencil panels are top-left anchored, so a position frozen while editing an hline lands the *top-left* (not the centre-bottom) of a subsequently-selected trendline panel on that point. Acceptable for v1; the dominant flow (hline → hline) shares the same transform and is exact.
- A page reload, or any remount of `DrawingPropertyPanel` (e.g. the chart instance being rebuilt), resets `userMovedRef` and the position — the panel re-anchors on the next selection. This is the retained session-scope of ADR-0032.
- CONTEXT.md's **Drawing Property Panel** entry is updated to describe the sticky-after-drag behaviour; ADR-0032's "Why session-only panel position" section gains a pointer here.

## Alternatives considered

- **Relative offset (anchor + remembered delta).** Rejected — still moves the panel per selection (see "Why absolute freeze").
- **Persist the position to localStorage.** Out of scope — reopens ADR-0032's per-drawing / per-Code / off-screen-after-resize questions for a cross-reload return the request did not ask for. Session-scope is retained. If a user later wants cross-reload memory, a single `localStorage["replay.drawingPanelPos.v1"]` key (mirroring **Drawing Defaults**) is the natural extension.
- **Per-drawing remembered position.** Rejected — the request ("keep the last position") is singular/global, and per-drawing memory multiplies the off-screen and stale-coordinate edge cases.
