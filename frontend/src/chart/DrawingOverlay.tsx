// frontend/src/chart/DrawingOverlay.tsx
//
// Pane-aware Drawing Overlay. See:
//   - docs/superpowers/specs/2026-05-24-drawing-on-indicator-panes-design.md
//   - docs/adr/0028-drawing-pane-binding.md

import { useCallback, useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import type { IChartApi } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { shouldIgnoreEvent } from '../util/keyboard';
import { useIsFocusedWindow } from '../live/workspace/windowView';
import { useDrawingsStore } from '../state/drawings';
import {
  renderDrawing,
  renderTrendlineDraft,
  renderRectDraft,
  renderMeasureDraft,
  textFont,
  measureTextWidth,
  type ProjectCtx,
} from './drawing/render';
import type { Drawing, PaneId, Point } from './drawing/types';
import { snapPoint, snapRealMs, type SnapCandle } from './drawing/snap';
import { refCoords, cloneWithOffset } from './drawing/duplicate';
import type { TimeShift } from './drawing/translate';
import { hitTestDrawings } from './drawing/hitTest';
import {
  TOOLS,
  matchShortcut,
  type DragMode,
  type PencilDraft,
  type RectDraft,
  type MeasureDraft,
  type ToolCtx,
  type TrendlineDraft,
} from './drawing/tools';
import {
  pixelToData as projPixelToData,
  priceToCanvasY as projPriceToCanvasY,
  canvasYToPrice as projCanvasYToPrice,
  realMsToCanvasX as projRealMsToCanvasX,
  realMsToCanvasXClamped as projRealMsToCanvasXClamped,
  canvasXToRealMs as projCanvasXToRealMs,
  paneIdToIndex,
  paneIdAtY as projPaneIdAtY,
  clampYToPane as projClampYToPane,
  priceBoundsForPane as projPriceBoundsForPane,
  dragTimeDomain,
  type PaneSeriesMap,
} from './drawing/chartCoordinates';

/**
 * Pure predicate for the empty-click deselect flow. Returns true iff the
 * click landed inside the overlay's bounding rect AND did not hit any
 * Drawing AND did not originate from the Drawing Property Panel.
 *
 * The property-panel guard is load-bearing: the panel renders over the
 * chart (its pixels fall inside the overlay's rect by construction), and
 * its `mousedown` events bubble up to the window listener. Without the
 * guard, the user's own mousedown on a panel control (color / thickness /
 * lineStyle trigger) clears `selectedId` before the trigger's onClick
 * fires, unmounting the panel and silently dropping the edit. The delete
 * button worked anyway because it captures `id` in a closure that
 * survives selectedId going null, masking the bug. See ADR-0030 (the
 * deselect rule) and ADR-0032 (the panel that demands this exception).
 */
function shouldDeselectOnClick(
  click: { x: number; y: number },
  rect: { width: number; height: number },
  hasHit: boolean,
  isOnPropertyPanel: boolean,
): boolean {
  if (isOnPropertyPanel) return false;
  const inside =
    click.x >= 0 &&
    click.y >= 0 &&
    click.x <= rect.width &&
    click.y <= rect.height;
  return inside && !hasHit;
}

/** Test-only export of internals. Do not import in production code. */
export const __test__ = { shouldDeselectOnClick };

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  /** 이 오버레이가 그리는 차트의 종목 — 드로잉 렌더·변이의 귀속 대상
   *  (ADR-0119 C2c-2b: 전역 activeCode 경유 금지). */
  code: string | null;
  onChartHoverPassthrough?: (point: { x: number; y: number }) => void;
  /** Active timeframe bucket (ms) — forwarded to the measure tool's readout. */
  bucketMs?: number;
  /** Candles for magnet snapping (ts_ms + OHLC). Empty/absent → no snapping. */
  candles?: readonly SnapCandle[];
};

/** Open text-editor state — a DOM <input> the overlay renders over the canvas.
 *  `id` is null for a new label, or the id of an existing text being re-edited. */
