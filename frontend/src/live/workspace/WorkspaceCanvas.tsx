/**
 * WorkspaceCanvas(/live) — 코어 캔버스에 /live 결합부를 배선한다 (ADR-0119).
 *
 * 드래그·스냅·좌표계 변환·캔버스 실측은 `workspace/WorkspaceCanvas` 코어가
 * 소유하고, 이 컴포넌트는 /live 전용을 담당한다: 워크스페이스 스토어 어댑팅,
 * 링크 그룹 팔레트 상태, 관심종목/스크리너 행 드래그의 정밀 드롭(entryDrag),
 * 창 콘텐츠(ChartWindow/DataWindow) 렌더.
 */
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { Rect, ResizeMode } from '../../workspace/snapEngine';
import {
  WorkspaceCanvasCore,
  type WindowItemProps,
  type WorkspaceCanvasApi,
} from '../../workspace/WorkspaceCanvas';
import { StockDescriptionTooltipProvider } from '../../heatmap/StockDescriptionTooltip';
import { WindowFrame, type WindowFrameProps } from './WindowFrame';
import { useEntryDragStore } from '../../state/entryDrag';
import { ChartWindow } from './ChartWindow';
import { DataWindow } from './DataWindow';
import { useNxtEnabledResolver, type NxtEnabledResolver } from '../useEffectiveVenue';
import ChartErrorBoundary from '../../chart/ChartErrorBoundary';
import {
  useWorkspaceStore,
  windowSymbolOf,
  type GroupId,
  type GroupSymbol,
  type WorkspaceWindow,
} from '../../state/workspace';

type Mode = 'move' | ResizeMode;
type LiveCanvasApi = WorkspaceCanvasApi<WorkspaceWindow>;
const MajorIndicesWindow = lazy(() => import('./MajorIndicesWindow').then(module => ({ default: module.MajorIndicesWindow })));

/** 창 항목들이 공유하는 /live 컨텍스트 — useMemo 로 안정화해 코어에 주입한다. */
interface LiveItemCtx {
  groupSymbols: Partial<Record<GroupId, GroupSymbol>>;
  resolveNxtEnabled: NxtEnabledResolver;
  paletteId: string | null;
  maximizedId: string | null;
  onToggleMaximize: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePalette: (id: string) => void;
  onPickGroup: (id: string, group: GroupId) => void;
  onTogglePin: (id: string) => void;
}

