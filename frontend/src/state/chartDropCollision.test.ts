import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollisionDetection } from '@dnd-kit/core';
import { withChartDropSuppression } from './chartDropCollision';
import { useEntryDragStore } from './entryDrag';

/**
 * 차트 위에서 패널 droppable 을 억제하는 래퍼.
 *
 * **막는 방향**: 커서가 차트 워크에어리어 위일 때 패널이 재정렬·이동 프리뷰를 그리는 것.
 * **못 보는 것**: 드롭 자체의 정확성 — 드롭은 `over` 가 아니라 좌표로 판정하므로 이 함수의
 *   반환값과 무관하다(그래서 억제해도 드롭이 안 깨진다는 것이 이 설계의 요점이다).
 * **등록 의존**: `isPointOnChart` 는 캔버스가 `registerChartTarget` 으로 등록한 술어를 본다.
 *   미등록(`/live` 밖)이면 억제가 아예 안 걸린다 — 아래 마지막 테스트가 그 축이다.
 */

const ONE = [{ id: 'row-1' }] as unknown as ReturnType<CollisionDetection>;
const inner = vi.fn<CollisionDetection>(() => ONE);

function collide(
  detect: CollisionDetection,
  activeType: string,
  pointer: { x: number; y: number } | null,
) {
  return detect({
    active: { id: 'a', data: { current: { type: activeType } } },
    pointerCoordinates: pointer,
    droppableContainers: [],
    collisionRect: {},
    droppableRects: new Map(),
  } as unknown as Parameters<CollisionDetection>[0]);
}

/** 캔버스가 등록하는 히트테스트 흉내 — x<100 이 "차트 위". */
function registerChartAtLeft() {
  const hit = (x: number) => x < 100;
  useEntryDragStore.getState().registerChartTarget(hit);
  return hit;
}

beforeEach(() => {
  inner.mockClear();
  useEntryDragStore.setState({ targets: {}, hitTestChart: null });
});

describe('withChartDropSuppression', () => {
  it('차트 위 + 차트에 놓을 수 있는 타입 → over 를 비운다(inner 를 아예 안 부른다)', () => {
    registerChartAtLeft();
    const detect = withChartDropSuppression(inner, (t) => t === 'entry');

    expect(collide(detect, 'entry', { x: 10, y: 10 })).toEqual([]);
    expect(inner).not.toHaveBeenCalled();
  });

  it('차트 밖이면 패널 전략을 그대로 쓴다', () => {
    registerChartAtLeft();
    const detect = withChartDropSuppression(inner, (t) => t === 'entry');

    expect(collide(detect, 'entry', { x: 500, y: 10 })).toBe(ONE);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('차트에 못 놓는 타입은 차트 위여도 억제하지 않는다', () => {
    // 좁게 잡아야 하는 이유: 억제하면 그 드래그는 차트 위를 지나는 동안 over 를 잃어
    // 재정렬 자체가 불가능해진다(관심종목 메모·히트맵 그룹 헤더가 이 경우).
    registerChartAtLeft();
    const detect = withChartDropSuppression(inner, (t) => t === 'entry');

    expect(collide(detect, 'folder', { x: 10, y: 10 })).toBe(ONE);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('좌표가 없으면 억제하지 않는다(키보드 센서 등)', () => {
    registerChartAtLeft();
    const detect = withChartDropSuppression(inner, (t) => t === 'entry');

    expect(collide(detect, 'entry', null)).toBe(ONE);
  });

  it('캔버스 미등록(/live 밖)이면 억제가 안 걸린다 — 등록 의존을 못박는다', () => {
    // registerChartTarget 을 부르지 않는다 → isPointOnChart 는 항상 false.
    const detect = withChartDropSuppression(inner, (t) => t === 'entry');

    expect(collide(detect, 'entry', { x: 10, y: 10 })).toBe(ONE);
    expect(inner).toHaveBeenCalledOnce();
  });
});
