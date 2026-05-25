# 0030 — Drawing commit clears selection (diverges from Figma pattern)

**Status:** accepted (2026-05-25)

## Decision

When a **Drawing Tool** (hline / trendline / pencil) commits a new **Drawing**, the **Drawing Overlay** reverts the active tool to `select` **and clears `selectedId` to `null`**. The just-created Drawing is rendered in its normal (un-emphasised) style — no halo, no 2× stroke width. Selection emphasis is applied only when the user explicitly clicks an existing Drawing in `select` mode.

The `ToolCtx.commitAndRevert(id)` helper is renamed to `revertToSelectMode()` (no arguments), and the keyboard `Escape` handler routes through the same helper so there is one canonical "return to neutral" code path.

`eraser` is unchanged — it never calls the revert helper (continuous-erase flow). `Drawing` persistence, hit-testing, pane binding, and the `Drawing` glossary entry's "Selectable, draggable, and deletable in select mode" guarantees are unaffected.

## Why

The pre-2026-05-25 implementation followed the Figma/Illustrator convention: a just-created shape is pre-selected so the user can immediately move, delete, or tweak it. `ToolCtx.commitAndRevert(id)` performed `setSelected(id) + setActiveTool('select')` in a single call.

In practice on the Replay Viewer chart this convention produced a visual inconsistency that confused the primary user:

> "그리기를 추가하고 나서 다시 선택 항목으로 reset되잖아. 그런데 그리기를 선택하면 그리기가 두꺼워지는 효과를 내잖아. 선택으로 reset하면 다시 그리기가 두꺼워지는 효과를 없애야 하는거 아니야?"

Paraphrased: the toolbar indicates "select mode," yet a Drawing the user never clicked is rendered with the selection halo. The user's mental model — *"select mode = nothing selected"* — was violated, and the halo on the fresh shape read as visual noise rather than a useful affordance.

Two reasons this charting tool diverges from Figma's convention:

1. **Workflow asymmetry.** In Figma/Illustrator the just-created shape is typically moved or restyled immediately — pre-selection saves a click on the dominant next action. On the Replay Viewer, hlines and trendlines are overwhelmingly "draw and leave" annotations marking a price level or trend. The "move it right after drawing" flow is rare; the "look at it next to the chart" flow is the norm. Pre-selection optimises for the rare case at the cost of the common case.
2. **Selection emphasis is a strong signal.** The halo + 2× stroke is designed to mean *"this is the shape the user is currently working on."* Carrying that signal forward to shapes the user has not explicitly engaged with dilutes it. Reserving emphasis for explicit clicks keeps the signal honest.

## Trade-off accepted

The fast-path "draw → Backspace to undo a misdraw" workflow is lost — undoing a just-drawn shape now requires click-to-select followed by Backspace (two steps instead of one). The user explicitly accepted this trade-off during the brainstorm. A real undo stack (out of scope here) would address the misdraw case more directly and without re-introducing the visual-inconsistency cost.

## Why a single canonical helper

Pre-change, the `Escape` keyboard handler ran `setSelected(null) + setActiveTool('select')` — identical semantics to the new `revertToSelectMode()`. Routing both call sites through one helper prevents a future change to "return to neutral" from updating one path and silently diverging from the other.

## Consequences

- `ToolCtx.commitAndRevert(id)` → `revertToSelectMode()`. Three call sites in `frontend/src/chart/drawing/tools.ts` (hline / trendline / pencil) drop the `id` argument.
- `ToolCtx` interface signature change.
- `tools.test.ts` mocks and assertions update — `.toHaveBeenCalledWith(addedId)` becomes `.toHaveBeenCalledOnce()` since the helper no longer takes an id.
- `Drawing Tool` glossary entry in `CONTEXT.md` updates to reflect the new post-commit state and links to this ADR.
- No change to `Drawing` persistence, hit-test, pane binding, or store schema. `eraser` semantics unchanged.
- Future "real undo stack" work is mentioned but not scoped here.

## Alternatives considered

- **Keep current behaviour (Figma pattern).** Rejected: violates user mental model, dilutes selection-emphasis signal, optimises for the rare workflow.
- **Half-measure: skip the halo but keep `selectedId`.** Rejected: split-brain state where the store says "selected" but render disagrees; would silently break any future code that observes `selectedId` to drive non-visual behaviour (sidebar property panel, keyboard-shortcut targeting, etc.).
- **Defer to a real undo stack.** Worth doing eventually, but the misdraw-recovery cost of the current change is small (one extra click) while the visual-inconsistency cost of the pre-change behaviour was a recurring user complaint. Decoupled scope.
