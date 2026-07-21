/**
 * WorkspaceCanvas — 멀티창 워크스페이스 컨테이너 (ADR-0119).
 *
 * 스냅 엔진(`snapEngine.ts`)에 포인터 좌표를 위임해 창 이동·8방향 리사이즈·
 * 스플리터 승격·반분할 스냅존을 구동하고, `useWorkspaceStore` 를 읽어 WindowFrame
 * 배열을 렌더한다. 드래그 중에는 로컬 preview 로만 렌더하고 드롭 시 스토어에
 * 커밋한다(#710: 이동=transform 프리뷰 + 드롭 시 rect 커밋, localStorage 스래싱 회피).
 *
 * PR-A 는 스캐폴딩 — 창 본문은 더미다. 실제 차트/데이터 배선은 PR-C.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toFrac, toPx } from './rectSpace';
import { WindowFrame } from './WindowFrame';
import { registerWorkspaceTidy } from './workspaceCanvasControls';
import { useEntryDragStore } from '../../state/entryDrag';
import { ChartWindow } from './ChartWindow';
import { DataWindow } from './DataWindow';
import {
  computeMove,
  computeResize,
  detectFollowers,
  snapZone,
  zoneRect,
  type Guides,
  type Rect,
  type RectWin,
  type ResizeMode,
  type Edge,
  type SnapZone,
  type Canvas,
} from './snapEngine';
import {
  useWorkspaceStore,
  type GroupId,
  type GroupSymbol,
  type WorkspaceWindow,
} from '../../state/workspace';

type Mode = 'move' | ResizeMode;

interface DragState {
  mode: Mode;
  id: string;
  px: number;
  py: number;
  origin: Rect;
  followers: RectWin[]; // 스플리터 승격 대상(원본 rect)
  canvas: Canvas;
  canvasLeft: number;
  // 커밋은 이 mutable 필드에서 읽는다(React state 플러시 타이밍에 의존하지 않도록).
  // preview/zone state 는 렌더 전용, 이 필드가 진실.
  liveRects: Map<string, Rect> | null;
  liveZone: SnapZone;
}

const PURE_EDGES: readonly Edge[] = ['e', 'w', 'n', 's'];

export function WorkspaceCanvas() {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const windows = useWorkspaceStore((s) => s.windows);
  const zOrder = useWorkspaceStore((s) => s.zOrder);
  const groupSymbols = useWorkspaceStore((s) => s.groupSymbols);
  const closeWindow = useWorkspaceStore((s) => s.closeWindow);
  const focusWindow = useWorkspaceStore((s) => s.focusWindow);
  const setWindowRects = useWorkspaceStore((s) => s.setWindowRects);
  const setWindowGroup = useWorkspaceStore((s) => s.setWindowGroup);
  const tidyAll = useWorkspaceStore((s) => s.tidyAll);
  const pendingNormalize = useWorkspaceStore((s) => s.pendingNormalize);
  const normalizeLegacyRects = useWorkspaceStore((s) => s.normalizeLegacyRects);

  // 드래그 중 프리뷰(스토어 미커밋). null = 유휴.
  const [preview, setPreview] = useState<Map<string, Rect> | null>(null);
  const [guides, setGuides] = useState<Guides>({ v: null, h: null });
  const [zone, setZone] = useState<SnapZone>(null);
  const [palette, setPalette] = useState<string | null>(null);

  // zOrder 의 마지막 = 최상단 창. 헤더 틴트의 유일한 소비처.
  const focusedId = zOrder[zOrder.length - 1];

  // 렌더는 px. 프리뷰(드래그 중)는 이미 px 이고, 그 외에는 스토어의 비율을 현재
  // 캔버스로 편다 — 캔버스가 줄면 창도 같은 비율로 줄어 배치가 보존된다(ADR-0122).
  const rectOf = (w: WorkspaceWindow): Rect => preview?.get(w.id) ?? toPx(w.rect, canvasBox);

  /** 드래그 종료(커밋 없이) — 상태만 리셋. pointercancel/abort 경로가 공유. */
  const endDrag = useCallback(() => {
    dragRef.current = null;
    setPreview(null);
    setGuides({ v: null, h: null });
    setZone(null);
  }, []);

  const commit = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    // 커밋은 ref(진실)에서 읽는다 — React state 는 렌더 전용이라 합성 이벤트 배칭
    // 하에서 플러시가 늦을 수 있다(#714 함정). idempotent — endDrag 후 재호출은 no-op.
    let updates: { id: string; rect: Rect }[] = [];
    if (d.mode === 'move' && d.liveZone) {
      updates = [{ id: d.id, rect: zoneRect(d.liveZone, d.canvas) }];
    } else if (d.liveRects) {
      updates = [...d.liveRects.entries()].map(([id, rect]) => ({ id, rect }));
    }
    // 드래그·스냅은 전부 px 로 계산했다(snapEngine 무변경). 스토어 경계에서만
    // 드래그 당시의 캔버스 기준 비율로 되돌린다 — ADR-0122.
    if (updates.length > 0) {
      setWindowRects(updates.map((u) => ({ id: u.id, rect: toFrac(u.rect, d.canvas) })));
    }
    endDrag();
  }, [setWindowRects, endDrag]);

  const onHandleDown = useCallback(
    (e: React.PointerEvent, id: string, mode: Mode) => {
      const win = windows.find((w) => w.id === id);
      const box = boxRef.current?.getBoundingClientRect();
      if (!win || !box) return;
      e.preventDefault();
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // 합성(비신뢰) 이벤트는 활성 포인터가 없어 캡처가 실패할 수 있음 — onPointerMove 로 지속.
      }
      focusWindow(id);
      setPalette(null);

      // 스토어는 비율을 들고 있다 — 드래그에 들어가는 순간 px 로 편다(ADR-0122).
      const canvas = { w: box.width, h: box.height };
      const originPx = toPx(win.rect, canvas);
      const others: RectWin[] = windows
        .filter((w) => w.id !== id)
        .map((w) => ({ id: w.id, rect: toPx(w.rect, canvas) }));
      let followers: RectWin[] = [];
      if ((PURE_EDGES as readonly string[]).includes(mode)) {
        const ids = new Set(detectFollowers(originPx, mode as Edge, others));
        followers = others.filter((o) => ids.has(o.id));
      }
      dragRef.current = {
        mode,
        id,
        px: e.clientX,
        py: e.clientY,
        origin: originPx,
        followers,
        canvas,
        canvasLeft: box.left,
        liveRects: null,
        liveZone: null,
      };
    },
    [windows, focusWindow],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // 버튼이 놓인 상태의 move 는 유령 드래그 — pointerup/cancel 을 놓친 뒤의
      // 첫 hover 에서 창이 커서에 달라붙는 것을 막는다. 마지막 위치로 커밋해 종료.
      if (e.buttons === 0) {
        commit();
        return;
      }
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      // 이웃도 드래그 당시 캔버스 기준 px 로 편다 — 흡착 임계(12px)가 px 단위라
      // 비율을 그대로 넘기면 전부 0 근처가 되어 흡착이 죽는다.
      const others: RectWin[] = windows
        .filter((w) => w.id !== d.id)
        .map((w) => ({ id: w.id, rect: toPx(w.rect, d.canvas) }));

      if (d.mode === 'move') {
        const r = computeMove({ origin: d.origin, dx, dy, others, canvas: d.canvas, alt: e.altKey });
        const next = new Map([[d.id, { ...d.origin, x: r.x, y: r.y }]]);
        const z = snapZone(e.clientX - d.canvasLeft, d.canvas, e.altKey);
        d.liveRects = next;
        d.liveZone = z;
        setPreview(next);
        setGuides(r.guides);
        setZone(z);
        return;
      }

      const r = computeResize({
        origin: d.origin,
        mode: d.mode,
        dx,
        dy,
        others,
        followers: d.followers,
        canvas: d.canvas,
        alt: e.altKey,
      });
      const next = new Map<string, Rect>([[d.id, r.rect]]);
      for (const f of r.followers) next.set(f.id, f.rect);
      d.liveRects = next;
      setPreview(next);
      setGuides(r.guides);
    },
    [windows, commit],
  );

  const onTidy = useCallback(() => {
    const box = boxRef.current?.getBoundingClientRect();
    if (box) tidyAll({ w: box.width, h: box.height });
  }, [tidyAll]);

  // 캔버스 실측 크기 — 비율 rect 를 px 로 펴는 기준(ADR-0122). 캔버스가 줄면 이
  // 값만 바뀌고 창들은 자동으로 같은 비율을 유지한다.
  // useLayoutEffect: 첫 페인트 전에 크기를 확보해야 창이 0px 로 한 프레임 깜빡이지
  // 않는다. 초기값을 동기로 읽는 이유는 ResizeObserver 가 없는 환경(jsdom)에서도
  // 좌표 변환이 살아 있어야 하기 때문(useChartHeaderCompact 와 같은 가드 패턴).
  const [canvasBox, setCanvasBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // 안정 콜백(windowAtPoint 등)이 최신 캔버스를 읽기 위한 미러 — state 를 deps 에
  // 넣으면 드롭 리졸버 등록이 리사이즈마다 재등록된다.
  const canvasRef = useRef(canvasBox);
  canvasRef.current = canvasBox;
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setCanvasBox({ w: el.clientWidth, h: el.clientHeight });
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setCanvasBox({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 레거시 px 저장값 → 비율 1회 변환. 캔버스가 자기 크기를 처음 알게 된 이 시점이
  // 유일하게 올바른 기준이다 — 사용자가 지금 보고 있는 화면으로 나누므로 변환
  // 직후 배치에 눈에 보이는 변화가 없다(ADR-0122).
  useLayoutEffect(() => {
    if (!pendingNormalize || canvasBox.w <= 0 || canvasBox.h <= 0) return;
    normalizeLegacyRects(canvasBox);
  }, [pendingNormalize, canvasBox, normalizeLegacyRects]);

  // 창 항목 memo(F6)를 위한 안정 콜백 — id 를 인자로 받으므로 창별 클로저 불필요.
  const onTogglePalette = useCallback((id: string) => {
    // 팔레트를 여는 창을 최상단으로 올린다 — 각 창이 contain:paint 로 자체 스택
    // 컨텍스트라, raise 하지 않으면 겹친 상위 창이 팔레트를 가린다.
    focusWindow(id);
    setPalette((p) => (p === id ? null : id));
  }, [focusWindow]);
  const onPickGroup = useCallback((id: string, g: GroupId) => {
    setWindowGroup(id, g);
    setPalette(null);
  }, [setWindowGroup]);

  // 로컬 좌표 아래 z-최상위 창(겹친 창 = 위 창 승리). 스토어 getState 로 최신 창
  // 배열·rect 를 읽어 정밀 드롭 리졸버(effect)와 어포던스(render)가 공유한다.
  const windowAtPoint = useCallback((localX: number, localY: number): WorkspaceWindow | null => {
    const state = useWorkspaceStore.getState();
    for (let i = state.zOrder.length - 1; i >= 0; i--) {
      const win = state.windows.find((w) => w.id === state.zOrder[i]);
      if (!win) continue;
      // 인자는 캔버스 로컬 px 이므로 비율 rect 를 px 로 펴서 비교한다(ADR-0122).
      const r = toPx(win.rect, canvasRef.current);
      if (localX >= r.x && localX <= r.x + r.w && localY >= r.y && localY <= r.y + r.h) {
        return win;
      }
    }
    return null;
  }, []);

  // 정리(Tidy) 트리거는 고정 툴바(WorkspaceLiveToolbar)에 있다 — 캔버스 실측이
  // 필요한 실행기를 명령 채널에 등록(C2c-2c, 임시 플로팅 툴바 대체).
  useEffect(() => registerWorkspaceTidy(onTidy), [onTidy]);

  // 관심종목/스크리너 행 드래그의 차트 드롭 타깃(entryDrag seam) — 구 LiveWorkarea 의
  // 등록을 캔버스가 승계한다(C2c-2e 회귀 복구). 창 밖(여백) 드롭=활성 그룹 종목
  // 교체(onPick 폴백), 창 위 드롭=그 창 그룹 종목 교체(정밀 드롭, PR-D2 #711).
  const registerChartTarget = useEntryDragStore((s) => s.registerChartTarget);
  const clearChartTarget = useEntryDragStore((s) => s.clearChartTarget);
  const registerChartDropResolver = useEntryDragStore((s) => s.registerChartDropResolver);
  const clearChartDropResolver = useEntryDragStore((s) => s.clearChartDropResolver);
  // 드롭 어포던스(리뷰 F1 복구): 행 드래그 고스트는 패널 overflow 에서 잘리므로
  // 캔버스 자체가 유일한 드롭 표시다 — 구 LiveWorkarea ChartDropOverlay 이관.
  const draggingEntry = useEntryDragStore((s) => s.draggingCode != null);
  const overChart = useEntryDragStore((s) => s.overChart);
  const dragPoint = useEntryDragStore((s) => s.dragPoint);
  useEffect(() => {
    const hitTest = (clientX: number, clientY: number): boolean => {
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect) return false;
      return clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom;
    };
    registerChartTarget(hitTest);
    return () => clearChartTarget(hitTest);
  }, [registerChartTarget, clearChartTarget]);

  // 창별 정밀 드롭 리졸버 — 좌표 아래 z-최상위 창을 찾아 그 창의 그룹 종목을 교체
  // 한다(포커스 무관, #711). 창을 못 찾으면(캔버스 여백) false → 패널이 활성 그룹
  // 교체로 폴백. 스토어 getState 로 최신 창 배열/rect 를 읽는다(effect deps 없이 안정).
  useEffect(() => {
    const resolver = (
      point: { x: number; y: number },
      entry: { code: string; name?: string },
    ): boolean => {
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const win = windowAtPoint(point.x - rect.left, point.y - rect.top);
      if (!win) return false;
      useWorkspaceStore.getState().setGroupSymbol(win.group, {
        code: entry.code,
        name: entry.name ?? entry.code,
      });
      return true;
    };
    registerChartDropResolver(resolver);
    return () => clearChartDropResolver(resolver);
  }, [registerChartDropResolver, clearChartDropResolver, windowAtPoint]);

  const symbolFor = (group: GroupId) => groupSymbols[group] ?? null;

  // 드래그 중 호버 창(어포던스용) — dragPoint 아래 z-최상위 창. DOM 측정
  // (getBoundingClientRect)은 effect 에서만(렌더 중 ref 접근 금지 규율). dragPoint 는
  // 패널이 프레임당 throttle 해 발행하므로 재계산 빈도가 낮다. 창 밖이면 null →
  // 캔버스 전면 오버레이(활성 그룹 교체)로 폴백.
  const [hoverDropWin, setHoverDropWin] = useState<WorkspaceWindow | null>(null);
  useEffect(() => {
    // rAF 로 측정+setState 를 커밋 이후로 미룬다 — 렌더 중 ref 접근·effect 내 동기
    // setState 를 둘 다 피한다(react-compiler 규율). 드래그는 저빈도라 무해.
    const raf = requestAnimationFrame(() => {
      if (!draggingEntry || !dragPoint) {
        setHoverDropWin((prev) => (prev === null ? prev : null));
        return;
      }
      const rect = boxRef.current?.getBoundingClientRect();
      const next = rect ? windowAtPoint(dragPoint.x - rect.left, dragPoint.y - rect.top) : null;
      setHoverDropWin((prev) => (prev?.id === next?.id ? prev : next));
    });
    return () => cancelAnimationFrame(raf);
  }, [draggingEntry, dragPoint, windowAtPoint]);

  return (
    <div
      ref={boxRef}
      className="relative h-full min-h-0 w-full overflow-hidden bg-bg"
      onPointerMove={onPointerMove}
      onPointerUp={commit}
      onPointerCancel={endDrag}
      onLostPointerCapture={commit}
    >
      {/* 행 드래그 드롭 어포던스. 창 위 = 그 창 하이라이트(정밀 드롭, 그룹 N 교체),
          창 밖 = 캔버스 전면(활성 그룹 교체). #711 PR-D2. */}
      {draggingEntry && hoverDropWin && (
        <div
          aria-hidden
          data-testid="workspace-drop-window-highlight"
          className="pointer-events-none absolute z-40 flex items-center justify-center rounded-md"
          style={{
            left: hoverDropWin.rect.x,
            top: hoverDropWin.rect.y,
            width: hoverDropWin.rect.w,
            height: hoverDropWin.rect.h,
            background: 'var(--tint-selection)',
            border: '2px solid var(--accent)',
            transition: 'left 150ms ease-in-out, top 150ms ease-in-out, width 150ms ease-in-out, height 150ms ease-in-out',
          }}
        >
          <span
            className="rounded-md font-ui text-sm font-semibold"
            style={{
              padding: 'var(--space-sm) var(--space-md)',
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
              boxShadow: 'var(--shadow-overlay)',
            }}
          >
            그룹 {hoverDropWin.group} 종목 교체
          </span>
        </div>
      )}
      {draggingEntry && !hoverDropWin && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center"
          style={{
            background: overChart ? 'var(--tint-selection)' : 'transparent',
            border: '2px dashed var(--accent)',
            opacity: overChart ? 1 : 0.7,
            transition: 'opacity 150ms ease, background 150ms ease',
          }}
        >
          <span
            className="rounded-md font-ui text-sm font-semibold"
            style={{
              padding: 'var(--space-sm) var(--space-md)',
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
              boxShadow: 'var(--shadow-overlay)',
              transform: overChart ? 'scale(1)' : 'scale(0.97)',
              transition: 'transform 150ms ease',
            }}
          >
            여기에 놓아 활성 그룹 종목 변경
          </span>
        </div>
      )}
      {/* 반분할 스냅존 미리보기 */}
      {zone && (
        <div
          className="pointer-events-none absolute inset-y-0 z-40 border border-accent bg-tint-selection"
          style={zone === 'left' ? { left: 0, width: '50%' } : { right: 0, width: '50%' }}
        />
      )}
      {/* 자석 가이드라인 */}
      {guides.v !== null && (
        <div className="pointer-events-none absolute inset-y-0 z-40 w-px bg-accent" style={{ left: guides.v }} />
      )}
      {guides.h !== null && (
        <div className="pointer-events-none absolute inset-x-0 z-40 h-px bg-accent" style={{ top: guides.h }} />
      )}

      {windows.length === 0 && (
        <div className="flex h-full w-full items-center justify-center">
          <div className="rounded-lg bg-bg-card px-6 py-5 text-center text-sm text-fg-dim shadow-panel">
            <p className="mb-2 font-medium text-fg">창이 없습니다</p>
            <p className="mb-3">상단 툴바의 +차트 로 차트 창을 추가하세요.</p>
            <button
              type="button"
              data-testid="workspace-empty-add-chart"
              className="rounded bg-tint-selection px-3 py-1 font-medium text-accent hover:brightness-110"
              onClick={() => useWorkspaceStore.getState().addWindow('chart')}
            >
              +차트 창 추가
            </button>
          </div>
        </div>
      )}
      {windows.map((w) => (
        <WorkspaceWindowItem
          key={w.id}
          win={w}
          symbol={symbolFor(w.group)}
          rect={rectOf(w)}
          zIndex={Math.max(0, zOrder.indexOf(w.id))}
          focused={w.id === focusedId}
          paletteOpen={palette === w.id}
          onHandleDown={onHandleDown}
          onFocus={focusWindow}
          onClose={closeWindow}
          onTogglePalette={onTogglePalette}
          onPickGroup={onPickGroup}
        />
      ))}
    </div>
  );
}

