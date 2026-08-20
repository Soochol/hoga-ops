import { describe, it, expect, afterEach } from 'vitest';
import type { Active, DroppableContainer } from '@dnd-kit/core';
import { typeAwareCollision } from './panelDragCollision';
import { useEntryDragStore } from '../state/entryDrag';

/**
 * 차트 위 커서에서 패널 재정렬 프리뷰를 멈추는 억제 규칙(P4).
 *
 * **이 가드가 막는 방향**: closestCenter 는 거리 상한이 없어 커서가 캔버스 한복판이어도
 * 패널의 최근접 행을 over 로 고른다 — 목적지가 창인데 출발지가 계속 셔플했다. 억제는
 * 그 한 방향만 끊는다.
 * **못 보는 것**: 실제 포인터·자동스크롤·드롭 커밋은 여기서 안 잰다(e2e 담당, ADR-0057).
 * **등록 의존**: `isPointOnChart` 는 워크에어리어가 등록한 술어에 의존한다 — 미등록
 * (`/live` 밖)이면 항상 false 라 억제가 아예 걸리지 않는다. 아래 마지막 케이스가 그것이다.
 */

const RECT = { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
const rectAt = (top: number, height: number) =>
  ({ top, left: 0, right: 100, bottom: top + height, width: 100, height });

function container(
  id: string,
  type: string,
  data: { folderId?: string | null } = {},
  rect = RECT,
): DroppableContainer {
  return {
    id,
    key: id,
    disabled: false,
    node: { current: null },
    rect: { current: rect },
    data: { current: { type, ...data } },
  } as unknown as DroppableContainer;
}

function callCollision(opts: {
  activeType: string;
  pointer: { x: number; y: number } | null;
  overType?: string;
  activeData?: { folderId?: string | null };
  containers?: DroppableContainer[];
  collisionRect?: typeof RECT;
}) {
  const droppableContainers =
    opts.containers ?? [container('f_a:000660', opts.overType ?? 'entry')];
  return typeAwareCollision({
    active: {
      id: 'f_a:005930',
      data: { current: { type: opts.activeType, ...(opts.activeData ?? {}) } },
    } as unknown as Active,
    collisionRect: opts.collisionRect ?? RECT,
    droppableRects: new Map(droppableContainers.map((c) => [c.id, c.rect.current!])),
    droppableContainers,
    pointerCoordinates: opts.pointer,
  });
}

describe('typeAwareCollision — 차트 위 억제', () => {
  const hitTest = (clientX: number) => clientX < 800; // x<800 = 차트 워크에어리어

  afterEach(() => {
    useEntryDragStore.getState().clearChartTarget(hitTest);
  });

  it('종목 드래그가 차트 위에 있으면 아무 행도 over 로 잡지 않는다', () => {
    useEntryDragStore.getState().registerChartTarget(hitTest);
    expect(callCollision({ activeType: 'entry', pointer: { x: 400, y: 300 } })).toEqual([]);
  });

  it('같은 좌표라도 차트 밖이면 평소대로 행을 잡는다 (억제가 무차별이 아님)', () => {
    useEntryDragStore.getState().registerChartTarget(hitTest);
    const hits = callCollision({ activeType: 'entry', pointer: { x: 900, y: 300 } });
    expect(hits.map((h) => h.id)).toEqual(['f_a:000660']);
  });

  it('메모 드래그는 차트 위에서도 억제하지 않는다 — 차트 드롭 대상이 아니라 재정렬만 남는다', () => {
    useEntryDragStore.getState().registerChartTarget(hitTest);
    const hits = callCollision({ activeType: 'memo', pointer: { x: 400, y: 300 }, overType: 'memo' });
    expect(hits.map((h) => h.id)).toEqual(['f_a:000660']);
  });

  it('워크에어리어 미등록(/live 밖)이면 억제가 걸리지 않는다', () => {
    // registerChartTarget 을 부르지 않는다 → isPointOnChart 는 항상 false.
    const hits = callCollision({ activeType: 'entry', pointer: { x: 400, y: 300 } });
    expect(hits.map((h) => h.id)).toEqual(['f_a:000660']);
  });

  it('폴더 레인은 행 레인과 섞이지 않는다 (기존 계약 유지)', () => {
    const hits = callCollision({ activeType: 'folder', pointer: { x: 900, y: 300 }, overType: 'entry' });
    expect(hits).toEqual([]);
  });
});

/**
 * 폴더 간 이동(v5)의 히트 영역 — 그룹 드롭존('entry-target') 레인.
 *
 * **막는 방향 둘**: ① 종목 드래그가 빈/접힌/정렬중 폴더를 겨눌 수 없던 것(행이 없거나
 * 행에 sortable ref 가 안 붙는다) ② **출발 폴더 자신의 존이 그룹 내 재정렬의 over 를
 * 훔치는 것** — closestCenter 는 중심점 거리라 그룹 한복판에선 블록 전체가 어떤 형제
 * 행보다 가깝다.
 * **못 보는 것**: 드롭 후 무엇이 커밋되는지는 여기서 안 잰다(WatchlistDrawer.drag.test).
 */
describe('typeAwareCollision — 그룹 드롭존 레인', () => {
  it('종목 드래그는 다른 폴더의 그룹 드롭존을 후보로 본다', () => {
    const hits = callCollision({
      activeType: 'entry',
      activeData: { folderId: 'f_a' },
      pointer: { x: 900, y: 300 },
      containers: [container('folder:f_b', 'entry-target', { folderId: 'f_b' })],
    });
    expect(hits.map((h) => h.id)).toEqual(['folder:f_b']);
  });

  it('출발 폴더 자신의 드롭존은 후보에서 뺀다 (같은 폴더로의 이동은 no-op)', () => {
    const hits = callCollision({
      activeType: 'entry',
      activeData: { folderId: 'f_a' },
      pointer: { x: 900, y: 300 },
      containers: [container('folder:f_a', 'entry-target', { folderId: 'f_a' })],
    });
    expect(hits).toEqual([]);
  });

  it('그룹 한복판에서도 형제 행이 이긴다 — 자기 그룹 존이 재정렬을 훔치지 않는다', () => {
    // 드래그 중인 행이 그룹 중앙(center y=100). 자기 그룹 블록의 중심은 정확히 거기라
    // 필터가 없으면 거리 0 으로 존이 이기고, 형제 행(center y=130)은 30 만큼 진다.
    const hits = callCollision({
      activeType: 'entry',
      activeData: { folderId: 'f_a' },
      pointer: { x: 900, y: 300 },
      collisionRect: rectAt(90, 20),
      containers: [
        container('folder:f_a', 'entry-target', { folderId: 'f_a' }, rectAt(0, 200)),
        container('f_a:000660', 'entry', { folderId: 'f_a' }, rectAt(120, 20)),
      ],
    });
    expect(hits.map((h) => h.id)).toEqual(['f_a:000660']);
  });

  it('메모 드래그는 그룹 드롭존을 보지 않는다 — 메모엔 폴더 간 이동 계약이 없다', () => {
    const hits = callCollision({
      activeType: 'memo',
      activeData: { folderId: 'f_a' },
      pointer: { x: 900, y: 300 },
      containers: [container('folder:f_b', 'entry-target', { folderId: 'f_b' })],
    });
    expect(hits).toEqual([]);
  });

  it('미분류(folderId=null) 행도 실폴더 드롭존을 겨눌 수 있다', () => {
    const hits = callCollision({
      activeType: 'entry',
      activeData: { folderId: null },
      pointer: { x: 900, y: 300 },
      containers: [container('folder:f_b', 'entry-target', { folderId: 'f_b' })],
    });
    expect(hits.map((h) => h.id)).toEqual(['folder:f_b']);
  });
});