export function WorkspaceCanvas() {
  const savedWindows = useWorkspaceStore((s) => s.windows);
  const maximizedId = useWorkspaceStore((s) => s.maximizedId);
  const toggleMaximize = useWorkspaceStore((s) => s.toggleMaximize);
  const setCanvasSize = useWorkspaceStore((s) => s.setCanvasSize);
  // 표시만 확장한다. 저장 rect·프리셋·원래 차트 인스턴스는 유지한다.
  const windows = useMemo(() => savedWindows.map((win) => win.id === maximizedId
    ? { ...win, rect: { x: 0, y: 0, w: 1, h: 1 } } : win), [savedWindows, maximizedId]);
  useEffect(() => {
    if (!maximizedId) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // 설정/보조지표 모달을 닫는 Escape가 뒤쪽 창까지 복원하지 않게 한다.
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      toggleMaximize(maximizedId);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [maximizedId, toggleMaximize]);
  const zOrder = useWorkspaceStore((s) => s.zOrder);
  const groupSymbols = useWorkspaceStore((s) => s.groupSymbols);
  const resolveNxtEnabled = useNxtEnabledResolver();
  const closeWindow = useWorkspaceStore((s) => s.closeWindow);
  const focusWindow = useWorkspaceStore((s) => s.focusWindow);
  const setWindowRects = useWorkspaceStore((s) => s.setWindowRects);
  const setWindowGroup = useWorkspaceStore((s) => s.setWindowGroup);
  const onTogglePin = useWorkspaceStore((s) => s.toggleWindowPin);
  const pendingNormalize = useWorkspaceStore((s) => s.pendingNormalize);
  const normalizeLegacyRects = useWorkspaceStore((s) => s.normalizeLegacyRects);

  const [palette, setPalette] = useState<string | null>(null);
  // 코어의 좌표 API — ref 기반이라 참조 안정. 드롭 타깃·리졸버가 소비.
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
  useEffect(() => {
    if (!api) return undefined;
    const hitTest = (clientX: number, clientY: number): boolean => {
      const rect = api.boxRect();
      if (!rect || !api.isUnoccludedAtPoint(clientX, clientY)) return false;
      return clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom;
    };
    registerChartTarget(hitTest);
    return () => clearChartTarget(hitTest);
  }, [api, registerChartTarget, clearChartTarget]);

  // 창별 정밀 드롭 리졸버 — 좌표 아래 z-최상위 창을 찾아 그 창의 종목을 교체한다
  // (포커스 무관, #711). 창을 못 찾으면(캔버스 여백) false → 패널이 클릭 경로로 폴백.
  // 스토어 getState 로 최신 상태를 읽는다(effect deps 없이 안정).
  useEffect(() => {
    if (!api) return undefined;
    const resolver = (
      point: { x: number; y: number },
      entry: { code: string; name?: string },
    ): boolean => {
      const rect = api.boxRect();
      if (!rect || !api.isUnoccludedAtPoint(point.x, point.y)) return false;
      const win = api.windowAtPoint(point.x - rect.left, point.y - rect.top);
      if (!win) return false;
      // 창 스코프의 문(`setWindowSymbol`) — 핀 창이면 그 창 슬롯에, 아니면 종전대로
      // 그 창의 그룹에 쓴다. **핀 창에 종목을 넣는 경로는 이것 하나뿐이다**(클릭은
      // `activationTarget` 이 핀 창을 건너뛴다).
      useWorkspaceStore.getState().setWindowSymbol(win.id, {
        code: entry.code,
        name: entry.name ?? entry.code,
      });
      return true;
    };
    registerChartDropResolver(resolver);
    return () => clearChartDropResolver(resolver);
  }, [api, registerChartDropResolver, clearChartDropResolver]);

  const emptyState = (
    <div className="flex h-full w-full items-center justify-center">
      <div className="rounded-lg bg-bg-card px-6 py-5 text-center text-sm text-fg-dim shadow-panel">
        <p className="mb-2 font-medium text-fg">창이 없습니다</p>
        <p className="mb-3">상단 툴바의 +차트 로 차트 창을 추가하세요</p>
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
      resolveNxtEnabled,
      paletteId: palette,
      maximizedId,
      onToggleMaximize: toggleMaximize,
      onClose: closeWindow,
      onTogglePalette,
      onPickGroup,
      onTogglePin,
    }),
    [groupSymbols, resolveNxtEnabled, palette, maximizedId, toggleMaximize, closeWindow, onTogglePalette, onPickGroup, onTogglePin],
  );

  return (
    <StockDescriptionTooltipProvider>
      <WorkspaceCanvasCore<WorkspaceWindow, LiveItemCtx>
        windows={windows}
        onCanvasSize={setCanvasSize}
        zOrder={zOrder}
        focusWindow={focusWindow}
        setWindowRects={setWindowRects}
        pendingNormalize={pendingNormalize}
        normalizeLegacyRects={normalizeLegacyRects}
        onDragStart={onDragStart}
        windowItem={LiveWindowItem}
        itemCtx={itemCtx}
        emptyState={emptyState}
        onApi={setApi}
      />
    </StockDescriptionTooltipProvider>
  );
}

/**
 * 코어의 `windowItem` 슬롯 — ctx 를 개별 props 로 풀어 memo 경계에 넘긴다.
 * 모듈 스코프 필수(인라인 정의는 렌더마다 리마운트).
 */
function LiveWindowItem({
  win, rect, zIndex, focused, lifting, onHandleDown, onFocus, ctx,
}: WindowItemProps<WorkspaceWindow, LiveItemCtx>) {
  const symbol = windowSymbolOf({ groupSymbols: ctx.groupSymbols }, win);
  return (
    <WorkspaceWindowItem
      win={win}
      symbol={symbol}
      nxtEnabled={symbol ? ctx.resolveNxtEnabled(symbol.code) : undefined}
      rect={rect}
      zIndex={zIndex}
      focused={focused}
      lifting={lifting}
      maximized={ctx.maximizedId === win.id}
      onToggleMaximize={ctx.onToggleMaximize}
      paletteOpen={ctx.paletteId === win.id}
      onHandleDown={onHandleDown}
      onFocus={onFocus}
      onClose={ctx.onClose}
      onTogglePalette={ctx.onTogglePalette}
      onPickGroup={ctx.onPickGroup}
      onTogglePin={ctx.onTogglePin}
    />
  );
}

