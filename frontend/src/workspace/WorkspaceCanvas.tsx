/**
 * WorkspaceCanvas(코어) — 멀티창 워크스페이스 컨테이너의 페이지 중립 코어
 * (ADR-0119/0122/0123).
 *
 * 스냅 엔진(`snapEngine.ts`)에 포인터 좌표를 위임해 창 이동·8방향 리사이즈·
 * 스플리터 승격·반분할 스냅존을 구동하고, props 로 받은 창 목록을 `renderWindow`
 * 로 렌더한다. 드래그 중에는 로컬 preview 로만 렌더하고 드롭 시 `setWindowRects`
 * 로 커밋한다(#710: 이동=transform 프리뷰 + 드롭 시 rect 커밋, localStorage
 * 스래싱 회피).
 *
 * 페이지 결합(스토어·창 콘텐츠·드롭 의미론·팔레트)은 전부 주입이다:
 * /live 는 `live/workspace/WorkspaceCanvas.tsx` 가 이 코어에 워크스페이스 스토어와
 * entryDrag 드롭을 배선한다. 좌표계는 ADR-0122 — 스토어는 비율(0~1), 계산·렌더는
 * px, 변환은 이 코어 한 곳에서만.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toFrac, toPx, type FracRect } from './rectSpace';
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

/** 코어가 창에 요구하는 최소 형태 — 페이지 스토어의 창 타입이 이걸 충족한다. */
export interface WorkspaceWindowLike {
  id: string;
  rect: FracRect;
}

/**
 * 창 항목 컴포넌트(`windowItem`)가 받는 props. 콜백은 코어가 소유(안정 참조),
 * `ctx` 는 페이지가 `itemCtx` 로 주입한 불투명 컨텍스트(팔레트 상태·스토어 액션 등).
 * 함수 호출(render prop)이 아니라 JSX 컴포넌트 경계인 이유: 렌더 중 함수 호출은
 * ref 를 만지는 콜백(onHandleDown)이 렌더 중 실행될 수 있다고 react-hooks 룰이
 * 보수적으로 판정하고, 컴포넌트 경계가 memo 최적화에도 유리하다.
 */
export interface WindowItemProps<W extends WorkspaceWindowLike, C> {
  win: W;
  /** 현재 캔버스 기준 px rect(드래그 중엔 프리뷰). */
  rect: Rect;
  zIndex: number;
  focused: boolean;
  onHandleDown: (e: React.PointerEvent, id: string, mode: Mode) => void;
  onFocus: (id: string) => void;
  ctx: C;
}

/** 페이지 오버레이(드롭 어포던스 등)가 소비하는 캔버스 좌표 API. 참조 안정. */
export interface WorkspaceCanvasApi<W extends WorkspaceWindowLike> {
  /** 캔버스 로컬 px 좌표 아래 z-최상위 창(겹친 창 = 위 창 승리). 없으면 null. */
  windowAtPoint(localX: number, localY: number): W | null;
  /** 캔버스 DOM rect. 미마운트면 null. */
  boxRect(): DOMRect | null;
  /** 캔버스 실측 크기 — 비율 rect 를 px 로 펴는 기준. */
  canvasSize(): Canvas;
}

export interface WorkspaceCanvasCoreProps<W extends WorkspaceWindowLike, C> {
  windows: W[];
  /** 마지막 원소 = 최상단(포커스) 창. */
  zOrder: string[];
  focusWindow: (id: string) => void;
  setWindowRects: (updates: { id: string; rect: FracRect }[]) => void;
  tidyAll: (canvas: Canvas) => void;
  /** 레거시 px rect 마이그레이션 대기 여부(ADR-0122). 없으면 항상 비율로 간주. */
  pendingNormalize?: boolean;
  normalizeLegacyRects?: (canvas: Canvas) => void;
  /** Tidy 실행기를 페이지 명령 채널에 등록. cleanup 을 반환해야 한다. */
  registerTidy?: (run: () => void) => () => void;
  /** 드래그 시작 훅 — 페이지 팝오버(팔레트 등) 닫기용. */
  onDragStart?: (id: string) => void;
  /** 창 하나를 렌더하는 페이지 컴포넌트 — **모듈 스코프**여야 한다(인라인 정의는
   * 렌더마다 타입이 바뀌어 서브트리가 리마운트된다). */
  windowItem: React.ComponentType<WindowItemProps<W, C>>;
  /** `windowItem` 에 그대로 전달되는 페이지 컨텍스트 — useMemo 로 안정화할 것. */
  itemCtx: C;
  /** 창 0개일 때 렌더할 노드. */
  emptyState?: React.ReactNode;
  /** 좌표 API 전달 — 마운트 시 api, 언마운트 시 null. */
  onApi?: (api: WorkspaceCanvasApi<W> | null) => void;
  /** 캔버스 위에 얹는 페이지 오버레이(자석 가이드와 같은 z-40 계층). */
  overlays?: React.ReactNode;
}

