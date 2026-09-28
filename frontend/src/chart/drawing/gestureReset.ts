// frontend/src/chart/drawing/gestureReset.ts
//
// One place that ends a gesture.
//
// Escape, right-click and pointercancel share the same draft cleanup.
// Captured drags are kept on Escape so pointer-up can release the capture.

/** A React-style ref bucket, narrowed to what this module does with it. */
type AnyRef = { current: unknown };

export type GestureRefs = {
  trendlineDraft: AnyRef;
  pencilDraft: AnyRef;
  rectDraft: AnyRef;
  measureDraft: AnyRef;
  /** In-flight 마퀴 (Shift+드래그 선택 상자). */
  marqueeDraft: AnyRef;
  /** In-flight body/handle drag. */
  dragRef: AnyRef;
};

export type GestureResetOptions = {
  /**
   * Leave the refs of a POINTER-HOLDING gesture alone — `dragRef` and
   * `marqueeDraft`. Escape needs this: both hold a captured pointer, and
   * `onPointerUp` reads them to decide whether to release it. Clearing them
   * here would strand the capture on the overlay.
   */
  keepDrag?: boolean;
};

/** Null gesture refs and report whether the DOM marquee needs a repaint. */
export function resetGestureRefs(
  refs: GestureRefs,
  opts: GestureResetOptions = {},
): { marqueeCleared: boolean } {
  refs.trendlineDraft.current = null;
  refs.pencilDraft.current = null;
  refs.rectDraft.current = null;
  refs.measureDraft.current = null;
  const marqueeCleared = !opts.keepDrag && refs.marqueeDraft.current !== null;
  if (!opts.keepDrag) {
    refs.marqueeDraft.current = null;
    refs.dragRef.current = null;
  }
  return { marqueeCleared };
}
