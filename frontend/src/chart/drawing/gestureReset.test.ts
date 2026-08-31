// frontend/src/chart/drawing/gestureReset.test.ts
import { describe, expect, it } from 'vitest';
import { resetGestureRefs, type GestureRefs } from './gestureReset';

// `??` would resurrect the default for an explicit `null`, which is exactly the
// value these tests need to pass in — so key presence decides, not truthiness.
function refs(over: Partial<Record<keyof GestureRefs, unknown>> = {}): GestureRefs {
  const pick = (k: keyof GestureRefs, fallback: unknown) =>
    k in over ? over[k] : fallback;
  return {
    trendlineDraft: { current: pick('trendlineDraft', { a: 1 }) },
    pencilDraft: { current: pick('pencilDraft', { points: [] }) },
    rectDraft: { current: pick('rectDraft', { a: 1 }) },
    measureDraft: { current: pick('measureDraft', { a: 1 }) },
    dragRef: { current: pick('dragRef', { kind: 'body' }) },
    alignGuides: { current: pick('alignGuides', { guides: [1], color: '#fff' }) },
  };
}

describe('resetGestureRefs', () => {
  it('nulls every ref a gesture owns', () => {
    const r = refs();
    resetGestureRefs(r);
    for (const [name, ref] of Object.entries(r)) {
      expect(ref.current, `${name} should be cleared`).toBeNull();
    }
  });

  it('reports whether guides were showing, so the caller can skip a redraw', () => {
    expect(resetGestureRefs(refs()).guidesCleared).toBe(true);
    expect(resetGestureRefs(refs({ alignGuides: null })).guidesCleared).toBe(false);
  });

  it('keeps the drag when asked — Escape must not strand a captured pointer', () => {
    // onPointerUp reads dragRef to decide whether to release the capture; if
    // Escape nulled it, the release would never run.
    const r = refs();
    resetGestureRefs(r, { keepDrag: true });
    expect(r.dragRef.current).not.toBeNull();
    // …but the guides still go, because a guide belongs to the gesture.
    expect(r.alignGuides.current).toBeNull();
    expect(r.rectDraft.current).toBeNull();
  });
});
