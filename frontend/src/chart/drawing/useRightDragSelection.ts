import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { marqueeRect, type MarqueeRect } from './hitTest';
import type { MarqueeDraft } from './tools';

export const RIGHT_DRAG_SLOP_PX = 5;

type Options = {
  containerRef: RefObject<HTMLDivElement>;
  enabled: boolean;
  scope: string | null;
  draft: MutableRefObject<MarqueeDraft | null>;
  preview: MutableRefObject<ReadonlySet<string> | null>;
  bounds(): MarqueeRect | null;
  selected(): readonly string[];
  intersecting(rect: MarqueeRect): readonly string[];
  commit(ids: readonly string[]): void;
  click(): void;
  redraw(): void;
};

/** Listen above the pass-through overlay: empty chart space belongs to lwc.
 * Only right presses on the chart canvas enter here; normal pan and UI controls
 * keep their existing input path. Window listeners also cover lost capture. */
export function useRightDragSelection(options: Options) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });

  useEffect(() => {
    const container = latest.current.containerRef.current;
    const surface = container?.parentElement;
    if (!container || !surface || !options.enabled) return;
    let gesture: {
      pointerId: number;
      bounds: MarqueeRect;
      additive: boolean;
      original: readonly string[];
      moved: boolean;
      pointerEvents: string;
    } | null = null;
    let suppressMenu = false;

    const finish = () => {
      if (!gesture) return;
      const { pointerId, pointerEvents } = gesture;
      gesture = null;
      latest.current.draft.current = null;
      latest.current.preview.current = null;
      container.style.pointerEvents = pointerEvents;
      try { container.releasePointerCapture(pointerId); } catch { /* Already lost. */ }
      latest.current.redraw();
    };
    const update = (e: PointerEvent) => {
      const draft = latest.current.draft.current;
      if (!gesture || !draft) return;
      const rect = container.getBoundingClientRect();
      const { bounds } = gesture;
      draft.bx = Math.max(bounds.x1, Math.min(bounds.x2, e.clientX - rect.left));
      draft.by = Math.max(bounds.y1, Math.min(bounds.y2, e.clientY - rect.top));
      gesture.moved ||= Math.max(Math.abs(draft.bx - draft.ax), Math.abs(draft.by - draft.ay)) >= RIGHT_DRAG_SLOP_PX;
      if (gesture.moved) {
        latest.current.preview.current = new Set([
          ...(gesture.additive ? gesture.original : []),
          ...latest.current.intersecting(marqueeRect(draft.ax, draft.ay, draft.bx, draft.by)),
        ]);
      }
      latest.current.redraw();
    };
    const onDown = (e: PointerEvent) => {
      suppressMenu = false;
      if (e.button !== 2 || e.buttons !== 2 || gesture) return;
      if (e.target !== container && !(e.target instanceof HTMLCanvasElement)) return;
      const bounds = latest.current.bounds();
      if (!bounds) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (x < bounds.x1 || x > bounds.x2 || y < bounds.y1 || y > bounds.y2) return;
      gesture = { pointerId: e.pointerId, bounds, additive: e.shiftKey,
        original: latest.current.selected(), moved: false, pointerEvents: container.style.pointerEvents };
      latest.current.draft.current = { ax: x, ay: y, bx: x, by: y, pointerId: e.pointerId, rightButton: true };
      suppressMenu = true;
      container.style.pointerEvents = 'auto';
      try { container.setPointerCapture(e.pointerId); } catch { /* Window listeners remain active. */ }
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      if (!(e.buttons & 2)) { finish(); return; }
      update(e);
      e.preventDefault();
      e.stopPropagation();
    };
    const onUp = (e: PointerEvent) => {
      if (!gesture || e.pointerId !== gesture.pointerId || e.button !== 2) return;
      update(e);
      const ids = latest.current.preview.current;
      const moved = gesture.moved;
      finish();
      if (moved && ids) latest.current.commit([...ids]);
      else latest.current.click();
      e.preventDefault();
      e.stopPropagation();
    };
    const onCancel = (e: PointerEvent) => {
      if (gesture?.pointerId === e.pointerId) finish();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!gesture || e.key !== 'Escape') return;
      finish();
      e.preventDefault();
      e.stopPropagation();
    };
    const onMenu = (e: MouseEvent) => {
      // Linux can emit contextmenu on press; Windows can emit it on release.
      // Neither may cancel an in-flight box or clear its committed selection.
      if (!gesture && !(suppressMenu && e.target instanceof Node && surface.contains(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
      if (!gesture) suppressMenu = false;
    };
    surface.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    container.addEventListener('lostpointercapture', onCancel);
    window.addEventListener('contextmenu', onMenu, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', finish);
    return () => {
      finish();
      surface.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      container.removeEventListener('lostpointercapture', onCancel);
      window.removeEventListener('contextmenu', onMenu, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', finish);
    };
  }, [options.enabled, options.scope, options.containerRef]);
}
