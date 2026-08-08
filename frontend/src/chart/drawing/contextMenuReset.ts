// 우클릭 = 그리기 도구 해제. 유효 범위는 **화면 전체**다.
//
// 왜 전역(window)인가 — 이 버그는 두 번 좁게 고쳤다가 두 번 다 남았다:
//   1차: DrawingOverlay div. 창 리사이즈 핸들이 차트 좌·우·하단 7~8px 를 형제로
//        가로채(카드 overflow 에 안 잘리게 한 의도적 배치) 그 띠가 사각지대였다.
//   2차: 차트 창 루트(WindowFrameCore). 핸들·헤더는 덮었지만 화면 격자 스캔 결과
//        차트 창 밖 — 다른 창(10호가·거래원), 워크스페이스 배경, 상단 nav, 우측
//        레일 — 이 전부 사각지대로 남았다. 1280×720 에서 차트 창은 36% 뿐이었다.
// 사각지대에서 우클릭하면 네이티브 컨텍스트 메뉴가 뜨고, 그 메뉴가 **다음 우클릭을
// 삼키므로** 사용자에겐 "여러 번 눌러야 풀린다" 로 보인다. 노드에 거는 한 남는
// 면적이 있어, 도구 활성 = 모달 상태라는 의미론대로 전역으로 올린다(Esc 와 대칭).
//
// 리스너는 **도구 활성 중에만** 산다. select 모드에선 아예 없으므로 평소 우클릭
// 동작(관심종목·히트맵 행 메뉴 등)은 무손상이다. bubble 단계라 stopPropagation 하는
// UI 는 존중되고, preventDefault 만 하는 기존 메뉴들은 그대로 열리면서 도구도 풀린다
// — 그리기를 접고 다른 작업으로 넘어가는 흐름이라 그 편이 맞다.
import { useEffect } from 'react';
import { useDrawingsStore } from '../../state/drawings';

/**
 * 그리기 도구가 활성인 동안 화면 어디서든 우클릭 한 번에 select 로 되돌린다.
 * 그리기가 있는 페이지(/live·/study)에서 **한 번만** 호출한다 — 창마다 걸면
 * 리스너가 창 수만큼 붙는다(해제 자체는 멱등이라 결과는 같지만 낭비다).
 *
 * 활성 여부를 **구독하지 않고** 핸들러 안에서 getState 로 읽는다. `activeTool`을
 * 구독하면 도구를 켜고 끌 때마다 호출한 페이지(LivePage/StudyPage) — 워크스페이스
 * 트리 전체의 뿌리 — 가 리렌더된다. 해제는 우클릭 경로에서만 필요한 정보라 그
 * 비용을 상시로 낼 이유가 없다. 리스너는 항상 살아 있지만 select 모드에선 첫 줄에서
 * 빠져나가므로, 기존 우클릭 UI(관심종목·히트맵 행 메뉴)는 그대로 무손상이다.
 */
export function useDrawingToolContextMenuReset(): void {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (useDrawingsStore.getState().activeTool === 'select') return;
      e.preventDefault();
      // 도구뿐 아니라 **선택도** 푼다 — Escape 와 같은 액션. 종전엔 도구만 풀어서
      // 선택이 남았고, 속성 패널이 select 모드에서만 뜨는 탓에 우클릭한 순간 툴바가
      // 새로 나타나 "안 풀렸다" 로 읽혔다. 그래서 한 번 더 누르게 되는데, 그때는
      // 위 첫 줄에서 빠져나가므로 네이티브 메뉴만 뜨고 선택은 그대로였다.
      useDrawingsStore.getState().exitDrawingMode();
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);
}
