import { forwardRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Shared outer frame for feature pages (DESIGN.md "Page shell"). Provides the
 * one canonical page padding token (p-md) + full-height sizing. Does NOT impose
 * a card or a page title — pages compose their own card(s) and a title-less
 * control bar inside. The active top menu item is the page label, so pages
 * never repeat their own name (matches the /live header decision). Full-bleed pages (the
 * /live chart workspace) do NOT use this; they own their grid.
 *
 * forwardRef so a page that needs the frame element can read it. **현재 이 ref 를 쓰는
 * 페이지는 없다** — 유일 소비처였던 `/capture` 스플리터의 clientX → % 변환이 2026-08-07
 * 스플리터 제거와 함께 사라졌다. 계약은 `PageContainer.test.tsx` 가 지키고 있으므로
 * forwardRef 는 존치하되, 되살아난 소비처가 생기면 여기에 적을 것.
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

/**
 * 보드 계층 폭 — `/heatmap` 전용. **계층을 늘리는 건 비용이라 근거를 남긴다.**
 *
 * 히트맵 보드는 `columnWidth` CSS 멀티컬럼이라 **여분 폭이 공백이 아니라 열 수**로
 * 쓰인다. 그래서 `PAGE_MAX_W`(1680)를 그대로 적용하면 다른 페이지에서 얻은 것과
 * 정반대의 결과가 난다 — 2560px 실측:
 *
 *   상한 없음 → 보드 2461px · 8열 · 1.02화면
 *   1680      → 1635px · 5열 · **1.57화면**  ← 3열을 잃고 스크롤이 54% 는다
 *   2200      → 2155px · 7열 · 1.01화면      ← 담기면서 1열만 잃는다
 *
 * (`/sentiment` 는 같은 중앙 고정으로 스크롤이 **43% 줄었다**. 세로 스택은 폭이
 * 남으면 카드가 옆으로 퍼져 세로가 길어지고, 멀티컬럼 보드는 폭이 남으면 열이 늘어
 * 세로가 짧아진다 — 같은 변경이 반대로 작동한다.)
 *
 * 새 페이지가 이 계층을 쓰려면 **같은 성질(폭↑ = 표시량↑)임을 실측으로** 보일 것.
 * 그게 아니면 `PAGE_MAX_W` 다.
 */
export const PAGE_MAX_W_BOARD = 'max-w-[2200px]';

export const PageContainer = forwardRef<
  HTMLDivElement,
  {
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
    /**
     * 콘텐츠를 중앙 고정으로 담는다. `true` = `PAGE_MAX_W`(1680, 기본),
     * `'board'` = `PAGE_MAX_W_BOARD`(2200, 멀티컬럼 보드 전용 — 위 근거 참조).
     *
     * 초광폭에서 전폭 스트레치를 막는 용도라 **1730px 아래에서는 렌더가 불변**이다
     * (그래서 1440 스크린샷만 보면 켜고 끈 차이가 안 보인다 — 검증은 반드시 광폭에서).
     *
     * `/market` 은 이 prop 을 쓰지 않는다 — 그쪽은 스크롤 컨테이너가 안쪽에 따로
     * 있어 max-width 가 그 div 에 붙어야 한다. 값은 `PAGE_MAX_W` 로 공유한다.
     */
    centered?: boolean | 'board';
  }
>(function PageContainer({ children, className = '', style, centered = false }, ref) {
  const widthClass = centered
    ? `mx-auto w-full ${centered === 'board' ? PAGE_MAX_W_BOARD : PAGE_MAX_W}`
    : '';
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
