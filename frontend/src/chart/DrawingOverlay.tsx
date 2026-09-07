// frontend/src/chart/DrawingOverlay.tsx
//
// Pane-aware Drawing Overlay. See:
//   - docs/superpowers/specs/2026-05-24-drawing-on-indicator-panes-design.md
//   - docs/adr/0028-drawing-pane-binding.md

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import type { IChartApi } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { shouldIgnoreEvent } from '../util/keyboard';
import { useIsFocusedWindow } from '../live/workspace/windowView';
import { EMPTY_SELECTION, useDrawingsStore } from '../state/drawings';
import { textFont, measureTextWidth, type GhostPreview } from './drawing/render';
import {
  DrawingsPrimitive,
  type DrawingsSnapshot,
  type DrawingsSource,
} from './DrawingsPrimitive';
import type { Drawing, PaneId, Point } from './drawing/types';
import { INITIAL_STYLE, isDrawingKind, isLocked } from './drawing/types';
import { snapPoint, snapRealMs, type SnapCandle } from './drawing/snap';
import type { AlignGuide } from './drawing/alignSnap';
import { resetGestureRefs, type GestureRefs } from './drawing/gestureReset';
import { refCoords, cloneWithOffset } from './drawing/duplicate';
import { planGroupTranslate, type TimeShift } from './drawing/translate';
import {
  drawingsInRect, hitTestDrawings, marqueeRect, unlockedOnly,
  type HitCoord, type MarqueeRect,
} from './drawing/hitTest';
import {
  TOOLS,
  matchShortcut,
  type DragMode,
  type PencilDraft,
  type RectDraft,
  type MarqueeDraft,
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
  onAxisCandles,
  futureBandFor,
  canvasXToRealMs as projCanvasXToRealMs,
  paneIdToIndex,
  paneIdAtY as projPaneIdAtY,
  clampYToPane as projClampYToPane,
  priceBoundsForPane as projPriceBoundsForPane,
  dragBarDomain,
  barPitchPx,
  type PaneSeriesMap,
} from './drawing/chartCoordinates';
import { safeUnsubscribe } from './util/safeUnsubscribe';

/** What the window-level mousedown listener should do in select mode. */
export type SelectModeMouseDown = 'deselect' | 'select-locked' | 'none';

/**
 * Pure decision for the window-level mousedown listener in select mode.
 *
 * Two jobs, one predicate, because they are decided by the same three facts
 * (where the click landed, what it hit, whether it came from the panel):
 *
 *  - `'deselect'` — the empty-click rule (ADR-0030): a click inside the
 *    overlay's rect that hit no Drawing clears the selection.
 *  - `'select-locked'` — the click hit a locked Drawing AND nothing unlocked.
 *    The overlay does not receive that click at all (the pointer-events gate
 *    deliberately leaves it `'none'` there so the chart can pan), so
 *    `selectTool` never runs and this listener is the only thing that can
 *    select it. Without this branch a locked drawing could never be selected,
 *    and therefore never unlocked — the panel's lock button is the only unlock
 *    route (ADR-0164).
 *  - `'none'` — everything else, including any click where an UNLOCKED Drawing
 *    is under the cursor: there the overlay is `'auto'` and
 *    `selectTool.onPointerDown` owns the selection.
 *
 * `unlockedHit` is what splits the last two, and it is the SAME value the
 * pointer-events gate keys on — that is the point. Deciding from `hit` alone
 * breaks when a locked drawing overlaps an unlocked one: `hit` is the locked
 * one (topmost wins), so this listener would fire `'select-locked'` on a click
 * the overlay is already handling. `pointerdown` precedes `mousedown`, so the
 * overlay's selection of the live shape would land first and then be
 * overwritten here — the user grabs one shape and watches another get
 * selected. Both sides keying on the gate's own question keeps their territory
 * split exactly at the gate, with no overlap.
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
 *
 * The inside-rect test is also what keeps this multi-window safe: the listener
 * is on `window`, so every chart window's copy sees every click. Only the one
 * whose rect contains the click acts, so a click in window A can never write a
 * selection into window B's scope (the misattribution ADR-0119 C2c-2b exists
 * to prevent).
 */
function resolveSelectModeMouseDown(
  click: { x: number; y: number },
  rect: { width: number; height: number },
  hit: Drawing | null,
  unlockedHit: Drawing | null,
  isOnPropertyPanel: boolean,
  shiftKey: boolean,
): SelectModeMouseDown {
  if (isOnPropertyPanel) return 'none';
  // Shift 가 눌린 클릭은 **선택을 더하는 제스처**이고, 그 처리자는 오버레이다
  // (토글 또는 마퀴 시작). 이 리스너는 window 에 붙어 있어 게이트와 무관하게
  // 모든 mousedown 을 보므로, 여기서 걸러 내지 않으면 마퀴를 시작하려고 빈 곳을
  // 누르는 순간 'deselect' 가 나가 **애써 모은 집합이 통째로 사라진다**. 도형을
  // 빗맞힌 Shift+클릭도 마찬가지다. 다중 선택에서 가장 아픈 종류의 실수라,
  // 판정 자체를 modifier 로 끊는다.
  if (shiftKey) return 'none';
  const inside =
    click.x >= 0 &&
    click.y >= 0 &&
    click.x <= rect.width &&
    click.y <= rect.height;
  if (!inside) return 'none';
  // 잠기지 않은 것이 하나라도 커서 아래 있으면 게이트가 'auto' 이고, 그 클릭의
  // 주인은 오버레이다. 여기서 손대면 두 번 쓴다.
  if (unlockedHit != null) return 'none';
  if (hit == null) return 'deselect';
  // 여기 도달했다면 hit 은 잠긴 것이다(잠기지 않았다면 unlockedHit 에 잡혔다).
  // 그래도 명시적으로 확인한다 — 두 히트 테스트가 언젠가 임계값이 갈리면 이
  // 함의가 조용히 깨지는데, 그때 엉뚱한 도형을 선택하느니 아무것도 안 하는 게 낫다.
  return isLocked(hit) ? 'select-locked' : 'none';
}

/** Test-only export of internals. Do not import in production code. */
export const __test__ = { resolveSelectModeMouseDown };

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

