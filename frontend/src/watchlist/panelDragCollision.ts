import { closestCenter, type CollisionDetection } from '@dnd-kit/core';
import { withChartDropSuppression } from '../state/chartDropCollision';

/** 액티브 드래그와 같은 레인의 droppable만 closestCenter에 넘긴다 — 중첩
 *  SortableContext의 cross-talk(폴더 컨테이너가 행 위로 끼어드는) 차단.
 *
 *  v4: 행 레인은 'entry'와 'memo'를 **함께** 본다. 둘은 한 리스트에 섞여 있어서 서로를
 *  드롭 타깃으로 삼을 수 있어야 한다(메모를 종목 사이로, 종목을 메모 사이로). 폴더
 *  레인만 따로 격리된다.
 *
 *  v5: 종목('entry')만 그룹 드롭존('entry-target')도 함께 본다 — 폴더 간 이동의 히트
 *  영역이다(빈 폴더·접힌 폴더는 행이 없어 행만으로는 겨냥할 수 없다). 메모는 폴더 간
 *  이동 경로가 없어 제외한다(서버에 메모 이동 계약이 없다 — 넣으면 드롭존이 over 를
 *  가져가 재정렬만 죽는다).
 *
 *  ⚠ **출발 폴더 자신의 드롭존은 후보에서 뺀다.** closestCenter 는 중심점 거리라, 8행
 *  짜리 그룹이면 ~230px 블록의 중심이 그룹 한복판에서 어떤 행보다도 가까워진다 —
 *  그대로 두면 그룹 내 재정렬 중 드롭 인디케이터가 중앙에서 깜빡이고 거기서 놓으면
 *  no-op 이 된다(자기 폴더로의 이동은 어차피 no-op). 이동은 항상 다른 폴더로만
 *  향하므로 이 제외로 잃는 동작이 없다.
 *
 *  WatchlistDrawer 본체가 아니라 **별도 모듈**인 이유: 이 전략은 순수 함수라 단위로
 *  세울 수 있는데, 컴포넌트 파일에서 export 하면 fast-refresh 규칙(파일이 컴포넌트만
 *  export)을 어긴다. */
const ROW_TYPES = new Set(['entry', 'memo']);
const ENTRY_TARGET = 'entry-target';

/** 차트 드롭 억제(`withChartDropSuppression`)를 **'entry' 에만** 건다 — 메모는 차트에
 *  놓을 수 없어서(onDragMove 가 같은 게이트를 쓴다), 억제하면 차트 위를 지나는 동안
 *  재정렬만 죽는다. 그 래퍼 주석의 "좁게 잡아야 한다" 가 바로 이 경우다. */
const lanes: CollisionDetection = (args) => {
  const active = args.active.data.current;
  const type = active?.type;
  const inRowLane = ROW_TYPES.has(String(type));
  const same = args.droppableContainers.filter((c) => {
    const t = String(c.data.current?.type);
    if (!inRowLane) return t === type;
    if (ROW_TYPES.has(t)) return true;
    return type === 'entry' && t === ENTRY_TARGET
      && c.data.current?.folderId !== (active?.folderId ?? null);
  });
  return closestCenter({ ...args, droppableContainers: same });
};

export const typeAwareCollision = withChartDropSuppression(lanes, (type) => type === 'entry');
