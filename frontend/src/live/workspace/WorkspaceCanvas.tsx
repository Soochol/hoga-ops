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
import { useCallback, useEffect, useRef, useState } from 'react';
import { WindowFrame } from './WindowFrame';
import { registerWorkspaceTidy } from './workspaceCanvasControls';
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

  // 드래그 중 프리뷰(스토어 미커밋). null = 유휴.
  const [preview, setPreview] = useState<Map<string, Rect> | null>(null);
  const [guides, setGuides] = useState<Guides>({ v: null, h: null });
  const [zone, setZone] = useState<SnapZone>(null);
  const [palette, setPalette] = useState<string | null>(null);

  const focusedId = zOrder[zOrder.length - 1];

  const rectOf = (w: WorkspaceWindow): Rect => preview?.get(w.id) ?? w.rect;

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
    if (updates.length > 0) setWindowRects(updates);
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

      const others: RectWin[] = windows.filter((w) => w.id !== id).map((w) => ({ id: w.id, rect: w.rect }));
      let followers: RectWin[] = [];
      if ((PURE_EDGES as readonly string[]).includes(mode)) {
        const ids = new Set(detectFollowers(win.rect, mode as Edge, others));
        followers = others.filter((o) => ids.has(o.id));
      }
      dragRef.current = {
        mode,
        id,
        px: e.clientX,
        py: e.clientY,
        origin: { ...win.rect },
        followers,
        canvas: { w: box.width, h: box.height },
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
      const others: RectWin[] = windows
        .filter((w) => w.id !== d.id)
        .map((w) => ({ id: w.id, rect: w.rect }));

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

  // 정리(Tidy) 트리거는 고정 툴바(WorkspaceLiveToolbar)에 있다 — 캔버스 실측이
  // 필요한 실행기를 명령 채널에 등록(C2c-2c, 임시 플로팅 툴바 대체).
  useEffect(() => registerWorkspaceTidy(onTidy), [onTidy]);

  const symbolFor = (group: GroupId) => groupSymbols[group] ?? null;

  return (
    <div
      ref={boxRef}
      className="relative h-full min-h-0 w-full overflow-hidden bg-bg"
      onPointerMove={onPointerMove}
      onPointerUp={commit}
      onPointerCancel={endDrag}
      onLostPointerCapture={commit}
    >
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
          <div className="rounded-lg border border-border bg-bg-card px-6 py-5 text-center text-[12px] text-fg-dim shadow-panel">
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
      {windows.map((w) => {
        const symbol = symbolFor(w.group);
        return (
          <WindowFrame
            key={w.id}
            id={w.id}
            kind={w.kind}
            group={w.group}
            rect={rectOf(w)}
            zIndex={Math.max(0, zOrder.indexOf(w.id))}
            focused={w.id === focusedId}
            symbolLabel={symbol?.name ?? null}
            symbolCode={symbol?.code ?? null}
            paletteOpen={palette === w.id}
            onHandleDown={onHandleDown}
            onFocus={focusWindow}
            onClose={closeWindow}
            onTogglePalette={(id) => {
              // 팔레트를 여는 창을 최상단으로 올린다 — 각 창이 contain:paint 로 자체
              // 스택 컨텍스트라, 창을 raise 하지 않으면 겹친 상위 창이 팔레트를 가린다.
              // (뱃지 onPointerDown stopPropagation 이 루트 onFocus 를 막으므로 여기서 명시.)
              focusWindow(id);
              setPalette((p) => (p === id ? null : id));
            }}
            onPickGroup={(id, g) => {
              setWindowGroup(id, g);
              setPalette(null);
            }}
          >
            {w.kind === 'chart' ? (
              <ChartWindow win={w} symbol={symbol} />
            ) : (
              <DataWindow win={w} symbol={symbol} />
            )}
          </WindowFrame>
        );
      })}
    </div>
  );
}