/**
 * 창 하나 = memo 경계 (리뷰 F6). 코어 캔버스는 드래그 프리뷰 setState 로
 * pointermove 마다 재렌더되는데, map 안에서 children JSX·콜백을 인라인으로
 * 넘기면 WindowFrame 의 memo 가 매번 bail out 실패해 **모든** 차트 창 서브트리
 * (useLiveChartData+LiveChartRoot)가 60fps 로 재렌더된다. 항목을 memo 컴포넌트로
 * 끊고 원시/안정 참조 props 만 넘기면 드래그 중엔 rect 가 바뀐 대상 창 하나만
 * 재렌더된다 — win 객체는 스토어 배열 원소라 드래그 중(로컬 프리뷰) 안정.
 */
const WorkspaceWindowItem = memo(function WorkspaceWindowItem({
  win, symbol, nxtEnabled, rect, zIndex, focused, lifting, paletteOpen, maximized, onToggleMaximize,
  onHandleDown, onFocus, onClose, onTogglePalette, onPickGroup, onTogglePin,
}: {
  win: WorkspaceWindow;
  symbol: GroupSymbol | null;
  nxtEnabled: boolean | null | undefined;
  rect: Rect;
  zIndex: number;
  focused: boolean;
  lifting: boolean;
  paletteOpen: boolean;
  maximized: boolean;
  onToggleMaximize: (id: string) => void;
  onHandleDown: (e: React.PointerEvent, id: string, mode: Mode) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePalette: (id: string) => void;
  onPickGroup: (id: string, group: GroupId) => void;
  onTogglePin: (id: string) => void;
}) {
  // 고정할 종목이 없는 창은 핀을 켤 수 없다 — 스토어 가드(`toggleWindowPin`)와 **같은
  // 술어**를 UI 에도 세워 "눌렀는데 아무 일도 안 남" 을 만들지 않는다.
  const canPin = win.pinned != null || symbol != null;
  const toggleAlwaysOnTop = useWorkspaceStore((s) => s.toggleAlwaysOnTop);
  const setTradeMinAmountManwon = useWorkspaceStore(s => s.setTradeMinAmountManwon);
  const frameProps: Omit<WindowFrameProps, 'children'> = {
    id: win.id, kind: win.kind, group: win.group, rect, zIndex, focused, lifting,
    symbolLabel: symbol?.name ?? null, symbolCode: symbol?.code ?? null,
    nxtEnabled,
    isIndex: symbol?.kind === 'index' || symbol?.kind === 'us_stock', paletteOpen, alwaysOnTop: win.alwaysOnTop,
    onToggleAlwaysOnTop: toggleAlwaysOnTop, maximized, onToggleMaximize,
    pinned: win.pinned != null, canPin, onHandleDown, onFocus, onClose,
    onTogglePalette, onPickGroup, onTogglePin,
    tradeMinAmountManwon: win.tradeMinAmountManwon,
    onTradeMinAmountChange: win.kind === 'trade' ? amount => setTradeMinAmountManwon(win.id, amount) : undefined,
  };
  if (win.kind === 'market-indices') {
    return <ChartErrorBoundary title="주요 지수 창을 표시하지 못했습니다">
      <Suspense fallback={<WindowFrame {...frameProps} headerContent={<span>주요 지수</span>}><div className="p-1 text-xs text-fg-dim">불러오는 중…</div></WindowFrame>}>
        <MajorIndicesWindow frameProps={frameProps} />
      </Suspense>
    </ChartErrorBoundary>;
  }
  return (
    <WindowFrame {...frameProps}>
      {win.kind === 'chart' ? (
        <ChartWindow win={win} symbol={symbol} />
      ) : (
        /* 창 단위 격리 — 차트 창은 내부에 ChartErrorBoundary 가 있지만 데이터 창은
           없어서 10호가·거래원 등에서 throw 하면 React 루트까지 올라가 워크스페이스
           전체가 백지가 됐다. 경계가 창 밖(dispatch)에 있어야 DataWindow 자신의
           훅 throw 까지 잡는다. */
        <ChartErrorBoundary title="창 렌더링에 실패했습니다">
          <DataWindow win={win} symbol={symbol} />
        </ChartErrorBoundary>
      )}
    </WindowFrame>
  );
});