/**
 * 창 하나 = memo 경계 (리뷰 F6). WorkspaceCanvas 는 드래그 프리뷰 setState 로
 * pointermove 마다 재렌더되는데, map 안에서 children JSX·콜백을 인라인으로
 * 넘기면 WindowFrame 의 memo 가 매번 bail out 실패해 **모든** 차트 창 서브트리
 * (useLiveChartData+LiveChartRoot)가 60fps 로 재렌더된다. 항목을 memo 컴포넌트로
 * 끊고 원시/안정 참조 props 만 넘기면 드래그 중엔 rect 가 바뀐 창(드래그+follower)만
 * 재렌더된다 — win 객체는 스토어 배열 원소라 드래그 중(로컬 프리뷰) 안정.
 */
const WorkspaceWindowItem = memo(function WorkspaceWindowItem({
  win, symbol, rect, zIndex, focused, paletteOpen,
  onHandleDown, onFocus, onClose, onTogglePalette, onPickGroup,
}: {
  win: WorkspaceWindow;
  symbol: GroupSymbol | null;
  rect: Rect;
  zIndex: number;
  focused: boolean;
  paletteOpen: boolean;
  onHandleDown: (e: React.PointerEvent, id: string, mode: Mode) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePalette: (id: string) => void;
  onPickGroup: (id: string, group: GroupId) => void;
}) {
  return (
    <WindowFrame
      id={win.id}
      kind={win.kind}
      group={win.group}
      rect={rect}
      zIndex={zIndex}
      focused={focused}
      symbolLabel={symbol?.name ?? null}
      symbolCode={symbol?.code ?? null}
      paletteOpen={paletteOpen}
      onHandleDown={onHandleDown}
      onFocus={onFocus}
      onClose={onClose}
      onTogglePalette={onTogglePalette}
      onPickGroup={onPickGroup}
    >
      {win.kind === 'chart' ? (
        <ChartWindow win={win} symbol={symbol} />
      ) : (
        <DataWindow win={win} symbol={symbol} />
      )}
    </WindowFrame>
  );
});