export function WorkspaceCanvasCore<W extends WorkspaceWindowLike, C>(
  props: WorkspaceCanvasCoreProps<W, C>,
) {
  const {
    windows,
    zOrder,
    focusWindow,
    setWindowRects,
    tidyAll,
    pendingNormalize,
    normalizeLegacyRects,
    registerTidy,
    onDragStart,
    windowItem: WindowItem,
    itemCtx,
    emptyState,
    onApi,
    overlays,
  } = props;

  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // 드래그 중 프리뷰(스토어 미커밋). null = 유휴.
  const [preview, setPreview] = useState<Map<string, Rect> | null>(null);
  const [guides, setGuides] = useState<Guides>({ v: null, h: null });
  const [zone, setZone] = useState<SnapZone>(null);

  // zOrder 의 마지막 = 최상단 창. 헤더 틴트의 유일한 소비처.
  const focusedId = zOrder[zOrder.length - 1];

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
      onDragStart?.(id);

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
    [windows, focusWindow, onDragStart],
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
  // 안정 콜백(windowAtPoint 등)이 최신 값을 읽기 위한 미러 — state/props 를 deps 에
  // 넣으면 드롭 리졸버 등록이 리사이즈·커밋마다 재등록된다. 갱신은 layout effect
  // 에서만(렌더 중 ref 쓰기 금지 규율) — 소비자는 전부 이벤트/effect 경로라 페인트
  // 전 갱신이면 충분하다.
  const canvasRef = useRef(canvasBox);
  const windowsRef = useRef(windows);
  const zOrderRef = useRef(zOrder);
  useLayoutEffect(() => {
    canvasRef.current = canvasBox;
    windowsRef.current = windows;
    zOrderRef.current = zOrder;
  });
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
    if (!pendingNormalize || !normalizeLegacyRects) return;
    if (canvasBox.w <= 0 || canvasBox.h <= 0) return;
    normalizeLegacyRects(canvasBox);
  }, [pendingNormalize, canvasBox, normalizeLegacyRects]);

  // 로컬 좌표 아래 z-최상위 창(겹친 창 = 위 창 승리). ref 미러로 최신 창 배열·rect
  // 를 읽어 페이지의 정밀 드롭 리졸버(effect)와 어포던스(render)가 공유한다.
  const windowAtPoint = useCallback((localX: number, localY: number): W | null => {
    const zs = zOrderRef.current;
    for (let i = zs.length - 1; i >= 0; i--) {
      const win = windowsRef.current.find((w) => w.id === zs[i]);
      if (!win) continue;
      // 인자는 캔버스 로컬 px 이므로 비율 rect 를 px 로 펴서 비교한다(ADR-0122).
      const r = toPx(win.rect, canvasRef.current);
      if (localX >= r.x && localX <= r.x + r.w && localY >= r.y && localY <= r.y + r.h) {
        return win;
      }
    }
    return null;
  }, []);

  // 좌표 API — 전 메서드가 ref 기반이라 참조 안정. 페이지 오버레이가 소비.
  const api = useMemo<WorkspaceCanvasApi<W>>(
    () => ({
      windowAtPoint,
      boxRect: () => boxRef.current?.getBoundingClientRect() ?? null,
      canvasSize: () => canvasRef.current,
    }),
    [windowAtPoint],
  );
  useEffect(() => {
    if (!onApi) return undefined;
    onApi(api);
    return () => onApi(null);
  }, [onApi, api]);

  // 정리(Tidy) 트리거는 캔버스 밖 고정 툴바에 있다 — 캔버스 실측이 필요한 실행기를
  // 페이지 명령 채널에 등록(C2c-2c).
  useEffect(() => {
    if (!registerTidy) return undefined;
    return registerTidy(onTidy);
  }, [registerTidy, onTidy]);

  // 렌더는 px. 프리뷰(드래그 중)는 이미 px 이고, 그 외에는 스토어의 비율을 현재
  // 캔버스로 편다 — 캔버스가 줄면 창도 같은 비율로 줄어 배치가 보존된다(ADR-0122).
  const rectOf = (w: W): Rect => preview?.get(w.id) ?? toPx(w.rect, canvasBox);

  return (
    <div
      ref={boxRef}
      className="relative h-full min-h-0 w-full overflow-hidden bg-bg"
      onPointerMove={onPointerMove}
      onPointerUp={commit}
      onPointerCancel={endDrag}
      onLostPointerCapture={commit}
    >
      {overlays}
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

      {windows.length === 0 && emptyState}
      {windows.map((w) => (
        <WindowItem
          key={w.id}
          win={w}
          rect={rectOf(w)}
          zIndex={Math.max(0, zOrder.indexOf(w.id))}
          focused={w.id === focusedId}
          onHandleDown={onHandleDown}
          onFocus={focusWindow}
          ctx={itemCtx}
        />
      ))}
    </div>
  );
}