type TextEdit = {
  id: string | null;
  at: Point;
  paneId: PaneId;
  initial: string;
  fontSize: number;
  /** Raw click screen coords (overlay-relative). The input is positioned by
   *  re-projecting `at`, but falls back to these so it ALWAYS appears where the
   *  user clicked even if the projection can't resolve. */
  px: number;
  py: number;
};

const EMPTY_DRAWINGS: Drawing[] = [];

export default function DrawingOverlay({ chart, axis, paneSeries, code, onChartHoverPassthrough, bucketMs, candles }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeTool = useDrawingsStore((s) => s.activeTool);
  const drawings = useDrawingsStore((s) =>
    code == null ? EMPTY_DRAWINGS : (s.byCode.get(code) ?? EMPTY_DRAWINGS),
  );
  // 멀티창 게이트: 전역 키 리스너는 포커스 창의 오버레이만 처리한다(N중복 방지).
  const isFocusedWindow = useIsFocusedWindow();
  const isFocusedRef = useRef(isFocusedWindow);
  isFocusedRef.current = isFocusedWindow;
  const codeRef = useRef(code);
  codeRef.current = code;
  const selectedId = useDrawingsStore((s) => (code ? s.selectedByCode.get(code) ?? null : null));
  const defaults = useDrawingsStore((s) => s.defaults);

  const trendlineDraft = useRef<TrendlineDraft | null>(null);
  const pencilDraft = useRef<PencilDraft | null>(null);
  const rectDraft = useRef<RectDraft | null>(null);
  const measureDraft = useRef<MeasureDraft | null>(null);
  const dragRef = useRef<DragMode | null>(null);
  // Cursor position for the hline/vline placement preview (ghost line following
  // the mouse before the click commits). Null when not hovering with those tools.
  const previewCursorRef = useRef<{ px: number; py: number } | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  // Reassigned every render so the (empty-deps) keydown effect always calls the
  // latest closure over the current coordinate helpers — same pattern as
  // scheduleRef. Set just before the return.
  const duplicateSelectedRef = useRef<() => void>(() => {});

  // Text editing — a DOM <input> rendered over the canvas (IME-safe).
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [textValue, setTextValue] = useState('');
  const textInputRef = useRef<HTMLInputElement>(null);
  // `textEdit` is also mirrored to a ref so the pointer/keyboard closures (which
  // don't re-bind every render) can read the current editing state.
  const textEditRef = useRef<TextEdit | null>(null);
  textEditRef.current = textEdit;

  // Empty-band extrapolation reference: newest candle + timeframe bucket. Lets
  // drawings be created/rendered in the whitespace right of the last candle.
  // Declared here (above the redraw effect, which reads lastRealMs) so it's in
  // scope for both the effect and the coordinate closures below.
  const futureBand =
    candles != null && candles.length > 0 && bucketMs != null && bucketMs > 0
      ? { lastRealMs: candles[candles.length - 1].ts_ms, bucketMs }
      : undefined;
  const lastRealMs = futureBand?.lastRealMs;

  // Legacy post-commit hook. Current drawing tools keep their active tool and
  // call setSelected(id) directly; Escape is the explicit return to select mode.
  const revertToSelectMode = useCallback((newId: string) => {
    useDrawingsStore.getState().setActiveTool('select');
    if (codeRef.current != null) useDrawingsStore.getState().setSelected(codeRef.current, newId);
  }, []);

  // ── redraw loop ────────────────────────────────────────────────────────
  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;
    const draw = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const c = canvas.getContext('2d');
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);

      // Hidden layer: canvas is cleared above, so an early return leaves nothing
      // drawn (the drafts below also skip since no gesture runs while hidden).
      if (defaults.hiddenAll) return;

      const panes = chart.panes();
      const paneTops: number[] = [];
      {
        let acc = 0;
        for (const p of panes) {
          paneTops.push(acc);
          acc += p.getHeight();
        }
      }

      const clipAndRender = (paneId: PaneId, body: (ctx: ProjectCtx) => void) => {
        const idx = paneIdToIndex(paneSeries, paneId);
        if (idx < 0 || idx >= panes.length) return; // pane toggled off → skip
        const top = paneTops[idx];
        const paneH = panes[idx].getHeight();
        c.save();
        c.beginPath();
        c.rect(0, top, w, paneH);
        c.clip();
        const projCtx: ProjectCtx = {
          chart, axis, paneSeries, paneId, width: w, height: h, bucketMs, lastRealMs,
        };
        body(projCtx);
        c.restore();
      };

      // A vline spans every pane, so it renders un-clipped and independent of
      // its origin pane's series being mounted — handled BEFORE the per-drawing
      // pane guard below. Any pane's series will do for the ProjectCtx (vline
      // render ignores it).
      const anyPaneId = drawings.length > 0 ? [...paneSeries.keys()][0] : undefined;
      const renderVlines = () => {
        if (anyPaneId == null) return;
        const projCtx: ProjectCtx = {
          chart, axis, paneSeries, paneId: anyPaneId, width: w, height: h, bucketMs, lastRealMs,
        };
        for (const d of drawings) {
          if (d.kind !== 'vline') continue;
          renderDrawing(c, projCtx, d, d.id === selectedId);
        }
      };

      for (const d of drawings) {
        if (d.kind === 'vline') continue; // rendered separately (un-clipped)
        if (!paneSeries.has(d.paneId)) continue;  // pane absent → silent skip
        clipAndRender(d.paneId, (projCtx) => {
          renderDrawing(c, projCtx, d, d.id === selectedId);
        });
      }
      renderVlines();

      const trendDraft = trendlineDraft.current;
      if (trendDraft?.b) {
        clipAndRender(trendDraft.paneId, (projCtx) => {
          renderTrendlineDraft(c, projCtx, trendDraft, defaults);
        });
      }

      const rDraft = rectDraft.current;
      if (rDraft?.b) {
        clipAndRender(rDraft.paneId, (projCtx) => {
          renderRectDraft(c, projCtx, rDraft.a, rDraft.b!, defaults);
        });
      }

      const mDraft = measureDraft.current;
      if (mDraft?.b) {
        clipAndRender(mDraft.paneId, (projCtx) => {
          renderMeasureDraft(c, projCtx, mDraft.a, mDraft.b!);
        });
      }

      // hline / vline placement preview — a faint dashed ghost line at the cursor
      // that follows the mouse until the click commits. Only for the 1-click line
      // tools (drag tools already show a live draft). When magnet is on the ghost
      // SNAPS to the candle it will commit to, so the snap is visible before the
      // click. A small dot marks the snapped level.
      const preview = previewCursorRef.current;
      const magnetActive = defaults.magnet && candles != null && candles.length > 0;
      if (preview && (activeTool === 'hline' || activeTool === 'vline')) {
        let paneBottom = 0;
        for (const p of panes) paneBottom += p.getHeight();
        let px = preview.px;
        let py = preview.py;
        let snappedDot: { x: number; y: number } | null = null;
        if (magnetActive) {
          if (activeTool === 'hline') {
            const paneId = projPaneIdAtY(chart, paneSeries, preview.py);
            if (paneId === 'candle') {
              const raw = projPixelToData(chart, axis, paneSeries, paneId, preview.px, preview.py, futureBand);
              if (raw) {
                const snapped = snapPoint(raw, {
                  candles: candles!,
                  paneId,
                  priceToY: (pr) => projPriceToCanvasY(chart, paneSeries, paneId, pr),
                });
                const sy = projPriceToCanvasY(chart, paneSeries, paneId, snapped.price);
                if (sy != null) { py = sy; snappedDot = { x: preview.px, y: sy }; }
              }
            }
          } else {
            const rawMs = projCanvasXToRealMs(chart, axis, preview.px, futureBand);
            if (rawMs != null) {
              const sx = projRealMsToCanvasX(chart, axis, snapRealMs(candles!, rawMs), futureBand);
              if (sx != null) { px = sx; snappedDot = { x: sx, y: preview.py }; }
            }
          }
        }
        c.save();
        c.strokeStyle = defaults.color;
        c.globalAlpha = 0.6;
        c.lineWidth = defaults.width;
        c.setLineDash([5, 4]);
        c.beginPath();
        if (activeTool === 'hline') {
          c.moveTo(0, py);
          c.lineTo(w, py);
        } else {
          c.moveTo(px, 0);
          c.lineTo(px, paneBottom);
        }
        c.stroke();
        c.restore();
        if (snappedDot) {
          c.save();
          c.fillStyle = defaults.color;
          c.beginPath();
          c.arc(snappedDot.x, snappedDot.y, 3.5, 0, Math.PI * 2);
          c.fill();
          c.restore();
        }
      }

      // Live pencil draft preview — clipped to its origin pane.
      const draft = pencilDraft.current;
      if (draft && draft.points.length >= 2) {
        clipAndRender(draft.paneId, (projCtx) => {
          renderDrawing(
            c,
            projCtx,
            {
              id: '__draft__',
              kind: 'pencil',
              points: draft.points,
              color: defaults.color,
              width: defaults.width,
              lineStyle: defaults.lineStyle,
              paneId: draft.paneId,
            },
            false,
          );
        });
      }
    };

    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro =
      containerRef.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart, axis, paneSeries, drawings, selectedId, code, defaults, bucketMs, lastRealMs, activeTool]);

  // ── keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreEvent(e.target)) return;
      // 포커스 창의 오버레이만 전역 키를 처리 — 창마다 리스너가 붙으므로
      // 게이트가 없으면 Ctrl+Z 한 번에 창 수만큼 undo 가 발화한다.
      if (!isFocusedRef.current) return;
      const keyCode = codeRef.current;
      if (keyCode == null) return;
      if (
        dragRef.current ||
        trendlineDraft.current ||
        pencilDraft.current ||
        rectDraft.current ||
        measureDraft.current
      )
        return;

      // Undo/Redo (ADR-0107). Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y =
      // redo. matchShortcut() reserves ctrl/meta combos (returns null), so
      // there's no collision with the Alt tool shortcuts below.
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          if (e.shiftKey) useDrawingsStore.getState().redo(keyCode);
          else useDrawingsStore.getState().undo(keyCode);
          e.preventDefault();
          return;
        }
        if (key === 'y') {
          useDrawingsStore.getState().redo(keyCode);
          e.preventDefault();
          return;
        }
        if (key === 'd') {
          duplicateSelectedRef.current();
          e.preventDefault(); // suppress the browser bookmark dialog
          return;
        }
      }

      const shortcutKind = matchShortcut(e);
      if (shortcutKind) {
        useDrawingsStore.getState().setActiveTool(shortcutKind);
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = useDrawingsStore.getState().selectedByCode.get(keyCode) ?? null;
        if (id) {
          useDrawingsStore.getState().remove(keyCode, id);
          e.preventDefault();
        }
      } else if (e.key === 'Escape') {
        useDrawingsStore.getState().setSelected(keyCode, null);
        useDrawingsStore.getState().setActiveTool('select');
        trendlineDraft.current = null;
        pencilDraft.current = null;
        rectDraft.current = null;
        measureDraft.current = null;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Coordinate helpers — pane-aware closures. `magnetActive` gates the snap; the
  // per-event Ctrl override is applied in buildCtx (which owns the event).
  const magnetOn = defaults.magnet && candles != null && candles.length > 0;
  const rawPixelToData = (px: number, py: number, paneId: PaneId) =>
    projPixelToData(chart, axis, paneSeries, paneId, px, py, futureBand);
  const realMsToCanvasX = (realMs: number) => projRealMsToCanvasX(chart, axis, realMs, futureBand);
  const realMsToCanvasXClamped = (realMs: number) =>
    projRealMsToCanvasXClamped(chart, axis, realMs, futureBand);
  const rawCanvasXToRealMs = (px: number) => projCanvasXToRealMs(chart, axis, px, futureBand);
  const priceToCanvasY = (price: number, paneId: PaneId) =>
    projPriceToCanvasY(chart, paneSeries, paneId, price);

  // Magnet-aware variants: snap the raw result to the nearest candle when magnet
  // is on and the override (Ctrl) isn't held. Pencil opts out (see buildCtx).
  const pixelToDataSnapped = (px: number, py: number, paneId: PaneId, snap: boolean) => {
    const raw = rawPixelToData(px, py, paneId);
    if (!raw || !snap || !magnetOn) return raw;
    return snapPoint(raw, {
      candles: candles!,
      paneId,
      priceToY: (p) => priceToCanvasY(p, paneId),
    });
  };
  const canvasXToRealMsSnapped = (px: number, snap: boolean) => {
    const raw = rawCanvasXToRealMs(px);
    if (raw == null || !snap || !magnetOn) return raw;
    return snapRealMs(candles!, raw);
  };
  const canvasYToPrice = (py: number, paneId: PaneId) =>
    projCanvasYToPrice(chart, paneSeries, paneId, py);
  const paneIdAtY = (py: number) => projPaneIdAtY(chart, paneSeries, py);
  const clampYToPane = (paneId: PaneId, py: number) =>
    projClampYToPane(chart, paneSeries, paneId, py);

  const priceBoundsForPane = (paneId: PaneId) =>
    projPriceBoundsForPane(chart, paneSeries, paneId);

  // Gap-aware virtual-time domain for body-drag translation (see DragTimeDomain).
  const dragTime = dragTimeDomain(axis, futureBand);

  // SR-5: the kind-dispatch hit geometry lives in the pure hitTestDrawings
  // kernel (hitTest.ts, unit-tested with stub coords). This wrapper just binds
  // the chart-aware coordinate closures.
  const hitTestAt = (px: number, py: number): Drawing | null =>
    // Hidden drawings are non-interactive — no hover gating, no selection.
    defaults.hiddenAll
      ? null
      : hitTestDrawings(
          {
            realMsToCanvasX,
            realMsToCanvasXClamped,
            priceToCanvasY,
            paneIdAtY: (y) => projPaneIdAtY(chart, paneSeries, y),
            canvasWidth: containerRef.current?.clientWidth ?? 0,
            measureTextWidth,
          },
          drawings,
          px,
          py,
        );

  // ── text editing ───────────────────────────────────────────────────────
  // Commit the in-flight text edit. Idempotent: reads textEditRef and nulls it,
  // so a stray second call (blur after a commit) is a no-op. Empty → discard a
  // new label, or delete an existing one edited down to blank.
  const commitText = (value: string) => {
    const edit = textEditRef.current;
    if (!edit) return;
    // Null the ref immediately so a racing second call (e.g. Enter→blur firing
    // after this one) is a no-op instead of double-committing.
    textEditRef.current = null;
    const trimmed = value.trim();
    const store = useDrawingsStore.getState();
    if (code == null) return;
    if (trimmed.length === 0) {
      if (edit.id != null) store.remove(code, edit.id);
    } else if (edit.id != null) {
      store.update(code, edit.id, { text: trimmed } as Partial<Drawing>);
    } else {
      const id = nanoid(8);
      store.add(code, {
        id,
        kind: 'text',
        at: edit.at,
        text: trimmed,
        color: store.defaults.color,
        width: store.defaults.width,
        lineStyle: store.defaults.lineStyle,
        paneId: edit.paneId,
        // Sticky size: a new label inherits the last-committed size. (Re-edits
        // take the `edit.id != null` branch above and keep their own size.)
        fontSize: store.defaults.fontSize,
      });
      store.setSelected(code, id);
    }
    setTextEdit(null);
    setTextValue('');
  };

  const cancelText = () => {
    // Null the ref first so the input's onBlur (which fires as it unmounts)
    // finds no edit and doesn't commit what the user just cancelled.
    textEditRef.current = null;
    setTextEdit(null);
    setTextValue('');
  };

  const beginTextEdit = (at: Point, paneId: PaneId, px: number, py: number) => {
    // If an edit is already open, this click commits it and is consumed — the
    // user clicks again to place the next label. Prevents a blur/pointerdown
    // race from spawning a second draft over the first.
    if (textEditRef.current) {
      commitText(textInputRef.current?.value ?? textValue);
      return;
    }
    // Open the editor at the sticky default size so the box matches what will
    // be committed.
    const fontSize = useDrawingsStore.getState().defaults.fontSize;
    setTextEdit({ id: null, at, paneId, initial: '', fontSize, px, py });
    setTextValue('');
  };

  const buildCtx = (e: React.PointerEvent<HTMLDivElement>): ToolCtx => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const target = e.currentTarget as HTMLDivElement;
    // Snap applies to every tool except pencil; Ctrl/Meta held on the event
    // temporarily overrides magnet off.
    const snap = activeTool !== 'pencil' && !(e.ctrlKey || e.metaKey);
    return {
      px: e.clientX - rect.left,
      py: e.clientY - rect.top,
      pointerId: e.pointerId,
      shiftKey: e.shiftKey,
      capturePointer: () => target.setPointerCapture(e.pointerId),
      releasePointer: () => target.releasePointerCapture(e.pointerId),
      pixelToData: (px, py, paneId) => pixelToDataSnapped(px, py, paneId, snap),
      realMsToCanvasX,
      canvasXToRealMs: (px) => canvasXToRealMsSnapped(px, snap),
      priceToCanvasY,
      canvasYToPrice,
      hitTestAt,
      paneIdAtY,
      clampYToPane,
      priceBoundsForPane,
      dragTime,
      drawings,
      selectedId,
      defaults,
      trendlineDraft,
      pencilDraft,
      rectDraft,
      measureDraft,
      dragRef,
      beginTextEdit,
      requestRedraw: () => scheduleRef.current(),
      add: (d) => { if (code != null) useDrawingsStore.getState().add(code, d); },
      update: (id, patch) => { if (code != null) useDrawingsStore.getState().update(code, id, patch); },
      remove: (id) => { if (code != null) useDrawingsStore.getState().remove(code, id); },
      setSelected: (id) => { if (code != null) useDrawingsStore.getState().setSelected(code, id); },
      revertToSelectMode,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (activeTool === 'text') {
      // Cancel the gesture's default actions (Pointer Events: a canceled
      // pointerdown suppresses the compatibility mousedown and its
      // focus-change default). Without this, a REAL click's native mousedown
      // — fired ~1ms after our handler opens and focuses the editor — moves
      // focus back to the (non-focusable) overlay, blurring the input, whose
      // onBlur commits the empty value and unmounts it. The editor lived <3ms
      // and looked like it never appeared. Synthetic-event tests never fire
      // native default actions, which is why they all passed. Captured
      // trusted-event kill sequence:
      //   pointerdown → focusin INPUT → mousedown → focusout INPUT
      e.preventDefault();
    }
    TOOLS[activeTool].onPointerDown?.(buildCtx(e));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    onChartHoverPassthrough?.({ x: px, y: py });
    // Track the cursor for the hline/vline ghost-line preview and repaint.
    if (activeTool === 'hline' || activeTool === 'vline') {
      previewCursorRef.current = { px, py };
      scheduleRef.current();
    }
    TOOLS[activeTool].onPointerMove?.(buildCtx(e));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerUp?.(buildCtx(e));
  };
  const onPointerLeave = () => {
    // Drop the ghost preview when the cursor leaves the chart.
    if (previewCursorRef.current) {
      previewCursorRef.current = null;
      scheduleRef.current();
    }
  };
  // Abandon any in-flight gesture. Shared by pointercancel (touch interrupted,
  // pointer lost) and contextmenu. Keep this in sync with the draft refs the
  // tools own — a new draft-bearing tool must reset here too.
  const resetGesture = () => {
    trendlineDraft.current = null;
    pencilDraft.current = null;
    rectDraft.current = null;
    measureDraft.current = null;
    dragRef.current = null;
  };
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    resetGesture();
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released — ignore.
    }
  };
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    resetGesture();
    useDrawingsStore.getState().setActiveTool('select');
  };
  // Double-click an existing text label to re-open its editor in place.
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = hitTestAt(px, py);
    if (hit && hit.kind === 'text') {
      setTextEdit({ id: hit.id, at: hit.at, paneId: hit.paneId, initial: hit.text, fontSize: hit.fontSize, px, py });
      setTextValue(hit.text);
      e.preventDefault();
    }
  };

  // ── pointer-events gating ──────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (activeTool !== 'select') {
      container.style.pointerEvents = 'auto';
      return;
    }
    container.style.pointerEvents = 'none';
    // rAF-coalesce the global mousemove. Native mousemove fires at the OS
    // sampling rate (can exceed 1 kHz on high-poll-rate mice). Without
    // throttling, every event paid getBoundingClientRect() (forces layout),
    // hitTestAt (iterates all drawings), and a pointer-events style write
    // — all wasted between paints since the user can't perceive sub-frame
    // hit changes. One probe per frame is enough.
    let hoverRaf: number | null = null;
    let pendingEvent: MouseEvent | null = null;
    const onHover = (e: MouseEvent) => {
      if (dragRef.current) return;
      pendingEvent = e;
      if (hoverRaf !== null) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = null;
        const ev = pendingEvent;
        pendingEvent = null;
        if (!ev) return;
        const rect = container.getBoundingClientRect();
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const hit =
          px >= 0 && py >= 0 && px <= rect.width && py <= rect.height
            ? hitTestAt(px, py)
            : null;
        container.style.pointerEvents = hit ? 'auto' : 'none';
      });
    };
    window.addEventListener('mousemove', onHover);
    return () => {
      window.removeEventListener('mousemove', onHover);
      if (hoverRaf !== null) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = null;
      }
    };
    // hitTestAt closes over drawings / paneSeries; re-bind on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, drawings, paneSeries, axis]);

  // ── empty-click deselect ───────────────────────────────────────────────
  // When something is selected and the user clicks empty chart space,
  // clear the selection. Runs in parallel with chart pan/zoom — never
  // calls preventDefault or stopPropagation. Mounted only while there's
  // something to deselect, so the global listener is short-lived.
  // See ADR-0030 (companion decision).
  useEffect(() => {
    if (activeTool !== 'select' || selectedId == null) return;
    const container = containerRef.current;
    if (!container) return;
    const onWindowMouseDown = (e: MouseEvent) => {
      if (dragRef.current) return;
      const isOnPropertyPanel =
        e.target instanceof Node &&
        !!document.querySelector('[data-drawing-property-panel]')?.contains(e.target);
      const rect = container.getBoundingClientRect();
      const click = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const hasHit = !!hitTestAt(click.x, click.y);
      if (shouldDeselectOnClick(click, rect, hasHit, isOnPropertyPanel) && code != null) {
        useDrawingsStore.getState().setSelected(code, null);
      }
    };
    window.addEventListener('mousedown', onWindowMouseDown);
    return () => window.removeEventListener('mousedown', onWindowMouseDown);
    // hitTestAt closes over drawings / paneSeries / axis — re-bind on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, selectedId, drawings, paneSeries, axis]);

  // Focus + select the text input whenever an edit opens.
  useEffect(() => {
    if (textEdit == null) return;
    const el = textInputRef.current;
    if (el == null) return;
    el.focus();
    el.select();
  }, [textEdit]);

  // Auto-unhide when the user *switches to* a drawing tool — drawing while the
  // layer is hidden would be confusing (the new shape wouldn't appear). Keyed
  // on activeTool transitions ONLY (hiddenAll read fresh): otherwise toggling
  // hide while a drawing tool is active would instantly revert itself.
  useEffect(() => {
    if (activeTool !== 'select' && useDrawingsStore.getState().defaults.hiddenAll) {
      useDrawingsStore.getState().setDefaults({ hiddenAll: false });
    }
  }, [activeTool]);

  // Duplicate the selected drawing with a ~14px down-right offset (derived from
  // the current coordinate closures so the offset is visually constant across
  // panes/timeframes). Reassigned each render; called from the keydown effect.
  duplicateSelectedRef.current = () => {
    const store = useDrawingsStore.getState();
    if (code == null) return;
    const id = store.selectedByCode.get(code) ?? null;
    if (id == null) return;
    const d = store.byCode.get(code)?.find((x) => x.id === id);
    if (d == null) return;
    const OFFSET_PX = 14;
    const ref = refCoords(d);
    // Horizontal offset in VIRTUAL ms, applied per-vertex through dragTime
    // (same domain as body-drag). The ref vertex is pixel-derived and thus
    // always lands on-axis, but a flat real-ms delta would strand the OTHER
    // vertices in an inter-session gap whenever the ref's +14px crosses a
    // session boundary (clone stretched to the canvas edge near the close).
    let shiftMs: TimeShift = 0;
    let dPrice = 0;
    if (ref.realMs != null) {
      const x = realMsToCanvasX(ref.realMs);
      if (x != null) {
        const shifted = rawCanvasXToRealMs(x + OFFSET_PX);
        if (shifted != null) {
          const dVirtual = dragTime.toVirtual(shifted) - dragTime.toVirtual(ref.realMs);
          shiftMs = (ms) => dragTime.toReal(dragTime.toVirtual(ms) + dVirtual);
        }
      }
    }
    if (ref.price != null) {
      const y = priceToCanvasY(ref.price, d.paneId);
      if (y != null) {
        const shifted = canvasYToPrice(y + OFFSET_PX, d.paneId);
        if (shifted != null) dPrice = shifted - ref.price;
      }
    }
    const clone = cloneWithOffset(d, shiftMs, dPrice);
    store.add(code, clone);
    store.setSelected(code, clone.id);
  };

  // Screen position of the open text editor. Re-projects the anchor so the box
  // tracks the data if the chart shifts; falls back to the raw click pixels so
  // the input ALWAYS appears where the user clicked, even if the anchor can't
  // be projected (empty band, transient scale state).
  const textEditPos = textEdit
    ? (() => {
        const x = realMsToCanvasXClamped(textEdit.at.realMs);
        const y = priceToCanvasY(textEdit.at.price, textEdit.paneId);
        return x != null && y != null ? { x, y } : { x: textEdit.px, y: textEdit.py };
      })()
    : null;

  return (
    <div
      ref={containerRef}
      data-drawing-overlay
      className="absolute inset-0 z-20"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
      {textEdit && textEditPos && (
        <input
          ref={textInputRef}
          data-drawing-text-input
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onBlur={(e) => commitText(e.currentTarget.value)}
          // Pointer events inside the input must NOT reach the overlay's tool
          // dispatch. Without these stops, clicking the box itself bubbled to
          // textTool.onPointerDown → beginTextEdit saw an open edit → committed
          // the (empty) value → the input vanished on the spot. Real users
          // click the box to start typing (or double-click to place), so the
          // editor looked like it "never appeared". Same leak let select-mode
          // re-edits start a body-drag on the underlying text drawing while
          // selecting characters.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // Blur instead of committing inline. blur() first ends any active
              // IME composition (한글 조합 확정) — committing the composed char to
              // the input value — then fires onBlur, which commits. This is the
              // single-Enter CJK path: the old `!isComposing` inline-commit
              // swallowed the composition-confirming Enter and demanded a second.
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelText();
            }
            // Swallow other keys so global drawing shortcuts don't fire while typing.
            e.stopPropagation();
          }}
          placeholder="텍스트…"
          className="absolute z-30 rounded border border-accent bg-bg-card px-1 py-0 text-fg outline-none"
          style={{
            left: textEditPos.x,
            top: textEditPos.y,
            font: textFont(textEdit.fontSize),
            pointerEvents: 'auto',
            minWidth: '4rem',
          }}
        />
      )}
    </div>
  );
}
