import { createPortal } from 'react-dom';
import { DragOverlay, defaultDropAnimationSideEffects, type DropAnimation } from '@dnd-kit/core';

/** 고스트가 차트 위에 떨궈지지 **않은** 경우의 낙하 애니메이션(원위치 복귀). */
const FLY_BACK: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
};

/**
 * 우측 레일 드로어 공용 드래그 고스트 껍데기 — 커서를 따라오는 행 클론을 띄운다.
 *
 * **없으면 어떤 문제인가**: 원본 행에 transform 을 걸어 움직이는 방식은 스크롤 컨테이너
 * (`RailDrawerBody` = `overflow-auto`) 경계에서 잘린다. 그래서 패널을 벗어나 차트 창으로
 * 끌고 가는 동안 손에 아무것도 없었다 — 목적지(창 하이라이트) 피드백만 있고 커서 쪽
 * 피드백이 비어 있었다.
 *
 * 두 가지가 이 컴포넌트의 존재 이유다.
 *
 * 1. **`document.body` 포털.** 패널 조상에 `contain`/`transform` 이 끼면 fixed 자손의
 *    containing block 이 그 카드로 바뀌어 좌표가 어긋나고 잘린다(이 리포가 이미 겪은
 *    사고). `createPortal` 은 DOM 만 옮기고 React 트리 위치는 유지하므로 DndContext
 *    컨텍스트는 그대로다 — 그래서 반드시 `<DndContext>` **안에서** 렌더해야 한다.
 * 2. **`droppedOnChart` 에 따른 낙하 애니메이션 결정.** 기본 애니메이션은 고스트를
 *    원래 행 자리로 되돌리는 비행이라, 차트 창에 성공적으로 떨궜는데 패널로 날아가면
 *    "실패했다" 로 읽힌다. 이 판정은 **드래그 상태를 지우기 전에** 확정해야 한다 —
 *    store 의 `overChart` 를 렌더에서 읽으면 `endDrag()` 가 같은 커밋에서 먼저 지워
 *    항상 false 가 된다(실제로 그 버그를 겪었고 테스트로 고정했다).
 *
 * `wrapperElement="ul"` 인 이유: 고스트로 넘어오는 행이 `<li>`(QuoteRow·MemoRow)다.
 */
export function RailDragOverlay({ droppedOnChart, children }: {
  droppedOnChart: boolean;
  children: React.ReactNode;
}) {
  return createPortal(
    <DragOverlay
      wrapperElement="ul"
      dropAnimation={droppedOnChart ? null : FLY_BACK}
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
      className="rounded overflow-hidden bg-bg-card shadow-overlay cursor-grabbing"
    >
      {children}
    </DragOverlay>,
    document.body,
  );
}