export default function DrawingOverlay({ chart, axis, paneSeries, scope, onChartHoverPassthrough, bucketMs, candles: bundleCandles }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The bars the chart actually plotted. The bundle's array can END on a bar the
  // axis rejects (Kiwoom's daily 15:35 after-hours print), and everything below
  // that reads "the last candle" — the empty-band anchor, magnet span, drag
  // column count — must mean the last PLOTTED one, or the band goes dead from
  // 15:35 until the next session's first bar. See `onAxisCandles`.
  const candles = useMemo(() => onAxisCandles(axis, bundleCandles), [axis, bundleCandles]);

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
  const selectedIds = useDrawingsStore((s) =>
    scope ? s.selectedByScope.get(scope) ?? EMPTY_SELECTION : EMPTY_SELECTION,
  );
  // 핸들(끝점·모서리)은 **단일 선택일 때만** 뜬다 — 다중에서 핸들을 그리면 같은
  // 픽셀에서 "한 도형 크기 조절"과 "다섯 개 이동"이 경합한다. 그 게이트를 조건이
  // 아니라 값의 정의로 박아 둔다(ToolCtx.selectedId 주석).
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  // 렌더가 프레임마다 멤버십을 묻는다(도형 × 팬 수). 스냅샷 getter 안에서 만들면
  // lwc 의 draw 마다 새 Set 이 생기므로 선택 배열이 바뀔 때만 파생한다.
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const defaults = useDrawingsStore((s) => s.defaults);

  const trendlineDraft = useRef<TrendlineDraft | null>(null);
  const pencilDraft = useRef<PencilDraft | null>(null);
  const rectDraft = useRef<RectDraft | null>(null);
  const measureDraft = useRef<MeasureDraft | null>(null);
  const marqueeDraft = useRef<MarqueeDraft | null>(null);
  /** Shift 가 눌려 있는가 — pointer-events 게이트가 마퀴 통로를 열지 결정한다.
   *  mousemove 와 keydown/keyup 양쪽에서 갱신된다(어느 한쪽만으로는 "누른 채
   *  멈춤" 또는 "포커스 밖에서 누름" 중 하나를 놓친다). */
  const shiftHeldRef = useRef(false);
  const dragRef = useRef<DragMode | null>(null);
  // One primitive per mounted pane — the actual renderers. See DrawingsPrimitive.ts.
  const primitivesRef = useRef<Map<PaneId, DrawingsPrimitive>>(new Map());
  // hline/vline placement preview, in DOMAIN coordinates (price / realMs) with
  // magnet snapping already resolved, so each pane's primitive can project it.
  // Null when not hovering with those tools.
  const ghostRef = useRef<GhostPreview | null>(null);
  /** Alignment guides for the in-flight drag. A ref, not state: it changes on
   *  every pointermove and a setState per sample would re-render the whole
   *  overlay at pointer cadence. */
  const alignGuidesRef = useRef<{ guides: readonly AlignGuide[]; color: string } | null>(null);
  /** Everything one gesture owns, bundled so all three exits (Escape,
   *  right-click, pointercancel) clear the SAME list. Stable identity: the
   *  keydown effect below has `[]` deps and captures this once. */
  const gestureRefs = useRef<GestureRefs>({
    trendlineDraft,
    pencilDraft,
    rectDraft,
    measureDraft,
    marqueeDraft,
    dragRef,
    alignGuides: alignGuidesRef,
  }).current;
  // Last known cursor position in CLIENT coords, tracked unconditionally. The
  // pointer-events gate needs it to settle the moment select mode is entered —
  // without a remembered position it can only wait for the next mousemove, and
  // a cursor sitting still over a shape stays untouchable. See that effect.
  const lastMouseRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // 아래 `forwardHoverToChart` 의 rAF 스로틀 상태.
  const forwardPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const forwardRafRef = useRef<number | null>(null);
  // 마지막으로 이동을 넘겨 준 요소. leave 를 **좌표가 아니라 이 요소로** 보내기
  // 위해 기억한다 — 사유는 `forwardLeaveToChart`.
  const forwardTargetRef = useRef<Element | null>(null);
  // Reassigned every render so primitives always read current state at draw time.
  const snapshotRef = useRef<() => DrawingsSnapshot | null>(() => null);
  // Reassigned every render so the (empty-deps) keydown effect always calls the
  // latest closure over the current coordinate helpers — same pattern as
  // snapshotRef. Set just before the return.
  const duplicateSelectedRef = useRef<() => void>(() => {});
  /** 방향키 미세 이동 — (dx, dy) 는 -1/0/1, `big` 은 Shift(열 배). 복제와 같은
   *  이유로 ref 경유다: 키다운 effect 가 `[]` deps 라 좌표 클로저가 stale 이 된다. */
  const nudgeSelectedRef = useRef<(dx: number, dy: number, big: boolean) => void>(() => {});
  // 같은 이유로 언마운트 정리가 최신 되돌리기 상태를 걷게 하는 통로.
  const cancelForwardRef = useRef<() => void>(() => {});

  // Text editing — a DOM <input> rendered over the canvas (IME-safe).
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [textValue, setTextValue] = useState('');
  const textInputRef = useRef<HTMLInputElement>(null);
  const marqueeBoxRef = useRef<HTMLDivElement>(null);
  // `textEdit` is also mirrored to a ref so the pointer/keyboard closures (which
  // don't re-bind every render) can read the current editing state.
  const textEditRef = useRef<TextEdit | null>(null);
  textEditRef.current = textEdit;

  // Empty-band extrapolation reference: newest candle + timeframe bucket. Lets
  // drawings be created/rendered in the whitespace right of the last candle.
  // Declared here (above the redraw effect, which reads lastRealMs) so it's in
  // scope for both the effect and the coordinate closures below.
  const futureBand = futureBandFor(axis, candles, bucketMs);
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
    syncMarqueeBox();
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
    selectedIds: selectedIdSet,
    handlesId: selectedId,
    hiddenAll: defaults.hiddenAll,
    axis,
    timeBadgePaneId,
    future: futureBand,
    bucketMs,
    lastRealMs,
    candles,
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
    alignGuides: alignGuidesRef.current,
    onFrame: textEdit ? syncTextEditorPosition : undefined,
  });

  // Wire the source and repaint on every React-visible change. `paneSeries` is
  // a dep so a re-attach re-wires the freshly created primitives.
  useEffect(() => {
    const source: DrawingsSource = () => snapshotRef.current();
    for (const prim of primitivesRef.current.values()) prim.setSource(source);
  }, [paneSeries, drawings, selectedIdSet, defaults, axis, bucketMs, lastRealMs]);

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
        measureDraft.current ||
        marqueeDraft.current
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
        if (key === 'a') {
          // 전체 선택. **잠긴 것도 담는다** — 그래야 "전부 고르고 전부 풀기" 가
          // 한 흐름이 된다(ADR-0164 는 편집만 막는다). 숨김 레이어에서는 건너뛴다:
          // 화면에 없는 것을 고를 수는 없고, 그 상태에선 속성 툴바도 뜨지 않는다.
          const store = useDrawingsStore.getState();
          if (!store.defaults.hiddenAll) {
            store.setSelection(keyScope, (store.byScope.get(keyScope) ?? []).map((d) => d.id));
          }
          e.preventDefault(); // 브라우저 전체 선택을 막는다
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
      // 방향키 미세 이동. **선택이 있을 때만** 키를 가져간다 — 선택이 없으면
      // 흘려보내 페이지·차트가 평소대로 반응하게 한다(Delete 와 같은 정직성 규칙).
      //
      // ⚠ 단, 선택이 있으면 **아무것도 안 움직여도 preventDefault 한다**(전부 잠긴
      // 경우). 여기서 키를 흘리면 페이지가 스크롤되어, 고른 도형이 화면 밖으로
      // 밀려나는 것처럼 보인다 — Delete 와 갈리는 지점이고, 갈리는 이유는 "관심
      // 없다" 와 "관심은 있는데 지금은 못 움직인다" 가 다른 상태이기 때문이다.
      const NUDGE: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        // 화면 y 는 아래로 증가한다 — 위 화살표가 -1.
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const nudge = NUDGE[e.key];
      if (nudge) {
        const store = useDrawingsStore.getState();
        if ((store.selectedByScope.get(keyScope) ?? []).length === 0) return;
        nudgeSelectedRef.current(nudge[0], nudge[1], e.shiftKey);
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const store = useDrawingsStore.getState();
        const ids = store.selectedByScope.get(keyScope) ?? EMPTY_SELECTION;
        const items = store.byScope.get(keyScope) ?? [];
        // 잠긴 도형만 골라 눌렀다면 preventDefault 도 하지 않는다 — 키를 삼키지
        // 않고 흘려 보내는 편이 "이 창은 이 키에 관심 없다" 는 정직한 신호다.
        // 집합에 잠긴 것이 섞여 있으면 나머지는 지우고 그것만 남는다.
        const deletable = ids.filter((id) => !isLocked(items.find((d) => d.id === id)));
        if (deletable.length > 0) {
          store.removeMany(keyScope, deletable);
          e.preventDefault();
        }
      } else if (e.key === 'Escape') {
        // Escape 와 우클릭은 **같은 하나의 출구**다 — 한 번에 도구와 선택을 함께
        // 푼다(사용자 결정, 2026-08-08). 단계로 나누면 어느 제스처가 어디까지
        // 되돌리는지 외워야 하므로, 예측 가능성을 택했다. 두 경로가 같은 스토어
        // 액션을 부르는 것이 곧 "결과가 항상 같다" 는 보장이다.
        useDrawingsStore.getState().exitDrawingMode();
        // `keepDrag`: a live drag still holds a captured pointer, and
        // `onPointerUp` reads `dragRef` to decide whether to release it. 마퀴도
        // 같은 이유로 남는다(그쪽도 캡처를 쥔다) — 다만 이 effect 는 진행 중인
        // 마퀴에서 조기 반환하므로 여기 도달하지 않는다.
        const { guidesCleared } = resetGestureRefs(gestureRefs, { keepDrag: true });
        if (guidesCleared) requestRedraw();
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

  // Screen-uniform bar-ordinal domain for body-drag translation (see
  // DragBarDomain). `candles` is what makes one ordinal exactly one on-screen
  // column: without it the domain counts session SLOTS, and a vertex crossing a
  // day boundary spends slots the screen has no columns for — the shape
  // stretched by the empty-slot count per boundary crossed (measured 38 → 48).
  const dragBars = dragBarDomain(axis, futureBand, candles);

  // SR-5: the kind-dispatch hit geometry lives in the pure hitTestDrawings
  // kernel (hitTest.ts, unit-tested with stub coords). This wrapper just binds
  // the chart-aware coordinate closures.
  /** The projector bag both the point hit-test and the marquee feed on. Shared
   *  deliberately: if the two ever projected differently, a shape could be
   *  clickable where the marquee can't see it (or the reverse), and nothing on
   *  screen would explain the discrepancy. */
  const hitCoords = (): HitCoord => ({
    realMsToCanvasX,
    realMsToCanvasXClamped,
    priceToCanvasY,
    paneIdAtY: (y) => projPaneIdAtY(chart, paneSeries, y),
    canvasWidth: containerRef.current?.clientWidth ?? 0,
    // 확장된 사각형의 오른쪽 변이 **그려진 자리**에서 끝나도록. 컨테이너는 `inset-0`
    // 이라 가격축 거터까지 덮지만 렌더는 플롯 위에서 돈다 — 그 차이만큼 넓게 잡으면
    // 거터 위 클릭이 사각형에 먹혀 축 드래그가 죽는다(게이트 주석의 그 회귀).
    // Optional-called: `width()` is long-standing lwc API, but the test stubs in
    // this repo supply only the timeScale methods each case exercises. Missing →
    // `rightEdgeOf` falls back to `canvasWidth`, which is exactly the arithmetic
    // that shipped before extendRight existed.
    plotWidth: chart.timeScale().width?.(),
    measureTextWidth,
    // MUST be the same pitch the renderer used, or a pencil stroke
    // would be grabbable off its drawn position (see subBarOffsetPx).
    barPx: barPitchPx(chart) ?? undefined,
  });

  const hitTestIn = (list: readonly Drawing[], px: number, py: number): Drawing | null =>
    // Hidden drawings are non-interactive — no hover gating, no selection.
    defaults.hiddenAll ? null : hitTestDrawings(hitCoords(), list, px, py);

  const hitTestAt = (px: number, py: number): Drawing | null => hitTestIn(drawings, px, py);

  /**
   * Hit test that ignores locked drawings. This is the question the
   * pointer-events gate actually asks — "is there something here the overlay
   * needs to handle?" — and a locked shape is not: it cannot be dragged, so
   * the overlay claiming the pointer over it would only stop the chart from
   * panning (ADR-0164's rough edge).
   *
   * Filtering the LIST rather than checking the winner is what makes an
   * unlocked drawing under a locked one still grabbable — `hitTestDrawings`
   * returns the topmost match, so testing the winner for `locked` would let a
   * locked shape on top mask a live one beneath it.
   */
  const hitTestUnlockedAt = (px: number, py: number): Drawing | null =>
    hitTestIn(unlockedOnly(drawings), px, py);

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
      // 커밋 후 선택하지 않는다 — 다른 그리기 도구와 같은 규약(그리기 모드는
      // 항상 그린다). 방금 쓴 라벨의 색·크기는 select 모드에서 고른다.
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

  /**
   * Publish (or clear) the drag's alignment guides.
   *
   * The COLOR is resolved here rather than inside the tool: a tool knows the
   * geometry that snapped but not which drawing the user is holding, and the
   * guide has to wear that drawing's color (see `renderAlignGuides`). During a
   * creation drag there is no such drawing yet, so the rect tool's own sticky
   * color stands in — which is exactly the color the draft is being drawn in.
   *
   * The clear path early-returns when nothing was showing, so the common case
   * (a drag that never snaps) costs no redraws at all.
   */
  const setAlignGuides = (guides: readonly AlignGuide[]) => {
    if (guides.length === 0) {
      if (alignGuidesRef.current !== null) {
        alignGuidesRef.current = null;
        requestRedraw();
      }
      return;
    }
    const drag = dragRef.current;
    const draggingId = drag != null && 'id' in drag ? drag.id : undefined;
    const dragging = draggingId ? drawings.find((d) => d.id === draggingId) : undefined;
    alignGuidesRef.current = {
      guides,
      color: dragging?.color ?? defaults.styleByKind.rect.color,
    };
    requestRedraw();
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
      // Same container-relative frame as px/py. `getCoalescedEvents` is
      // optional-called: jsdom's PointerEvent doesn't implement it, and a
      // non-pointer synthetic event in a test has no such method either.
      coalesced:
        e.nativeEvent
          .getCoalescedEvents?.()
          .map((c) => ({ px: c.clientX - rect.left, py: c.clientY - rect.top })) ?? [],
      pointerId: e.pointerId,
      shiftKey: e.shiftKey,
      // Both swallow — pointer capture is a CONVENIENCE (it keeps events coming
      // while the cursor leaves the overlay), never part of a gesture's result.
      // Four tools (trendline / rect / measure / pencil) call `releasePointer`
      // BEFORE `ctx.add`, so a throw here used to take the whole commit with
      // it: the user drew a shape and nothing appeared, with no error they
      // could act on. Failing to pin a pointer is worth degrading for; losing
      // the drawing is not. Same judgment `onPointerCancel` already makes.
      capturePointer: () => {
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          // Pointer already gone (fast tap, touch cancelled) — the gesture
          // still runs, it just isn't pinned to the overlay.
        }
      },
      releasePointer: () => {
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          // Never captured, or released already — nothing to undo.
        }
      },
      // Shape alignment rides the SAME magnet toggle and the same Ctrl/Meta
      // override as candle snapping — the user already calls this "자석" and
      // splitting it into a second switch would make the toggle mean half of
      // what it says. Unlike the candle magnet it does not require loaded
      // candles: its references are other rectangles.
      alignSnapEnabled: defaults.magnet && !(e.ctrlKey || e.metaKey),
      setAlignGuides,
      pixelToData: (px, py, paneId) => pixelToDataSnapped(px, py, paneId, snap),
      pixelToDataUnsnapped: (px, py, paneId) => pixelToDataSnapped(px, py, paneId, false),
      realMsToCanvasX,
      canvasXToRealMs: (px) => canvasXToRealMsSnapped(px, snap),
      priceToCanvasY,
      canvasYToPrice,
      barPx: () => barPitchPx(chart),
      hitTestAt,
      hitTestUnlockedAt,
      paneIdAtY,
      clampYToPane,
      priceBoundsForPane,
      dragBars,
      drawings,
      selectedId,
      selectedIds,
      // 마퀴는 **잠긴 것도 담는다.** 지목과 편집이 다른 일이기 때문이다 — 잠긴
      // 도형을 여럿 담을 수 있어야 한꺼번에 풀 수 있고, 이동·수정·삭제는 스토어의
      // 관문이 여전히 막는다(ADR-0164). 그래서 여기엔 `unlockedOnly` 합성이 없다.
      // 숨김 레이어에서는 아무것도 고르지 않는다 — hitTestIn 의 hiddenAll 가드와
      // 같은 이유(화면에 없는 것을 고를 수는 없다).
      drawingsInRect: (r: MarqueeRect) =>
        defaults.hiddenAll ? [] : drawingsInRect(hitCoords(), drawings, r),
      // Narrow the per-kind defaults to the active tool's slot. select/eraser
      // never read this (they don't create shapes), so INITIAL_STYLE is a safe
      // filler there.
      defaults: isDrawingKind(activeTool) ? defaults.styleByKind[activeTool] : INITIAL_STYLE,
      trendlineDraft,
      pencilDraft,
      rectDraft,
      measureDraft,
      marqueeDraft,
      dragRef,
      beginTextEdit,
      requestRedraw,
      add: (d) => { if (scope != null) useDrawingsStore.getState().add(scope, d); },
      update: (id, patch) => { if (scope != null) useDrawingsStore.getState().update(scope, id, patch); },
      remove: (id) => { if (scope != null) useDrawingsStore.getState().remove(scope, id); },
      setSelected: (id) => { if (scope != null) useDrawingsStore.getState().setSelected(scope, id); },
      toggleSelected: (id) => { if (scope != null) useDrawingsStore.getState().toggleSelected(scope, id); },
      addToSelection: (ids) => { if (scope != null) useDrawingsStore.getState().addToSelection(scope, ids); },
      updateMany: (patches) => { if (scope != null) useDrawingsStore.getState().updateMany(scope, patches); },
      revertToSelectMode,
    };
  };

  // ── 크로스헤어 되살리기 ────────────────────────────────────────────────
  //
  // 이 오버레이가 포인터를 잡는 동안(아래 pointer-events 게이트) lightweight-charts
  // 는 마우스를 못 받는다. 그래서 **드로잉 위 ±6px 밴드에 들어가는 순간 크로스헤어가
  // 사라졌다** — 선을 고르려고 다가가면 조준선이 없어지는 것이라 "고장" 으로 읽힌다.
  // 도구를 든 동안엔 게이트가 플롯 전체를 잡으므로 그리는 내내 없었다.
  // 같은 뿌리에서 셋이 함께 죽는다(실측): 크로스헤어 선·양축 배지 / `CandleTooltip` /
  // `PaneLegendOverlay` 의 OHLC 가 **최신 봉으로 폴백**(호버 봉 279,500 → 281,500).
  //
  // 그래서 마우스 이동을 lwc 서브트리로 **되돌려 준다.** 그러면 lwc 가 평소와 똑같이
  // 처리한다 — 선·배지뿐 아니라 `crosshairMove` 도 발화하므로 툴팁과 레전드가 함께
  // 산다. 우리가 좌표를 다시 계산하지 않는 것이 핵심이다: 계산하는 순간 "네이티브와
  // 같은가" 가 새로운 검증 부채가 된다.
  //
  // **`setCrosshairPosition`(창 간 동기화용 공개 API)을 쓰지 않는 이유.** 그 API 는
  // `Time` 을 받는데, **마지막 캔들 오른쪽 빈 구간에는 time point 가 없다** —
  // `coordinateToTime` 이 null 이라 그 구간 전체에서 아무것도 못 건다. 실측
  // (2026-08-22, 장 마감 분봉): 빈 구간이 pane 폭의 **25.7%(626px 중 161px)** 였다.
  // hline 은 캔버스를 가로지르므로 사용자가 그 구간에서 선을 잡는 일이 흔하다.
  // 되돌리기는 lwc 의 네이티브 경로를 그대로 타므로 거기서도 정확히 그린다
  // (실측: canvas x=550 — `setCrosshairPosition` 은 불가능한 지점).
  //
  // 되돌려도 팬/줌이 나지 않는다: lwc 의 `mousemove` 처리는 `_mousePressed` 일 때
  // 곧바로 빠지고, 그 플래그는 **자기 요소의 mousedown** 으로만 선다. 우리는 이동만
  // 되돌리고 버튼 이벤트는 넘기지 않으므로 그 경로가 열리지 않는다.
  //
  // 쏘는 요소는 **이름이 아니라 좌표로** 찾는다. lwc 는 캔버스가 아니라 그 조상에
  // 리스너를 걸고 버전에 따라 그 요소가 바뀌는데, 그 지점에서 차트 서브트리 안
  // **가장 위** 요소는 리스너 요소 자신이거나 그 자손이므로 거기 쏘면 버블링으로
  // 반드시 닿는다. 그래서 **전부 `bubbles: true`** 다 — 네이티브 규칙(enter/leave 는
  // 안 뜬다)을 따르면 자손에 쏜 것이 리스너에 안 닿는다.
  //
  // 넘기는 종류는 lwc 가 **실제로 듣는 것만**이다(`mouseenter`·`mousemove`·
  // `mouseleave`). `mouseover`/`mouseout` 은 lwc 리스너가 없고, 그 둘은 React 의
  // enter/leave 위임이 타는 경로라 괜히 쏘면 남의 컴포넌트를 흔든다.
  //
  // `view` 는 일부러 넘기지 않는다. lwc 가 읽는 것은 `clientX`/`clientY` 와
  // 타임스탬프뿐이고(`_makeCompatEvent`·`_firesTouchEvents`), 반면 테스트 러너의
  // jsdom 에서는 전역 `window` 가 프록시라 `new MouseEvent({view})` 가 "member view
  // is not of type Window" 로 **던진다** — 얻는 것 없이 환경 하나를 깨뜨리는 인자다.
  const forwardToChart = (clientX: number, clientY: number, types: readonly string[]) => {
    const chartEl = chart.chartElement();
    const doc = chartEl?.ownerDocument;
    if (!chartEl || !doc || typeof doc.elementsFromPoint !== 'function') return;
    // 대상은 프레임당 한 번만 찾는다 — `elementsFromPoint` 는 히트테스트다.
    const target = doc.elementsFromPoint(clientX, clientY).find((n) => chartEl.contains(n));
    if (!target) return;
    forwardTargetRef.current = target;
    for (const type of types) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));
    }
  };
  const forwardHoverToChart = (clientX: number, clientY: number) => {
    forwardPointRef.current = { clientX, clientY };
    if (forwardRafRef.current !== null) return;
    // pointermove 는 OS 샘플링 레이트(고폴링 마우스면 1kHz 초과)로 오는데 되돌리기는
    // `elementsFromPoint`(히트테스트)를 문다 — 프레임당 1회로 합친다.
    forwardRafRef.current = requestAnimationFrame(() => {
      forwardRafRef.current = null;
      const p = forwardPointRef.current;
      forwardPointRef.current = null;
      if (!p) return;
      // **`mouseenter` 를 매번 앞세운다.** lwc 는 `mousemove` 리스너를
      // `_mouseEnterHandler` **안에서** 등록하고 leave 에서 뗀다. 커서가 우리
      // 오버레이로 넘어오는 순간 브라우저가 진짜 mouseleave 를 쏘므로, 그 뒤에
      // 되돌린 mousemove 는 **아무 리스너에도 안 닿는다**(실측: 차트 서브트리 어느
      // 요소에 쏴도 crosshairMove 0건). enter 는 재진입이 멱등이고(기존 구독을 떼고
      // 다시 건다) 커서 위치는 뒤따르는 mousemove 가 정한다.
      // 둘 다 `bubbles: true` 여야 한다 — 우리는 lwc 의 리스너 요소를 이름으로
      // 모르고 그 자손에 쏘기 때문이다(네이티브 mouseenter 는 원래 안 뜨지만
      // 합성 이벤트는 뜨게 만들 수 있고, 리스너는 버블 단계에서도 불린다).
      forwardToChart(p.clientX, p.clientY, ['mouseenter', 'mousemove']);
    });
  };
  const forwardLeaveToChart = (clientX: number, clientY: number) => {
    if (forwardRafRef.current !== null) {
      cancelAnimationFrame(forwardRafRef.current);
      forwardRafRef.current = null;
    }
    forwardPointRef.current = null;
    // lwc 자신의 leave 경로를 태운다 — `crosshairMove(point=null)` 까지 나므로
    // 툴팁·레전드도 평소와 같은 방식으로 정리되고, `mousemove` 구독도 떼어진다.
    //
    // **대상을 좌표로 다시 찾으면 안 된다.** `pointerleave` 의 좌표는 이미 차트 밖인
    // 경우가 흔해서(빠르게 빠져나가는 동선) 히트테스트가 아무것도 못 찾고, 그러면
    // 크로스헤어가 화면에 **박힌 채 남는다**(실측: 도형 위 x=551 에서 차트 밖으로
    // 이탈 → 크로스헤어가 550 에 그대로). 이동을 받아 온 그 요소로 곧장 보낸다.
    const target = forwardTargetRef.current;
    forwardTargetRef.current = null;
    if (!target?.isConnected) return;
    target.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true, clientX, clientY }));
  };
  // 언마운트 정리는 ref 경유다 — 빈 deps 로 걸어야 마운트/언마운트에만 도는데,
  // 이 클로저는 매 렌더 새로 만들어지므로 직접 넣으면 렌더마다 재구독된다.
  cancelForwardRef.current = () => {
    if (forwardRafRef.current !== null) {
      cancelAnimationFrame(forwardRafRef.current);
      forwardRafRef.current = null;
    }
    forwardPointRef.current = null;
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
    // 오버레이가 삼킨 이동을 lwc 로 되돌려 크로스헤어·툴팁·레전드를 살린다.
    forwardHoverToChart(e.clientX, e.clientY);
    // Track the cursor for the hline/vline ghost-line preview and repaint.
    if (activeTool === 'hline' || activeTool === 'vline') {
      ghostRef.current = computeGhost(px, py);
      requestRedraw();
    }
    TOOLS[activeTool].onPointerMove?.(buildCtx(e));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerUp?.(buildCtx(e));
  };
  const onPointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    // 커서가 차트를 떠나면 lwc 에도 알린다. **밴드 → 플롯 복귀는 여기 오지 않는다**
    // — 게이트가 오버레이를 'none' 으로 돌리는 순간 lwc 가 진짜 마우스를 다시 받기
    // 때문이다. 여기가 필요한 것은 도형 위에서 곧장 차트 밖으로 빠져나가는 경로다
    // (그때는 lwc 에 아무 이벤트도 안 가서 크로스헤어가 남는다).
    forwardLeaveToChart(e.clientX, e.clientY);
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
    const { guidesCleared, marqueeCleared } = resetGestureRefs(gestureRefs);
    // 마퀴 상자는 DOM 이라 ref 를 비우는 것만으로는 화면에서 사라지지 않는다 —
    // `requestRedraw` 가 `syncMarqueeBox` 를 함께 돌린다.
    if (guidesCleared || marqueeCleared) requestRedraw();
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
    // Escape 와 같은 출구를 쓴다 — 종전엔 `setActiveTool('select')` 만 해서 선택이
    // 남았고, 하필 속성 패널은 select 모드에서만 뜨므로 **우클릭한 순간 툴바가 새로
    // 튀어나왔다**. 사용자에겐 "안 풀렸다" 로 읽혀 한 번 더 누르게 만들었다(그 두
    // 번째는 아무 일도 하지 않는다 — 선택을 푸는 우클릭 경로가 아예 없었다).
    useDrawingsStore.getState().exitDrawingMode();
  };
  // Double-click an existing text label to re-open its editor in place.
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = hitTestAt(px, py);
    // 잠긴 라벨은 편집기를 열지 않는다. 열어 두고 커밋만 스토어가 거부하면
    // 사용자는 글자를 고쳐 넣고 Enter 를 친 뒤에야 안 먹혔다는 걸 안다.
    if (hit && hit.kind === 'text' && !isLocked(hit)) {
      setTextEdit({ id: hit.id, at: hit.at, paneId: hit.paneId, initial: hit.text, fontSize: hit.fontSize, px, py });
      setTextValue(hit.text);
      e.preventDefault();
    }
  };

  // 언마운트(봉 전환·창 닫기·종목 변경) 시 예약된 되돌리기를 취소한다 — 사라진
  // 차트에 쏘면 예외가 나고, 그 프레임의 이동은 어차피 의미가 없다.
  useEffect(() => () => cancelForwardRef.current(), []);

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
    const ts = chart.timeScale();
    // 팬/줌 스로틀 상태. applyGate 가 lastProbeAt 을 갱신하므로 그보다 앞에 선언한다.
    let lastProbeAt = 0;
    let viewportMoving = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * 커서가 **플롯 영역** 안인가. 컨테이너는 `inset-0` 이라 우측 가격축 거터와 하단
     * 시간축까지 덮지만, 그 두 거터는 lightweight-charts 의 축 드래그(세로 스케일 ·
     * 가로 barSpacing 조정) 영역이다. 컨테이너 크기가 아니라 `ts.width()`/`ts.height()`
     * 로 재는 이유는 이 컴포넌트가 팬/줌에 **재렌더하지 않게** 설계돼서(그림은 pane
     * primitive 가 그린다) 렌더 시점에 굳힌 값은 리사이즈에 스테일해지기 때문이다 —
     * 게이트는 커서가 움직일 때마다 축에 직접 묻는다.
     */
    const inPlotArea = (px: number, py: number, rect: DOMRect) =>
      px >= 0 && py >= 0 && px <= ts.width() && py <= rect.height - ts.height();

    const applyGate = (clientX: number, clientY: number) => {
      lastProbeAt = performance.now();
      // 마퀴가 진행 중이면 게이트를 얼린다. 드래그 도중 Shift 를 놓는 순간
      // pointer-events 가 'none' 으로 뒤집히면 진행 중인 제스처가 브라우저에서
      // 통째로 사라진다 — 사용자는 사각형이 화면에 남은 채 아무 반응이 없는
      // 상태를 본다. (dragRef 는 onHover 가 이미 막지만 여기도 지켜 준다.)
      if (marqueeDraft.current || dragRef.current) return;
      const rect = container.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      if (activeTool !== 'select') {
        // 그리기 도구를 든 동안에도 축 거터는 lwc 에 넘긴다. 예전엔 여기서 무조건
        // 'auto' 였고, 그래서 도구를 들면 축 드래그가 **완전히 죽었다**(실측: 가격축
        // 드래그로 autoScale·좌표가 전혀 안 변함, 시간축 barSpacing 도 동일).
        container.style.pointerEvents = inPlotArea(px, py, rect) ? 'auto' : 'none';
        return;
      }
      // 선택 모드는 히트 판정을 **컨테이너 전체**로 유지한다 — hline 히트는 y 거리만
      // 보므로(hitTest 의 `distanceToHline`) 가격축에 그려진 가격 배지 위에서도 잡히고,
      // 그게 배지를 클릭해 선을 고르는 경로다. 여기서 플롯으로 좁히면 그 경로가 죽는다.
      //
      // **잠긴 도형은 세지 않는다**(hitTestUnlockedAt). 게이트가 묻는 것은 "오버레이가
      // 처리할 게 여기 있는가" 인데 잠긴 도형은 끌 수 없으므로 답이 '아니오'다. 예전엔
      // 잠긴 도형 위에서도 'auto' 라 오버레이가 포인터를 삼켰고, 그래서 드래그가
      // **아무 일도 안 했다 — 차트 팬까지 죽었다**(ADR-0164 의 거친 모서리). 'none' 이면
      // lightweight-charts 가 그대로 받아 평소처럼 팬한다. 잠긴 도형의 **선택**은
      // 오버레이가 아니라 window mousedown 리스너가 맡는다(resolveSelectModeMouseDown).
      //
      // Shift 를 누르고 있으면 **빈 곳에서도** 오버레이가 포인터를 받는다 —
      // 마퀴(Shift+드래그)를 시작할 통로다. 이것이 없으면 빈 곳의 pointerdown 은
      // 게이트 밖이라 오버레이에 아예 닿지 않고, 차트가 팬된다.
      //
      // 대가는 **Shift+드래그로 차트를 팬하는 경로**다. lwc 는 modifier 를 구분
      // 하지 않으므로 그 조합만 팬을 잃는다(맨 드래그는 그대로다). 마퀴가 반드시
      // 빈 곳에서 시작하는 제스처인 이상 둘 중 하나는 양보해야 하고, 잃는 쪽이
      // 대체 경로가 있는 쪽이어야 한다.
      if (shiftHeldRef.current) {
        container.style.pointerEvents = 'auto';
        return;
      }
      // 곁가지로 커서 문제도 함께 풀린다: 'none' 이면 잠긴 도형 위 커서가 lwc 의
      // 크로스헤어가 되어 "여기선 차트가 반응한다" 를 스스로 말한다.
      const hit =
        px >= 0 && py >= 0 && px <= rect.width && py <= rect.height
          ? hitTestUnlockedAt(px, py)
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
    // 커서 기록이 없으면(로드 후 마우스를 한 번도 안 움직임) 도구별 기본값으로 둔다.
    // 그리기 도구에서 'none' 으로 시작하면 첫 클릭 전에 반드시 오는 mousemove 가
    // 고쳐 주긴 하지만, 관대한 쪽이 예전 동작과 같아 회귀 표면이 좁다.
    else container.style.pointerEvents = activeTool === 'select' ? 'none' : 'auto';
    // rAF-coalesce the global mousemove. Native mousemove fires at the OS
    // sampling rate (can exceed 1 kHz on high-poll-rate mice). Without
    // throttling, every event paid getBoundingClientRect() (forces layout),
    // hitTestAt (iterates all drawings), and a pointer-events style write
    // — all wasted between paints since the user can't perceive sub-frame
    // hit changes. One probe per frame is enough.
    let hoverRaf: number | null = null;
    let pendingEvent: MouseEvent | null = null;
    const onHover = (e: MouseEvent) => {
      if (dragRef.current || marqueeDraft.current) return;
      // 마우스 이벤트가 modifier 의 가장 신뢰할 만한 소스다 — 키 리스너는 창이
      // 포커스를 잃은 채 눌린 Shift 를 놓친다.
      shiftHeldRef.current = e.shiftKey;
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

    // Shift 를 누른 채 커서를 멈춰 두면 mousemove 가 오지 않는다. 그 정지 상태
    // 에서도 게이트가 열려야 "Shift 누르고 드래그" 가 첫 시도에 먹는다(누르고
    // 흔들어야 먹는 것은 고장으로 읽힌다). 놓을 때 닫는 것도 같은 이유다.
    const onShiftKey = (e: KeyboardEvent) => {
      const held = e.shiftKey;
      if (held === shiftHeldRef.current) return;
      shiftHeldRef.current = held;
      const at = lastMouseRef.current;
      if (at) applyGate(at.clientX, at.clientY);
    };

    window.addEventListener('mousemove', onHover);
    window.addEventListener('keydown', onShiftKey);
    window.addEventListener('keyup', onShiftKey);
    ts.subscribeVisibleLogicalRangeChange(onViewportMove);
    return () => {
      window.removeEventListener('mousemove', onHover);
      window.removeEventListener('keydown', onShiftKey);
      window.removeEventListener('keyup', onShiftKey);
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

  // ── window mousedown: empty-click deselect + locked-drawing select ─────
  // Runs in parallel with chart pan/zoom — never calls preventDefault or
  // stopPropagation. See ADR-0030 (the deselect rule) and ADR-0164 (why the
  // locked-select branch has to live here rather than in `selectTool`).
  //
  // The mount condition used to be `selectedId != null` ("only while there's
  // something to deselect"). It has to be `drawings.length > 0` now: selecting
  // a LOCKED drawing starts from nothing-selected, and that click reaches the
  // overlay through no other path. Still short-lived in the case that matters —
  // a chart with no drawings mounts no listener at all.
  useEffect(() => {
    if (activeTool !== 'select' || drawings.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const onWindowMouseDown = (e: MouseEvent) => {
      if (dragRef.current || scope == null) return;
      const isOnPropertyPanel =
        e.target instanceof Node &&
        !!document.querySelector('[data-drawing-property-panel]')?.contains(e.target);
      const rect = container.getBoundingClientRect();
      const click = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const hit = hitTestAt(click.x, click.y);
      const unlockedHit = hitTestUnlockedAt(click.x, click.y);
      switch (
        resolveSelectModeMouseDown(click, rect, hit, unlockedHit, isOnPropertyPanel, e.shiftKey)
      ) {
        case 'deselect':
          useDrawingsStore.getState().setSelected(scope, null);
          break;
        case 'select-locked':
          // 선택은 mousedown 에서 일어난다(해제와 같은 시점). 잠긴 도형을 눌러
          // 팬을 시작하면 팬 도중에 속성 패널이 뜨는데, 그게 곧 "잡았고, 잠겨
          // 있고, 풀려면 여기" 라는 일관된 이야기라 그대로 둔다.
          useDrawingsStore.getState().setSelected(scope, hit!.id);
          break;
        case 'none':
          break;
      }
    };
    window.addEventListener('mousedown', onWindowMouseDown);
    return () => window.removeEventListener('mousedown', onWindowMouseDown);
    // hitTestAt closes over drawings / paneSeries / axis — re-bind on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, drawings, paneSeries, axis, scope]);

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
  //
  // 같은 전환에서 선택도 비운다 — 불변식은 **그리기 모드 ⇒ 선택 없음**이다.
  // 도구는 커밋 후에 선택하지 않지만(그리기 모드는 항상 그린다), select 모드에서
  // 고른 도형은 도구를 켜도 그대로 남는다. 그 헤일로는 그리기 모드에서 "잡을 수
  // 있다" 고 거짓말을 하게 되므로(눌러도 새 도형이 그려진다) 진입 시점에 끊는다.
  // 창마다 도는 effect 지만 해제는 멱등이라 중복이 무해하다.
  useEffect(() => {
    if (activeTool === 'select') return;
    const store = useDrawingsStore.getState();
    if (store.defaults.hiddenAll) store.setDefaults({ hiddenAll: false });
    store.clearAllSelections();
  }, [activeTool]);

  // Duplicate the selected drawing with a ~14px down-right offset (derived from
  // the current coordinate closures so the offset is visually constant across
  // panes/timeframes). Reassigned each render; called from the keydown effect.
  duplicateSelectedRef.current = () => {
    const store = useDrawingsStore.getState();
    if (scope == null) return;
    const ids = store.selectedByScope.get(scope) ?? EMPTY_SELECTION;
    if (ids.length === 0) return;
    const items = store.byScope.get(scope) ?? EMPTY_DRAWINGS;
    const members = ids
      .map((id) => items.find((x) => x.id === id))
      .filter((d): d is Drawing => d != null);
    if (members.length === 0) return;
    const OFFSET_PX = 14;
    // 오프셋은 **한 번만** 계산해 전원에게 적용한다(기준은 primary = 마지막 멤버).
    // 멤버마다 자기 ref 로 재면 팬·구간이 다를 때 델타가 갈려 **대형이 어긋난 채로
    // 복제된다** — 그룹 이동이 하나의 델타를 공유하는 것과 같은 이유다.
    const ref = refCoords(members[members.length - 1]);
    const refPaneId = members[members.length - 1].paneId;
    // Horizontal offset in BAR ORDINALS, applied per-vertex through dragBars
    // (same domain as body-drag). The ref vertex is pixel-derived and thus
    // always lands on-axis, but a flat real-ms delta would strand the OTHER
    // vertices in an inter-session gap whenever the ref's +14px crosses a
    // session boundary (clone stretched to the canvas edge near the close),
    // and a virtual-ms delta would move the vertices that straddle a boundary
    // further than the ref (clone wider than the original).
    let shiftMs: TimeShift = 0;
    let dPrice = 0;
    if (ref.realMs != null) {
      const x = realMsToCanvasX(ref.realMs);
      if (x != null) {
        const shifted = rawCanvasXToRealMs(x + OFFSET_PX);
        if (shifted != null) {
          const dBar = dragBars.toBar(shifted) - dragBars.toBar(ref.realMs);
          shiftMs = (ms) => dragBars.toReal(dragBars.toBar(ms) + dBar);
        }
      }
    }
    if (ref.price != null) {
      const y = priceToCanvasY(ref.price, refPaneId);
      if (y != null) {
        const shifted = canvasYToPrice(y + OFFSET_PX, refPaneId);
        if (shifted != null) dPrice = shifted - ref.price;
      }
    }
    // 사본은 **잠금이 풀린 채로** 태어난다(cloneWithOffset) — 복제는 쓸 수 있는
    // 도형을 달라는 요청이지 못 움직이는 것을 하나 더 달라는 요청이 아니다.
    const clones = members.map((d) => cloneWithOffset(d, shiftMs, dPrice));
    store.addMany(scope, clones);
    // 선택은 사본으로 옮겨 간다 — 단일 복제가 하던 것과 같고, 곧바로 이어서
    // 옮기거나 스타일을 바꿀 수 있다.
    store.setSelection(scope, clones.map((c) => c.id));
  };

  /**
   * 방향키 미세 이동. 수평은 **1 봉**, 수직은 **1 픽셀**이 한 걸음이고 Shift 가
   * 열 배로 늘린다.
   *
   * 축마다 단위가 다른 것은 차트 좌표계가 실제로 비대칭이기 때문이다: 시간축은
   * 봉이라는 이산 격자이고(`toReal` 이 격자로 반올림한다 — 0.3봉 같은 것은 존재할
   * 수 없다), 가격축은 연속이다. 수평을 픽셀로 받으면 반올림에 먹혀 어떤 키는
   * 아무 일도 안 하고 어떤 키는 한 봉을 뛴다.
   *
   * `barSized` 가 거짓이면 수평을 건너뛴다 — 그때 1 단위는 봉이 아니라 가상 ms 조각
   * 이라, "한 봉 옮긴다" 는 약속을 지킬 수 없다(DragBarDomain 이 경고하는 "델타를
   * 봉 개수로 읽는 소비자" 가 정확히 이 경우다). 수직은 그대로 동작한다.
   */
  nudgeSelectedRef.current = (dx, dy, big) => {
    const store = useDrawingsStore.getState();
    if (scope == null) return;
    const ids = store.selectedByScope.get(scope) ?? EMPTY_SELECTION;
    if (ids.length === 0) return;
    const items = store.byScope.get(scope) ?? EMPTY_DRAWINGS;
    // 잠긴 것은 계획 단계에서 뺀다 — 그룹 드래그와 같은 규칙이라, 하나가 잠겼다고
    // 나머지가 함께 얼어붙지 않는다.
    const members = ids
      .map((id) => items.find((x) => x.id === id))
      .filter((d): d is Drawing => d != null && !isLocked(d));
    if (members.length === 0) return;
    const step = big ? 10 : 1;
    const dBar = dragBars.barSized ? dx * step : 0;
    const dyPx = dy * step;
    if (dBar === 0 && dyPx === 0) return;
    store.updateMany(
      scope,
      planGroupTranslate(members, dBar, dyPx, {
        priceToCanvasY,
        canvasYToPrice,
        priceBoundsForPane,
        toBar: dragBars.toBar,
        toReal: dragBars.toReal,
        originBar: dragBars.originBar,
      }),
    );
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
  /**
   * Paint the in-flight 마퀴 by writing styles straight onto its <div>.
   *
   * Why DOM and not the pane primitives, when everything else moved to the
   * canvas: a primitive's canvas is **pane-local** (`ProjectCtx.priceToY`
   * returns pane-local Y), while the marquee is a screen rectangle in the
   * OVERLAY's coordinate frame — the very frame `drawingsInRect` hit-tests in.
   * Drawing it on the pane canvases would mean subtracting each pane's top
   * offset and stitching the box across canvases, and any drift between those
   * two frames would show up as "the box selected something it didn't cover".
   * The usual argument for the canvas (a DOM overlay lags the candles by a
   * frame during a pan) does not apply: the marquee is anchored to the cursor,
   * not to data, and the chart does not pan while it is up.
   *
   * Written imperatively for the same reason the text editor is: `marqueeDraft`
   * is a ref that mutates at pointer cadence, so React never sees it.
   */
  const syncMarqueeBox = () => {
    const el = marqueeBoxRef.current;
    if (!el) return;
    const m = marqueeDraft.current;
    if (!m) {
      el.style.display = 'none';
      return;
    }
    const r = marqueeRect(m.ax, m.ay, m.bx, m.by);
    el.style.display = 'block';
    el.style.transform = `translate(${r.x1}px, ${r.y1}px)`;
    el.style.width = `${r.x2 - r.x1}px`;
    el.style.height = `${r.y2 - r.y1}px`;
  };

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
      {/* 마퀴(Shift+드래그) 선택 상자. 항상 마운트하고 display 로 여닫는다 —
          드래그마다 마운트/언마운트하면 첫 프레임이 React 렌더를 기다린다. */}
      <div
        ref={marqueeBoxRef}
        data-drawing-marquee
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 z-30 border border-dashed border-accent bg-accent/10"
        style={{ display: 'none' }}
      />

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
