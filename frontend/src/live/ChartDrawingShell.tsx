import type { ReactNode } from 'react';

/**
 * 행 트랙 `minmax(0,1fr)` 은 필수다 — 생략하면 `grid-auto-rows: auto` 가 되고, auto 트랙은
 * 최대 사이징 함수가 max-content 라 콘텐츠가 원하는 만큼 커진다.
 *
 * 정적인 콘텐츠라면 아이템의 `min-h-0 + overflow-hidden` 이 최소 기여를 0 으로 만들어
 * 문제가 없다(실측으로 확인). 문제가 되는 건 `LiveChartRoot` 의 lightweight-charts
 * `autoSize` 처럼 **컨테이너를 ResizeObserver 로 재서 자기 높이를 되쓰는** 자식이다:
 * CSS 가 트랙을 줄여도 다음 프레임에 차트가 자기 `<table>` 에 픽셀 높이를 다시 쓰고,
 * auto 트랙의 max-content 가 그 값을 그대로 받아준다. "트랙 = 차트 = 트랙" 이 고정점에
 * 잠겨 차트는 커지기만 하고 줄지 못하는 래칫이 된다.
 *
 * 관측된 증상: 창을 줄이면 680px 부근에서 차트가 624px 로 고착되고, 그 아래로 줄인 만큼은
 * 전부 `overflow-hidden` 에 잘려나간다(창 120px 에서 562px 잘림). `1fr` 로 상한을 컨테이너에
 * 묶으면 되쓰기가 트랙을 부풀리지 못하고, RO 가 줄어든 셀을 재서 차트가 따라 줄어든다.
 */
/**
 * 그리기 레일(44px 컬럼)은 #760 으로 폐기되고 헤더의 `DrawingMenu` 가 대신한다.
 * 셸이 남은 이유는 위 주석의 **행 트랙 규율** 하나뿐이다 — 레일이 사라졌다고
 * 이 래퍼까지 걷어내면 `LiveChartRoot` 가 `grid-auto-rows: auto` 트랙 아래로
 * 돌아가 그 래칫이 되살아난다. 컬럼은 단일 트랙으로 접었다.
 */
export function ChartDrawingShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="chart-drawing-shell"
      className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden"
    >
      <div className="min-h-0 min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
