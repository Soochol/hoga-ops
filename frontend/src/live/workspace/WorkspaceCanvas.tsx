/**
 * WorkspaceCanvas(/live) — 코어 캔버스에 /live 결합부를 배선한다 (ADR-0119).
 *
 * 드래그·스냅·좌표계 변환·캔버스 실측은 `workspace/WorkspaceCanvas` 코어가
 * 소유하고, 이 컴포넌트는 /live 전용을 담당한다: 워크스페이스 스토어 어댑팅,
 * 링크 그룹 팔레트 상태, 관심종목/스크리너 행 드래그의 정밀 드롭(entryDrag),
 * 드롭 어포던스 오버레이, 창 콘텐츠(ChartWindow/DataWindow) 렌더.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toPx } from '../../workspace/rectSpace';
import type { Rect, ResizeMode } from '../../workspace/snapEngine';
import {
  WorkspaceCanvasCore,
  type WindowItemProps,
  type WorkspaceCanvasApi,
} from '../../workspace/WorkspaceCanvas';
import { registerWorkspaceTidy } from '../../workspace/workspaceCanvasControls';
import { WindowFrame } from './WindowFrame';
import { useEntryDragStore } from '../../state/entryDrag';
import { ChartWindow } from './ChartWindow';
import { DataWindow } from './DataWindow';
import {
  useWorkspaceStore,
  type GroupId,
  type GroupSymbol,
  type WorkspaceWindow,
} from '../../state/workspace';

type Mode = 'move' | ResizeMode;
type LiveCanvasApi = WorkspaceCanvasApi<WorkspaceWindow>;

/** 창 항목들이 공유하는 /live 컨텍스트 — useMemo 로 안정화해 코어에 주입한다. */
interface LiveItemCtx {
  groupSymbols: Partial<Record<GroupId, GroupSymbol>>;
  paletteId: string | null;
  onClose: (id: string) => void;
  onTogglePalette: (id: string) => void;
  onPickGroup: (id: string, group: GroupId) => void;
}

