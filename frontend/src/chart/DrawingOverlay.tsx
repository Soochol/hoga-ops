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
import { textFont, measureTextWidth, type GhostPreview } from './drawing/render';
import {
  DrawingsPrimitive,
  type DrawingsSnapshot,
  type DrawingsSource,
} from './DrawingsPrimitive';
import type { Drawing, PaneId, Point } from './drawing/types';
import { INITIAL_STYLE, isDrawingKind } from './drawing/types';
import { snapPoint, snapRealMs, type SnapCandle } from './drawing/snap';
import { refCoords, cloneWithOffset } from './drawing/duplicate';
import type { TimeShift } from './drawing/translate';
import { hitTestDrawings, type HitOptions } from './drawing/hitTest';
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
import { safeUnsubscribe } from './util/safeUnsubscribe';

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
  /** 이 오버레이가 그리는 차트의 (종목, 봉 슬롯) scope — 드로잉 렌더·변이의
   *  귀속 대상 (ADR-0119 C2c-2b: 전역 activeScope 경유 금지). */
  scope: string | null;
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

/** 뷰포트가 마지막으로 움직인 뒤 이만큼 조용하면 팬/줌이 끝난 것으로 보고
 *  hover 프로브를 1회 돌린다. 팬 중에는 프레임마다(~16ms) 변경이 오므로
 *  넉넉하되, 손을 뗀 뒤 체감되지 않을 만큼 짧게. */
const PAN_SETTLE_MS = 120;
/** 뷰포트가 계속 움직이는 동안에도 이 간격마다는 프로브를 한 번 흘려보낸다.
 *  실시간 봉 추가처럼 주기적으로 뷰포트를 건드리는 소스가 있으면 settle 타이머가
 *  영원히 리셋되어 hover 판정이 죽을 수 있다 — 60Hz→4Hz 로 줄이되 0 은 만들지
 *  않는 바닥값. */
const PAN_PROBE_FLOOR_MS = 250;

