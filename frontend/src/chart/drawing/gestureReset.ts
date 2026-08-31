// frontend/src/chart/drawing/gestureReset.ts
//
// One place that ends a gesture.
//
// The overlay has THREE exits — Escape (keydown), right-click / Escape's twin
// (`resetGesture`), and pointercancel — and each used to clear its own list of
// refs by hand. Alignment guides showed what that costs: the clear was added to
// `resetGesture` and the Escape path kept its own four lines, so a guide drawn
// mid-creation survived Escape and stayed painted into the next gesture.
//
// What made it stick rather than self-heal: nulling the drafts is exactly what
// disarms every later cleanup. `onPointerMove` and `onPointerUp` both open with
// `if (!draft) return`, so once the drafts are gone the tool can never publish
// the empty guide list that would have cleared the paint. The last chance to
// clean up is the same statement that throws the chance away.
//
// So the list of "what one gesture owns" lives here, once, and every exit calls
// this. Adding a new per-gesture ref means adding it to this type — and then
// all three exits already handle it.

/** A React-style ref bucket, narrowed to what this module does with it. */
type AnyRef = { current: unknown };

export type GestureRefs = {
  trendlineDraft: AnyRef;
  pencilDraft: AnyRef;
  rectDraft: AnyRef;
  measureDraft: AnyRef;
  /** In-flight body/handle drag. */
  dragRef: AnyRef;
  /** Alignment guide lines published for the current drag. */
  alignGuides: AnyRef;
};

export type GestureResetOptions = {
  /**
   * Leave `dragRef` alone. Escape needs this: a live drag still has a captured
   * pointer, and `onPointerUp` reads `dragRef` to decide whether to release it.
   * Clearing it here would strand the capture on the overlay.
   */
  keepDrag?: boolean;
};

/**
 * Null every ref one gesture owns.
 *
 * Returns whether the alignment guides were actually showing, so the caller
 * knows whether a repaint is owed — a redraw on every Escape would be wasted
 * work on the overwhelmingly common case where nothing was drawn.
 */
export function resetGestureRefs(
  refs: GestureRefs,
  opts: GestureResetOptions = {},
): { guidesCleared: boolean } {
  refs.trendlineDraft.current = null;
  refs.pencilDraft.current = null;
  refs.rectDraft.current = null;
  refs.measureDraft.current = null;
  if (!opts.keepDrag) refs.dragRef.current = null;
  const guidesCleared = refs.alignGuides.current !== null;
  refs.alignGuides.current = null;
  return { guidesCleared };
}
