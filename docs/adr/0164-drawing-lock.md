# 0164 — Drawing lock (per-drawing edit/delete freeze)

**Status:** accepted (2026-08-30)
**Extends:** ADR-0032 (Drawing Property Panel — the toolbar this lands in), ADR-0107 (undo snapshot history — the mechanism the gate placement protects)

## Decision

A **Drawing** carries an optional `locked?: boolean`. While it is `true`:

- `useDrawingsStore.update(scope, id, patch)` **refuses** the patch, unless the patch's key set is a subset of `{locked}`.
- `useDrawingsStore.remove(scope, id)` **refuses**.
- `clearAll(scope)` keeps locked drawings and removes only the rest.

The toggle lives in the **Drawing Property Panel** as a 🔒/🔓 button placed after the
divider, left of delete. It is the only control in that toolbar that stays enabled while
locked, because it is the only route back out.

## Enforcement is in the store; the UI gates are affordance only

Six call paths mutate a drawing — the property panel, the `ToolCtx` handed to
`drawing/tools.ts`, the overlay's keyboard handler, the drawing menu, undo/redo, and
import. **All of them funnel through `update` / `remove`.** Putting the check there means
one place to be right; spreading it across the UIs would mean six places to keep right,
and a seventh entry point added later would silently bypass the lock.

The UI gates that *do* exist (disabled panel buttons, `selectTool` not starting a drag,
the eraser passing over, `Delete` not firing, text double-click not opening the editor)
are there so the interface does not lie. A button that depresses and does nothing reads
as a bug; a shape you can grab and drag but that does not move reads as a worse one.
Removing any of those gates changes how it feels, not what happens.

## The gate must run before `recordHistory`

`update` calls `recordHistory` as its first statement. If the lock check ran after it,
every refused edit would push a no-op undo snapshot **and clear the redo stack** — because
`recordHistory` ends with `if (h.redo.length > 0) h.redo = []`.

The failure is silent and badly disguised: clicking a few colours on a locked line has no
visible effect (correct), and then Ctrl+Shift+Z stops working (not correct), with nothing
on screen connecting the two. `remove` already had an existence check ahead of
`recordHistory`; the lock check sits in the same position.

Two tests pin this specifically (`거부된 편집은 redo 스택을 비우지 않는다`,
`거부된 편집은 undo 스택에도 쌓이지 않는다`). Both were red-checked by moving the gates
after `recordHistory` — the observable "locked drawing doesn't change" behaviour is
identical either way, so **without those two tests the wrong placement passes everything.**

## Why the unlock patch is a key-set test, not "contains locked"

`isUnlockOnlyPatch` accepts a patch iff every key is `locked`. A "does it contain
`locked`" test would let `{ locked: false, color: '#fff' }` through, and the colour would
land on a drawing the user never saw unlocked. The subset test makes unlocking a
transition, not a carrier.

Locking is itself an ordinary `update`, so it goes through history and Ctrl+Z undoes it.
A refused patch never reaches the per-kind style sync either — that sync only reads
`color`/`width`/`lineStyle`/`fontSize`/`fillOpacity`, and an unlock patch has none of
them, so a lock toggle cannot leak into `styleByKind`.

## Boundary decisions

**`clearAll` keeps locked drawings.** This is the literal reading of the feature ("지워지지
않는다"). Three consequences follow: `requestClearAll`'s `count` is the *unlocked* count
(a popup promising to delete 5 and deleting 3 is a lie), a scope whose drawings are all
locked opens no popup at all (mirroring the existing "지울 게 없으면 팝업도 없다" rule),
and the confirm copy adds "잠긴 N개는 유지됩니다" only when N > 0.

The undo toast still snapshots the **whole pre-clear array**, and `restore` replaces the
array wholesale, so a surviving locked drawing is not resurrected twice.

`clearAll` also stopped clearing the selection unconditionally: if the selected drawing
survived because it was locked, that selection is still valid, and dropping it would
unmount the panel that holds the unlock button.

**Undo / redo / restore / import ignore the lock.** They replace the array wholesale;
per-item gating is not expressible there, and forcing it would produce "I undid it and
only some of it came back," which is worse than either alternative. The lock defends
against editing, not against time travel.

**Selection stays allowed on a locked drawing.** This is a design invariant, not an
oversight: the property panel is the only unlock affordance and it renders only for a
selected drawing. Gating selection would let a user lock a shape and then have no way to
ever unlock it. Consequently `hitTest`, the overlay's pointer-events gate, and the
empty-click deselect rule are untouched.

**A duplicate (Ctrl+D) is born unlocked.** `cloneWithOffset` spreads the source, so
`locked: true` would carry over and the copy — 14px down-right of a shape the user
deliberately pinned — could be neither moved nor deleted. Duplicating is a request for a
workable shape.

**Selection handles are suppressed on a locked drawing, the halo is not.** Endpoint and
corner handles exist solely to advertise "grab me here"; drawing them on something that
cannot be grabbed is a false affordance, and the user meets it at the most common moment
(selecting a locked shape in order to unlock it). The halo stays, because without it
nothing indicates which drawing the panel's lock button belongs to.

## Storage

No schema version bump. `Wrapper.v` stays `1`: bumping it would make `readKey`'s
`parsed.v !== VERSION` discard **every existing user's drawings**. Absence of `locked`
means unlocked, so every previously-persisted drawing stays valid and editable.

`normalizeItems` collapses anything that is not exactly `true` to absence — a truthy
non-`true` value from a hand-edited export would otherwise read as locked to a human while
`isLocked`'s `=== true` reads it as unlocked. Same reasoning as `Pencil.subX`.

## Consequences

- `DrawingBase` gains `locked?: boolean`; `types.ts` gains `isLocked` / `isUnlockOnlyPatch`.
- `ClearConfirm` gains `lockedCount`; `count` now means *will actually be deleted*.
- `render.ts` gains `showHandles(d, selected)`; three `if (selected)` handle blocks route through it.
- Lock is **not** part of `DrawingStyle` — it is per-drawing state, not a tool preference.
  Putting it in the per-kind defaults would make every new shape born locked.

## Deliberately out of scope

- A "모두 잠금 / 모두 해제" entry in the Drawing Menu.
- A lock badge glyph on the canvas (a locked drawing is identifiable only by selecting it).
- Changing the cursor over a locked drawing. Because the overlay's pointer-events gate
  keeps `'auto'` on a hit (selection must stay possible), a drag on a locked shape does
  nothing at all — it does not pan the chart either. Re-emitting a swallowed pointer event
  to lightweight-charts has no existing mechanism outside the hover path, so this is a
  known rough edge rather than an oversight.