export default function DrawingOverlay({ chart, axis, paneSeries, scope, onChartHoverPassthrough, bucketMs, candles }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const activeTool = useDrawingsStore((s) => s.activeTool);
  const drawings = useDrawingsStore((s) =>
    scope == null ? EMPTY_DRAWINGS : (s.byScope.get(scope) ?? EMPTY_DRAWINGS),
  );
  // 멀티창 게이트: 전역 키 리스너는 포커스 창의 오버레이만 처리한다(N중복 방지).
  const isFocusedWindow = useIsFocusedWindow();
  const isFocusedRef = useRef(isFocusedWindow);
  isFocusedRef.current = isFocusedWindow;
  // 키다운 클로저(undo/redo/삭제/복제)는 재바인딩되지 않으므로 ref 경유로 최신
  // scope 를 읽는다 — 봉 전환 직후 stale scope 로 다른 슬롯을 변이하면 안 된다.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const selectedId = useDrawingsStore((s) => (scope ? s.selectedByScope.get(scope) ?? null : null));
  const defaults = useDrawingsStore((s) => s.defaults);

  const trendlineDraft = useRef<TrendlineDraft | null>(null);
  const pencilDraft = useRef<PencilDraft | null>(null);
  const rectDraft = useRef<RectDraft | null>(null);
  const measureDraft = useRef<MeasureDraft | null>(null);
  const dragRef = useRef<DragMode | null>(null);
  // One primitive per mounted pane — the actual renderers. See DrawingsPrimitive.ts.
  const primitivesRef = useRef<Map<PaneId, DrawingsPrimitive>>(new Map());
  // hline/vline placement preview, in DOMAIN coordinates (price / realMs) with
  // magnet snapping already resolved, so each pane's primitive can project it.
  // Null when not hovering with those tools.
  const ghostRef = useRef<GhostPreview | null>(null);
  // Last known cursor position in CLIENT coords, tracked unconditionally. The
  // pointer-events gate needs it to settle the moment select mode is entered —
  // without a remembered position it can only wait for the next mousemove, and
  // a cursor sitting still over a shape stays untouchable. See that effect.
  const lastMouseRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // Reassigned every render so primitives always read current state at draw time.
  const snapshotRef = useRef<() => DrawingsSnapshot | null>(() => null);
  // Reassigned every render so the (empty-deps) keydown effect always calls the
  // latest closure over the current coordinate helpers — same pattern as
  // snapshotRef. Set just before the return.
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
    if (scopeRef.current != null) useDrawingsStore.getState().setSelected(scopeRef.current, newId);
  }, []);

  // ── primitive-backed rendering ─────────────────────────────────────────
  // Drawings are painted by lightweight-charts pane primitives, not by a canvas
  // of our own. A canvas repainted from subscribeVisibleLogicalRangeChange →
  // requestAnimationFrame is STRUCTURALLY one frame behind the candles, because
  // that delegate fires from inside lwc's own rAF callback (measured 18.4–20.2ms
  // of lag). See DrawingsPrimitive.ts. This overlay now owns only pointer input,
  // hit-testing and the text editor.

  /** Ask every mounted primitive to repaint — for draft/ghost mutations, which
   *  happen on refs and are therefore invisible to React. */
  const requestRedraw = useCallback(() => {
    for (const prim of primitivesRef.current.values()) prim.requestUpdate();
  }, []);

  // Attach one primitive per mounted pane. deps = [paneSeries] ONLY: folding
  // style or drawing data in here would re-attach on every change and flicker.
  useEffect(() => {
    const attached = new Map<PaneId, DrawingsPrimitive>();
    for (const [paneId, series] of paneSeries) {
      const prim = new DrawingsPrimitive(paneId);
      try {
        series.attachPrimitive(prim);
        attached.set(paneId, prim);
      } catch {
        // series belongs to an already torn-down chart — skip it.
      }
    }
    primitivesRef.current = attached;
    return () => {
      for (const [paneId, prim] of attached) {
        try {
          paneSeries.get(paneId)?.detachPrimitive(prim);
        } catch {
          // chart already gone — nothing to detach from.
        }
      }
      primitivesRef.current = new Map();
    };
  }, [paneSeries]);

  // Reassigned every render so the getter closes over current props/state.
  // Pull-based rather than pushing a snapshot: drafts and the cursor ghost
  // mutate on refs at pointer cadence, and a missed push would paint a stale
  // stroke. See DrawingsSource.
  // Bottom-most mounted pane: it owns the vline time badge, which docks to the
  // bottom of the pane STACK while the line itself is drawn by every pane.
  // Resolved from live pane indices so toggling a pane moves ownership.
  let timeBadgePaneId: PaneId | null = null;
  let bottomPaneIdx = -1;
  for (const paneId of paneSeries.keys()) {
    const idx = paneIdToIndex(paneSeries, paneId);
    if (idx > bottomPaneIdx) {
      bottomPaneIdx = idx;
      timeBadgePaneId = paneId;
    }
  }

  snapshotRef.current = () => ({
    drawings,
    selectedId,
    hiddenAll: defaults.hiddenAll,
    axis,
    timeBadgePaneId,
    future: futureBand,
    bucketMs,
    lastRealMs,
    drafts: {
      trendline: trendlineDraft.current,
      rect: rectDraft.current,
      measure: measureDraft.current,
      pencil: pencilDraft.current,
    },
    draftStyles: {
      trendline: defaults.styleByKind.trendline,
      rect: defaults.styleByKind.rect,
      pencil: defaults.styleByKind.pencil,
    },
    ghost: ghostRef.current,
    onFrame: textEdit ? syncTextEditorPosition : undefined,
  });

  // Wire the source and repaint on every React-visible change. `paneSeries` is
  // a dep so a re-attach re-wires the freshly created primitives.
  useEffect(() => {
    const source: DrawingsSource = () => snapshotRef.current();
    for (const prim of primitivesRef.current.values()) prim.setSource(source);
  }, [paneSeries, drawings, selectedId, defaults, axis, bucketMs, lastRealMs]);

  // Drop the ghost when switching away from the 1-click line tools.
  useEffect(() => {
    if (activeTool !== 'hline' && activeTool !== 'vline' && ghostRef.current) {
      ghostRef.current = null;
      requestRedraw();
    }
  }, [activeTool, requestRedraw]);


  // ── keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreEvent(e.target)) return;
      // 모두 지우기 확인 팝업이 떠 있는 동안엔 차트가 키를 먹지 않는다. 모달이
      // Escape 를 자기 닫기로 쓰는데 여기서도 처리하면 도구까지 함께 풀리고,
      // 무엇보다 팝업 뒤에서 Delete·Alt 단축키가 발화하면 사용자가 보지 못한
      // 변경이 쌓인다.
      if (useDrawingsStore.getState().clearConfirm != null) return;
      // 포커스 창의 오버레이만 전역 키를 처리 — 창마다 리스너가 붙으므로
      // 게이트가 없으면 Ctrl+Z 한 번에 창 수만큼 undo 가 발화한다.
      if (!isFocusedRef.current) return;
      const keyScope = scopeRef.current;
      if (keyScope == null) return;
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
          if (e.shiftKey) useDrawingsStore.getState().redo(keyScope);
          else useDrawingsStore.getState().undo(keyScope);
          e.preventDefault();
          return;
        }
        if (key === 'y') {
          useDrawingsStore.getState().redo(keyScope);
          e.preventDefault();
          return;
        }
        if (key === 'd') {
          duplicateSelectedRef.current();
          e.preventDefault(); // suppress the browser bookmark dialog
          return;
        }
      }

      // Alt+C = 모두 지우기. 도구 전환이 아니라 TOOLS 레지스트리 밖이고
      // matchShortcut() 은 도구 kind 만 돌려주므로 여기서 직접 가른다. 키는
      // 도구 단축키와 같은 규칙(Alt 단독, Ctrl/Meta 조합은 브라우저 몫)을 따르고,
      // 실제 삭제 대신 확인 요청만 낸다 — 게이트는 DrawingClearConfirmHost.
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c') {
        useDrawingsStore.getState().requestClearAll(keyScope);
        e.preventDefault();
        return;
      }

      const shortcutKind = matchShortcut(e);
      if (shortcutKind) {
        useDrawingsStore.getState().setActiveTool(shortcutKind);
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = useDrawingsStore.getState().selectedByScope.get(keyScope) ?? null;
        if (id) {
          useDrawingsStore.getState().remove(keyScope, id);
          e.preventDefault();
        }
      } else if (e.key === 'Escape') {
        // 2단계 Escape. 그리기 도구가 켜져 있고 뭔가 선택돼 있으면 첫 Escape 는
        // **선택만** 푼다 — 도구는 살려 둔다.
        //
        // 왜: 그리기 모드엔 빈 곳 클릭 해제가 없다(`shouldDeselectOnClick` effect 는
        // select 모드에서만 마운트된다). 그런데 선택된 도형은 그리기 모드에서도
        // 잡힌다(tools.ts 의 `withSelectedDrawingDrag` — 방금 그린 것을 끌면 새로
        // 그려지던 버그의 수정). 둘이 겹치면 "방금 그린 도형의 윤곽 위에서 다음 획을
        // 시작하는" 길이 막히는데, 종전 Escape 는 선택과 **도구를 한꺼번에** 풀어서
        // 유일한 탈출구가 "도구까지 버리기" 였다.
        //
        // 도구를 끄는 길은 그대로 있다 — 선택이 없으면 곧장, 있으면 한 번 더.
        // (2026-07-01 계획서의 "Escape remains the way to return to select mode" 는
        // 유효하다. 눌러야 하는 횟수만 상태에 따라 1~2회로 갈린다.)
        const store = useDrawingsStore.getState();
        const hadSelection = (store.selectedByScope.get(keyScope) ?? null) != null;
        store.setSelected(keyScope, null);
        // activeTool 은 스토어에서 읽는다 — 이 keydown 클로저는 재바인딩되지 않아
        // 렌더 시점의 `activeTool` 은 stale 이다.
        if (store.activeTool !== 'select' && hadSelection) return;
        store.setActiveTool('select');
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
  const hitTest = (px: number, py: number, opts?: HitOptions): Drawing | null =>
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
          opts,
        );
  const hitTestAt = (px: number, py: number): Drawing | null => hitTest(px, py);
  /** 그리기 도구가 켜진 채로 "이 도형을 잡았는가" 를 묻는 좁은 판정. 채워진 박스는
   *  테두리로만 잡힌다 — 안쪽은 다음 도형을 그릴 자리로 남긴다. 판정 하나를 두
   *  질문으로 나누는 이유는 hitTest.ts 의 `HitOptions` 주석에 있다. */
  const hitTestOutlineAt = (px: number, py: number): Drawing | null =>
    hitTest(px, py, { boxInterior: false });

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
    if (scope == null) return;
    if (trimmed.length === 0) {
      if (edit.id != null) store.remove(scope, edit.id);
    } else if (edit.id != null) {
      store.update(scope, edit.id, { text: trimmed } as Partial<Drawing>);
    } else {
      const id = nanoid(8);
      const textStyle = store.styleForKind('text');
      store.add(scope, {
        id,
        kind: 'text',
        at: edit.at,
        text: trimmed,
        color: textStyle.color,
        width: textStyle.width,
        lineStyle: textStyle.lineStyle,
        paneId: edit.paneId,
        // Sticky size: a new label inherits the text tool's last-used size.
        // (Re-edits take the `edit.id != null` branch above and keep their own.)
        fontSize: textStyle.fontSize,
      });
      store.setSelected(scope, id);
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
    // Open the editor at the text tool's sticky size so the box matches what
    // will be committed.
    const fontSize = useDrawingsStore.getState().styleForKind('text').fontSize;
    setTextEdit({ id: null, at, paneId, initial: '', fontSize, px, py });
    setTextValue('');
  };

  /**
   * Resolve the hline/vline placement ghost for a cursor position, in DOMAIN
   * coordinates. Magnet snapping is applied HERE rather than in the renderer:
   * the ghost has to commit to exactly the value the click will persist, and
   * the snap needs candles + the chart-global pane lookup that only the overlay
   * has. Each pane's primitive then just projects the result.
   */
  const computeGhost = (px: number, py: number): GhostPreview | null => {
    if (activeTool !== 'hline' && activeTool !== 'vline') return null;
    const cursorPaneId = paneIdAtY(py);
    const style = defaults.styleByKind[activeTool];
    const magnetActive = defaults.magnet && candles != null && candles.length > 0;
    const cursorPrice = canvasYToPrice(py, cursorPaneId);

    if (activeTool === 'hline') {
      let price = cursorPrice;
      let snapped = false;
      // Magnet on the candle pane only — indicator panes have no OHLC to snap to.
      if (magnetActive && cursorPaneId === 'candle') {
        const raw = rawPixelToData(px, py, cursorPaneId);
        if (raw) {
          price = snapPoint(raw, {
            candles: candles!,
            paneId: cursorPaneId,
            priceToY: (pr) => priceToCanvasY(pr, cursorPaneId),
          }).price;
          // Dot whenever magnet is engaged, even if it resolved to the cursor's
          // own level — it signals "this is what will be committed".
          snapped = true;
        }
      }
      return { kind: 'hline', style, cursorPx: px, cursorPaneId, price, realMs: null, snapped };
    }

    const rawMs = rawCanvasXToRealMs(px);
    let realMs = rawMs;
    let snapped = false;
    if (magnetActive && rawMs != null) {
      realMs = snapRealMs(candles!, rawMs);
      snapped = true;
    }
    return { kind: 'vline', style, cursorPx: px, cursorPaneId, price: cursorPrice, realMs, snapped };
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
      hitTestOutlineAt,
      paneIdAtY,
      clampYToPane,
      priceBoundsForPane,
      dragTime,
      drawings,
      selectedId,
      // Narrow the per-kind defaults to the active tool's slot. select/eraser
      // never read this (they don't create shapes), so INITIAL_STYLE is a safe
      // filler there.
      defaults: isDrawingKind(activeTool) ? defaults.styleByKind[activeTool] : INITIAL_STYLE,
      trendlineDraft,
      pencilDraft,
      rectDraft,
      measureDraft,
      dragRef,
      beginTextEdit,
      requestRedraw,
      add: (d) => { if (scope != null) useDrawingsStore.getState().add(scope, d); },
      update: (id, patch) => { if (scope != null) useDrawingsStore.getState().update(scope, id, patch); },
      remove: (id) => { if (scope != null) useDrawingsStore.getState().remove(scope, id); },
      setSelected: (id) => { if (scope != null) useDrawingsStore.getState().setSelected(scope, id); },
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
    // 선택된 도형을 잡아 끄는 중이면 고스트를 접는다 — 그 제스처는 배치가 아니라
    // 이동이고(그리기 도구가 켜진 채로도 선택된 도형은 잡힌다, `tools.ts` 의
    // `withSelectedDrawingDrag`), 커서 밑에서 끌려오는 선 위에 "여기 새로 놓는다"
    // 는 점선이 겹쳐 떠서 둘 중 어느 것이 커밋될지 읽히지 않는다.
    if (activeTool === 'hline' || activeTool === 'vline') {
      ghostRef.current = dragRef.current ? null : computeGhost(px, py);
      requestRedraw();
    }
    TOOLS[activeTool].onPointerMove?.(buildCtx(e));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerUp?.(buildCtx(e));
  };
  const onPointerLeave = () => {
    // Drop the ghost preview when the cursor leaves the chart.
    if (ghostRef.current) {
      ghostRef.current = null;
      requestRedraw();
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

  // Remember where the cursor is at all times (client coords). Deliberately
  // separate from the gating effect below, which only lives while select mode
  // is active — this one must keep recording *during* drawing so the gate has a
  // position to settle against the instant the tool is released. Coordinates
  // only, no layout reads or hit tests, so it stays cheap at OS sampling rates.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouseRef.current = { clientX: e.clientX, clientY: e.clientY };
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // 활성 도구의 커서를 오버레이에 입힌다. `TOOLS[].cursor` 는 도구 정의에 계속
  // 있었지만 아무도 읽지 않는 죽은 필드였고, lightweight-charts 는 커서를 건드리지
  // 않아(실측 `auto`) 차트 위 커서가 도구와 무관하게 늘 화살표였다. 그래서 지금
  // 그리기 모드인지 알려주는 신호가 헤더 버튼 라벨 하나뿐이었다 — 우클릭 해제가
  // 걸렸는지 눈으로 확인할 방법이 없어 "안 풀렸나?" 하고 다시 누르게 만든 배경이다.
  // select 모드에선 오버레이가 도형 위에서만 포인터를 받으므로(위 게이트) 커서도
  // 그때만 보인다 — 즉 "여기 잡을 게 있다" 는 어포던스가 덤으로 붙는다.
  useEffect(() => {
    const container = containerRef.current;
    if (container) container.style.cursor = TOOLS[activeTool].cursor;
  }, [activeTool]);

  // ── pointer-events gating ──────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (activeTool !== 'select') {
      container.style.pointerEvents = 'auto';
      return;
    }
    const ts = chart.timeScale();
    // 팬/줌 스로틀 상태. applyGate 가 lastProbeAt 을 갱신하므로 그보다 앞에 선언한다.
    let lastProbeAt = 0;
    let viewportMoving = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const applyGate = (clientX: number, clientY: number) => {
      lastProbeAt = performance.now();
      const rect = container.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const hit =
        px >= 0 && py >= 0 && px <= rect.width && py <= rect.height
          ? hitTestAt(px, py)
          : null;
      container.style.pointerEvents = hit ? 'auto' : 'none';
    };
    // Settle immediately against the remembered cursor instead of blanking to
    // 'none' and waiting for a mousemove. Right-clicking to leave a drawing
    // tool leaves the cursor parked on the shape just drawn: with the old
    // unconditional 'none', that shape stayed unclickable until the hand moved,
    // so select mode looked like it hadn't engaged and users right-clicked
    // again — the second click did nothing, the incidental mouse jiggle did.
    const last = lastMouseRef.current;
    if (last) applyGate(last.clientX, last.clientY);
    else container.style.pointerEvents = 'none';
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
      // 차트를 팬/줌 하는 중에는 게이트 판정을 건너뛴다. dragRef 는 오버레이
      // 자신의 도형 드래그일 때만 세팅되므로, 차트 팬은 lightweight-charts 가
      // 처리하는 동안 이 가드에 걸리지 않는다 — 즉 팬 내내 프레임마다 hitTest 가
      // 돌고, 연필은 그 안에서 points 전체를 재투영한다(primitive 의 draw 와
      // 합쳐 프레임당 2회). 병목까진 아니어도 순수한 낭비다.
      // PAN_PROBE_FLOOR_MS 는 뷰포트 변경이 끊이지 않는 상황에서도 판정이
      // 완전히 죽지 않게 하는 바닥값.
      if (viewportMoving && performance.now() - lastProbeAt < PAN_PROBE_FLOOR_MS) return;
      pendingEvent = e;
      if (hoverRaf !== null) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = null;
        const ev = pendingEvent;
        pendingEvent = null;
        if (!ev) return;
        applyGate(ev.clientX, ev.clientY);
      });
    };

    // 입력 스로틀 전용 구독 — 여기서 렌더(redraw)를 예약하면 안 된다. lwc 는
    // 이 델리게이트를 자신의 rAF 콜백 "안에서" fire 하므로, 여기서 다시
    // requestAnimationFrame 을 걸면 그 그림은 구조적으로 항상 한 프레임 뒤가
    // 된다(그리기 렌더를 pane primitive 로 옮긴 이유). 이 핸들러는 플래그만
    // 세운다.
    const onViewportMove = () => {
      viewportMoving = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        viewportMoving = false;
        // 팬이 멎으면 마지막 커서 위치로 딱 한 번 판정한다. 이게 없으면 게이트가
        // 팬 시작 시점의 값에 갇혀, 커서 밑으로 들어온 도형을 마우스를 흔들어
        // 깨우기 전까지 잡을 수 없다(반대로 빠져나간 도형은 계속 클릭을 삼킨다).
        // lastMouseRef 는 팬 중에도 갱신되므로 "지금 커서 아래"가 판정된다.
        const settleAt = lastMouseRef.current;
        if (settleAt) applyGate(settleAt.clientX, settleAt.clientY);
      }, PAN_SETTLE_MS);
    };

    window.addEventListener('mousemove', onHover);
    ts.subscribeVisibleLogicalRangeChange(onViewportMove);
    return () => {
      window.removeEventListener('mousemove', onHover);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(onViewportMove));
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (hoverRaf !== null) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = null;
      }
    };
    // hitTestAt closes over drawings / paneSeries; re-bind on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, drawings, paneSeries, axis, chart]);

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
      if (shouldDeselectOnClick(click, rect, hasHit, isOnPropertyPanel) && scope != null) {
        useDrawingsStore.getState().setSelected(scope, null);
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
    if (scope == null) return;
    const id = store.selectedByScope.get(scope) ?? null;
    if (id == null) return;
    const d = store.byScope.get(scope)?.find((x) => x.id === id);
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
    store.add(scope, clone);
    store.setSelected(scope, clone.id);
  };

  // Screen position of the open text editor. Re-projects the anchor so the box
  // tracks the data if the chart shifts; falls back to the raw click pixels so
  // the input ALWAYS appears where the user clicked, even if the anchor can't
  // be projected (empty band, transient scale state).
  const textEditorPoint = (edit: TextEdit) => {
    const x = realMsToCanvasXClamped(edit.at.realMs);
    const y = priceToCanvasY(edit.at.price, edit.paneId);
    return x != null && y != null ? { x, y } : { x: edit.px, y: edit.py };
  };
  const textEditPos = textEdit ? textEditorPoint(textEdit) : null;

  /**
   * Reposition the open editor from inside lwc's frame (via DrawingsSnapshot's
   * `onFrame`). A pan mutates only the time scale — React never re-renders — so
   * the render-time `textEditPos` above would freeze the input where it opened
   * while the candles slid out from under it. Writing `transform` directly
   * skips React and costs no layout.
   */
  const syncTextEditorPosition = () => {
    const el = textInputRef.current;
    const edit = textEditRef.current;
    if (!el || !edit) return;
    const p = textEditorPoint(edit);
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  };

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
            // Positioned by transform, not left/top: `syncTextEditorPosition`
            // rewrites it every lwc frame so the box tracks its anchor during a
            // pan. These are the opening coordinates.
            left: 0,
            top: 0,
            transform: `translate(${textEditPos.x}px, ${textEditPos.y}px)`,
            font: textFont(textEdit.fontSize),
            pointerEvents: 'auto',
            minWidth: '4rem',
          }}
        />
      )}
    </div>
  );
}