export function WorkspaceCanvas() {
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

  const [palette, setPalette] = useState<string | null>(null);
  // 코어의 좌표 API — ref 기반이라 참조 안정. 드롭 리졸버·어포던스가 소비.
  const [api, setApi] = useState<LiveCanvasApi | null>(null);

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
  // 드래그 시작 = 열린 팔레트 닫기(코어 훅).
  const onDragStart = useCallback(() => setPalette(null), []);

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
    if (!api) return undefined;
    const hitTest = (clientX: number, clientY: number): boolean => {
      const rect = api.boxRect();
      if (!rect) return false;
      return clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom;
    };
    registerChartTarget(hitTest);
    return () => clearChartTarget(hitTest);
  }, [api, registerChartTarget, clearChartTarget]);

  // 창별 정밀 드롭 리졸버 — 좌표 아래 z-최상위 창을 찾아 그 창의 그룹 종목을 교체
  // 한다(포커스 무관, #711). 창을 못 찾으면(캔버스 여백) false → 패널이 활성 그룹
  // 교체로 폴백. 스토어 getState 로 최신 상태를 읽는다(effect deps 없이 안정).
  useEffect(() => {
    if (!api) return undefined;
    const resolver = (
      point: { x: number; y: number },
      entry: { code: string; name?: string },
    ): boolean => {
      const rect = api.boxRect();
      if (!rect) return false;
      const win = api.windowAtPoint(point.x - rect.left, point.y - rect.top);
      if (!win) return false;
      useWorkspaceStore.getState().setGroupSymbol(win.group, {
        code: entry.code,
        name: entry.name ?? entry.code,
      });
      return true;
    };
    registerChartDropResolver(resolver);
    return () => clearChartDropResolver(resolver);
  }, [api, registerChartDropResolver, clearChartDropResolver]);

  // 드래그 중 호버 창(어포던스용) — dragPoint 아래 z-최상위 창. DOM 측정
  // (getBoundingClientRect)은 effect 에서만(렌더 중 ref 접근 금지 규율). dragPoint 는
  // 패널이 프레임당 throttle 해 발행하므로 재계산 빈도가 낮다. 창 밖이면 null →
  // 캔버스 전면 오버레이(활성 그룹 교체)로 폴백.
  const [hoverDropWin, setHoverDropWin] = useState<WorkspaceWindow | null>(null);
  useEffect(() => {
    // rAF 로 측정+setState 를 커밋 이후로 미룬다 — 렌더 중 ref 접근·effect 내 동기
    // setState 를 둘 다 피한다(react-compiler 규율). 드래그는 저빈도라 무해.
    const raf = requestAnimationFrame(() => {
      if (!draggingEntry || !dragPoint || !api) {
        setHoverDropWin((prev) => (prev === null ? prev : null));
        return;
      }
      const rect = api.boxRect();
      const next = rect ? api.windowAtPoint(dragPoint.x - rect.left, dragPoint.y - rect.top) : null;
      setHoverDropWin((prev) => (prev?.id === next?.id ? prev : next));
    });
    return () => cancelAnimationFrame(raf);
  }, [draggingEntry, dragPoint, api]);

  // 호버 창 하이라이트는 px 로 그린다 — 스토어 rect 는 비율(ADR-0122)이라 그대로
  // style 에 넣으면 1px 근처로 붕괴한다(일반화 이전의 잔존 버그 수정).
  const hoverDropRect: Rect | null =
    hoverDropWin && api ? toPx(hoverDropWin.rect, api.canvasSize()) : null;

  const overlays = (
    <>
      {/* 행 드래그 드롭 어포던스. 창 위 = 그 창 하이라이트(정밀 드롭, 그룹 N 교체),
          창 밖 = 캔버스 전면(활성 그룹 교체). #711 PR-D2. */}
      {draggingEntry && hoverDropWin && hoverDropRect && (
        <div
          aria-hidden
          data-testid="workspace-drop-window-highlight"
          className="pointer-events-none absolute z-40 flex items-center justify-center rounded-md"
          style={{
            left: hoverDropRect.x,
            top: hoverDropRect.y,
            width: hoverDropRect.w,
            height: hoverDropRect.h,
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
    </>
  );

  const emptyState = (
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
  );

  const itemCtx = useMemo<LiveItemCtx>(
    () => ({
      groupSymbols,
      paletteId: palette,
      onClose: closeWindow,
      onTogglePalette,
      onPickGroup,
    }),
    [groupSymbols, palette, closeWindow, onTogglePalette, onPickGroup],
  );

  return (
    <WorkspaceCanvasCore<WorkspaceWindow, LiveItemCtx>
      windows={windows}
      zOrder={zOrder}
      focusWindow={focusWindow}
      setWindowRects={setWindowRects}
      tidyAll={tidyAll}
      pendingNormalize={pendingNormalize}
      normalizeLegacyRects={normalizeLegacyRects}
      registerTidy={registerWorkspaceTidy}
      onDragStart={onDragStart}
      windowItem={LiveWindowItem}
      itemCtx={itemCtx}
      emptyState={emptyState}
      onApi={setApi}
      overlays={overlays}
    />
  );
}

/**
 * 코어의 `windowItem` 슬롯 — ctx 를 개별 props 로 풀어 memo 경계에 넘긴다.
 * 모듈 스코프 필수(인라인 정의는 렌더마다 리마운트).
 */
function LiveWindowItem({
  win, rect, zIndex, focused, onHandleDown, onFocus, ctx,
}: WindowItemProps<WorkspaceWindow, LiveItemCtx>) {
  return (
    <WorkspaceWindowItem
      win={win}
      symbol={ctx.groupSymbols[win.group] ?? null}
      rect={rect}
      zIndex={zIndex}
      focused={focused}
      paletteOpen={ctx.paletteId === win.id}
      onHandleDown={onHandleDown}
      onFocus={onFocus}
      onClose={ctx.onClose}
      onTogglePalette={ctx.onTogglePalette}
      onPickGroup={ctx.onPickGroup}
    />
  );
}

/**
 * 창 하나 = memo 경계 (리뷰 F6). 코어 캔버스는 드래그 프리뷰 setState 로
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
