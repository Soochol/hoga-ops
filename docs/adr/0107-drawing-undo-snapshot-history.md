# 0107 — Drawing undo/redo via snapshot history + clearAll safety net

**Status:** accepted (2026-07-12)
**Related:** ADR-0024 (drawing realMs coordinates), ADR-0032 (drawing property panel)

## Decision

The **Drawing** subsystem gains **undo/redo** and a **"모두 지우기" safety net**.

### Snapshot history

`useDrawingsStore` keeps a per-Code undo/redo history as **module-level non-reactive
state** (`histories: Map<code, {undo, redo}>`), mirroring the existing `pendingTimers`
pattern. Undo/redo are driven by the keyboard and the clearAll toast — neither is bound
to a rendered control — so keeping the stacks out of the reactive store avoids a
re-render on every mutation.

Each history entry holds the **pre-mutation array reference**. This is free to capture:
every mutation action (`add`/`update`/`remove`/`clearAll`) already replaces the array
immutably, so the prior reference is a durable past state that is never mutated in place.
Cap: 50 entries per Code.

`undo()` pushes the current array onto `redo` and restores the top of `undo`; `redo()` is
the mirror. A new forward mutation clears `redo`. Both call `queuePersist(code)` so the
250 ms debounced localStorage write stays consistent with in-memory state.

### Drag coalescing (store-only)

A select-drag emits one `update` per `pointermove` — hundreds per gesture. Rather than
wire `beginGesture`/`endGesture` through the overlay's pointer/keyboard/contextmenu/cancel
exits (four fragile reset points), the store **coalesces in time**: consecutive `update`s
to the same drawing id within 500 ms collapse into a single undo step, and each merged
update extends the window. A continuous drag stays one step; only a >500 ms mid-drag pause
starts a new one. This keeps the overlay untouched and the logic unit-testable.

### Keyboard

`Ctrl/Cmd+Z` = undo, `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` = redo, handled in
`DrawingOverlay`'s keydown effect. `matchShortcut()` already reserves Ctrl/Meta combos
(returns null for the Alt tool shortcuts), so there is no collision. macOS `Cmd` is
supported.

### clearAll safety net

`clearAll` is a no-op on an empty list (no history entry, no toast). Otherwise it records
history and surfaces a reactive `clearToast: {code, count, snapshot}`. A host-owned
`DrawingClearToastHost` (mirroring `SignalAlertToastHost`) renders a toast with an
**실행취소** action that calls `restore(code, snapshot)` — a normal, itself-undoable
mutation, **not** an undo-stack pop. Using `restore` rather than `undo()` keeps the
recovery correct even if the user switched Codes or drew more shapes while the toast was
up. Auto-dismisses after 6 s.

`ToastCard` gains an optional `action: {label, onClick}` prop that renders the div variant
(no card-wide button) with a right-aligned action button — avoiding button-in-button
nesting.

## Why not begin/end gesture wiring

The Plan review found three overlay exits that would each have to call `endGesture`
idempotently (pointercancel — which the overlay didn't even handle before this change —
plus contextmenu and Escape). Time-window coalescing in the store removes that coupling
entirely and is covered by a single deterministic test. The only cost is that two rapid
edits to the same shape within 500 ms merge into one undo step, which matches how most
editors behave.
