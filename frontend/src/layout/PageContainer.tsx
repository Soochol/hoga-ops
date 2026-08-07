import { forwardRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Shared outer frame for feature pages (DESIGN.md "Page shell"). Provides the
 * one canonical page padding token (p-md) + full-height sizing. Does NOT impose
 * a card or a page title — pages compose their own card(s) and a title-less
 * control bar inside. The active top menu item is the page label, so pages
 * never repeat their own name (matches the /live header decision). Full-bleed pages (the
 * /live chart workspace) do NOT use this; they own their grid.
 *
 * forwardRef so a page that needs the frame element (e.g. Capture's splitter
 * drag math) can read it.
 */
/**
 * 페이지 콘텐츠 최대 폭 — **앱 전체에서 이 값 하나만 쓴다.**
 *
 * 출처는 `/market`(#1102, 프로토타입 A 승자): 초광폭에서 카드가 무한 확장돼 차트가
 * 납작해지던 문제의 답이었다. 2026-08-07 에 `/capture`·`/inventory`·`/screener` 로
 * 넓혔다 — 2560px 에서 이 셋은 전폭으로 늘어나 **6자리 코드 입력창이 1120px** 이 되고
 * 큐·표 행이 화면 끝까지 벌어졌다(변형 A/B/C 비교, 사용자 확정. throwaway 브랜치
 * `prototype/capture-inventory-width-2026-08-07` 보존).
 *
 * 문자열 상수지만 Tailwind 는 소스 텍스트를 스캔하므로 이 파일에 리터럴이 있는 한
 * 클래스가 생성된다. 값을 바꿀 때는 여기만 고친다.
 */
export const PAGE_MAX_W = 'max-w-[1680px]';

export const PageContainer = forwardRef<
  HTMLDivElement,
  {
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
    /**
     * 콘텐츠를 `PAGE_MAX_W` 중앙 고정으로 담는다. 초광폭에서 전폭 스트레치를 막는
     * 용도라 **1730px 아래에서는 렌더가 불변**이다(그래서 1440 스크린샷만 보면
     * 켜고 끈 차이가 안 보인다 — 검증은 반드시 광폭에서).
     *
     * `/market` 은 이 prop 을 쓰지 않는다 — 그쪽은 스크롤 컨테이너가 안쪽에 따로
     * 있어 max-width 가 그 div 에 붙어야 한다. 값은 `PAGE_MAX_W` 로 공유한다.
     */
    centered?: boolean;
  }
>(function PageContainer({ children, className = '', style, centered = false }, ref) {
  const widthClass = centered ? `mx-auto w-full ${PAGE_MAX_W}` : '';
  return (
    <div
      ref={ref}
      className={`p-md h-full min-h-0 ${widthClass} ${className}`.replace(/\s+/g, ' ').trim()}
      style={style}
    >
      {children}
    </div>
  );
});

export default PageContainer;
