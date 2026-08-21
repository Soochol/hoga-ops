import type { CollisionDetection } from '@dnd-kit/core';
import { isPointOnChart } from './entryDrag';

/**
 * "커서가 차트 워크에어리어 위면 패널 쪽 droppable 을 전부 억제한다" 규칙.
 *
 * 재정렬·이동 제스처와 차트 드롭이 **같은 드래그 하나를 공유하는** 패널(관심종목·
 * 히트맵)이 쓴다. 스크리너·순위 드로어는 droppable 이 애초에 없어 `over` 가 안 생기므로
 * 해당이 없다(`useChartDropDrag` 주석).
 *
 * 왜 필요한가: `closestCenter` 는 **거리 상한이 없다**. 커서가 캔버스 한복판이어도 패널의
 * 최근접 행을 골라내므로, 억제하지 않으면 목적지가 창인데 출발지(패널)가 계속 재정렬·이동
 * 프리뷰를 그린다 — 사용자는 드롭 표시를 두 곳에서 동시에 본다.
 *
 * **드롭 경로는 이 억제로 안 깨진다.** 차트 드롭 분기는 `over` 가 아니라
 * `isPointOnChart(dropPoint(ev))` 로 판정하기 때문이다. 그래서 `over` 를 비워도
 * 드롭은 정상이고, 사라지는 것은 잘못된 프리뷰뿐이다.
 *
 * **등록 의존**: `isPointOnChart` 는 워크스페이스 캔버스가 등록한 술어를 본다
 * (`registerChartTarget`). `/live` 밖에서는 미등록이라 항상 false → 억제가 아예 안 걸리고
 * 패널은 종전대로 동작한다. 즉 이 래퍼는 `/heatmap` 전체 페이지처럼 캔버스가 없는
 * 표면에서 무해하다.
 *
 * @param inner 패널 자신의 레인 분리 전략(`closestCenter` 계열).
 * @param isChartDroppable 이 active 타입이 차트에 놓일 수 있는가. **좁게 잡아야 한다** —
 *   차트에 못 놓는 타입(관심종목 메모)까지 억제하면 그 드래그는 차트 위를 지나는 동안
 *   `over` 를 잃어 제자리 복귀만 남고, 재정렬 자체가 불가능해진다.
 */
export function withChartDropSuppression(
  inner: CollisionDetection,
  isChartDroppable: (activeType: string | undefined) => boolean,
): CollisionDetection {
  return (args) => {
    const type = args.active.data.current?.type;
    if (
      isChartDroppable(type === undefined ? undefined : String(type)) &&
      args.pointerCoordinates &&
      isPointOnChart(args.pointerCoordinates)
    ) {
      return [];
    }
    return inner(args);
  };
}
