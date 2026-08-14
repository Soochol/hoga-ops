import { closestCenter, type CollisionDetection } from '@dnd-kit/core';
import { isPointOnChart } from '../state/entryDrag';

/** 액티브 드래그와 같은 레인의 droppable만 closestCenter에 넘긴다 — 중첩
 *  SortableContext의 cross-talk(폴더 컨테이너가 행 위로 끼어드는) 차단.
 *
 *  v4: 행 레인은 'entry'와 'memo'를 **함께** 본다. 둘은 한 리스트에 섞여 있어서 서로를
 *  드롭 타깃으로 삼을 수 있어야 한다(메모를 종목 사이로, 종목을 메모 사이로). 폴더
 *  레인만 따로 격리된다.
 *
 *  WatchlistDrawer 본체가 아니라 **별도 모듈**인 이유: 이 전략은 순수 함수라 단위로
 *  세울 수 있는데, 컴포넌트 파일에서 export 하면 fast-refresh 규칙(파일이 컴포넌트만
 *  export)을 어긴다. */
const ROW_TYPES = new Set(['entry', 'memo']);

export const typeAwareCollision: CollisionDetection = (args) => {
  const type = args.active.data.current?.type;
  // 커서가 차트 워크에어리어 위면 **아무것도 over 로 잡지 않는다**. closestCenter 는
  // 거리 상한이 없어 커서가 캔버스 한복판이어도 패널의 최근접 행을 골라내고, 그러면
  // 목적지가 창인데 출발지(패널)가 계속 재정렬 프리뷰를 그린다.
  //
  // 드롭 경로는 안 깨진다 — onDragEnd 의 차트 드롭 분기는 `over` 가 아니라
  // `isPointOnChart(dropPoint(ev))` 로 판정한다. 억제는 'entry' 에만 건다: 메모는
  // 차트 드롭 대상이 아니라(onDragMove 가 같은 게이트를 쓴다) over 를 없애면 제자리
  // 복귀만 남아, 차트 위를 지나가는 동안 재정렬 자체가 불가능해진다.
  if (type === 'entry' && args.pointerCoordinates && isPointOnChart(args.pointerCoordinates)) {
    return [];
  }
  const inRowLane = ROW_TYPES.has(String(type));
  const same = args.droppableContainers.filter((c) => {
    const t = String(c.data.current?.type);
    return inRowLane ? ROW_TYPES.has(t) : t === type;
  });
  return closestCenter({ ...args, droppableContainers: same });
};
