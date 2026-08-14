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

function container(id: string, type: string): DroppableContainer {
  return {
    id,
    key: id,
    disabled: false,
    node: { current: null },
    rect: { current: RECT },
    data: { current: { type } },
  } as unknown as DroppableContainer;
}

function callCollision(opts: {
  activeType: string;
  pointer: { x: number; y: number } | null;
  overType?: string;
}) {
  const overId = 'f_a:000660';
  const droppableContainers = [container(overId, opts.overType ?? 'entry')];
  return typeAwareCollision({
    active: { id: 'f_a:005930', data: { current: { type: opts.activeType } } } as unknown as Active,
    collisionRect: RECT,
    droppableRects: new Map([[overId, RECT]]),
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
