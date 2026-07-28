// 우클릭 = 그리기 도구 해제. 유효 범위는 **창 전체**다.
//
// 이 핸들러가 DrawingOverlay 가 아니라 창 루트(WindowFrameCore 의 `data-win` div)에
// 사는 이유: 오버레이는 차트 콘텐츠 영역만 덮는데, 창의 리사이즈 핸들 8개가 그
// 바깥 rect 를 그대로 써서 좌·우·하단 7~8px 띠를 형제로 가로챈다(카드 overflow 에
// 안 잘리게 하려는 의도적 배치). 그 띠에서 우클릭하면 오버레이에도, 차트 루트의
// preventDefault 에도 닿지 않아 **네이티브 컨텍스트 메뉴가 뜨고 도구도 안 풀렸다**.
// 메뉴가 뜨면 다음 우클릭은 메뉴를 닫는 데 소비되므로 사용자에겐 "여러 번 눌러야
// 풀린다"로 보인다. 창 헤더·창 바깥도 같은 사각지대였다.
//
// 창 루트는 핸들까지 포함한 rect 전체를 덮으므로 사각지대가 남지 않는다. 오버레이의
// onContextMenu 는 진행 중인 draft 정리를 계속 맡고, 여기로 버블링돼 도구 해제가
// 한 번 더 불리지만 setActiveTool 은 멱등이라 무해하다.
import type { MouseEvent } from 'react';
import { useDrawingsStore } from '../../state/drawings';

export function resetDrawingToolOnContextMenu(e: MouseEvent): void {
  e.preventDefault();
  useDrawingsStore.getState().setActiveTool('select');
}
