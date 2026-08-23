import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * 워크스페이스 페이지(`/live`)의 **유일한 여백 소유자**.
 *
 * 좌·우 `px-md`(12) + 상 `pt-sm`(8), 하단은 패딩 없음 — 차트가 화면 바닥까지 붙는다.
 * 두 페이지가 이 상수 하나를 공유하므로 값이 갈릴 자리가 없다. 짝이 되는 규율이
 * 창 좌표 쪽에 하나 더 있다: 창 rect(비율, ADR-0122)는 여백을 **갖지 않고** 캔버스를
 * 꽉 채운다 — 여백을 비율로 표현하면 화면 폭에 비례해 자라기 때문이다(경위는
 * `state/workspace.ts` 의 `defaultWindows` 주석).
 *
 * #853 이 `/live` 를 `/study` 에 맞추려다 좌우만 맞췄고, 상단은 같은 커밋의 밀도 개편이
 * `/live` 만 `pt-sm` 으로 내려 (지금은 사라진) `/study` 의 `PageContainer` 기본 `p-md` 와 8 vs 12 로
 * 갈렸다. 여기서 그 갈래를 닫는다. `pt-sm` 을 택한 것은 밀도 개편이 더 최신 의도이기
 * 때문이다(nav 와 툴바 사이 최소 숨).
 *
 * **워크스페이스 페이지는 `PageContainer` 를 쓰지 않는다** — 그쪽 기본값이 `p-md` 라
 * 여백 소유권이 둘로 갈린다. `PageContainer` 는 카드형 피처 페이지의 프레임이다.
 *
 * Tailwind 는 소스 텍스트를 스캔하므로 이 파일에 리터럴이 있는 한 클래스가 생성된다
 * (`PAGE_MAX_W` 선례). 값을 바꿀 때는 여기만 고친다.
 */
export const WORKSPACE_PAGE_PAD = 'px-md pt-sm';

export function WorkspaceToolbar({
  children,
  className = '',
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex items-center gap-2 overflow-x-auto bg-bg-card/80 px-3 backdrop-blur ${className}`.trim()}
      style={{ height: 'var(--h-toolbar)' }}
    >
      {children}
    </div>
  );
}

/** ref 를 전달받는다 — 드롭다운 트리거가 메뉴를 닫은 뒤 포커스를 되돌리는 데 쓴다
 *  (WindowAddMenu). React 18 이라 함수 컴포넌트는 forwardRef 가 있어야 ref 를 받는다. */
export const IconToolbarButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode }
>(function IconToolbarButton({ children, icon, className = '', ...props }, ref) {
  return (
    <button
      type="button"
      ref={ref}
      {...props}
      // 테두리 없는 ghost 버튼(2026-07-15) — 라이트에서 bg-input=툴바 bg라 보더 없이 채우면
      // 안 보이므로 투명 배경 + hover 시 배경으로 어포던스. 분리는 hover 상태가 담당.
      // shrink-0 + nowrap: 좁은 창 헤더에서 flex 가 버튼을 눌러 CJK 라벨이 두 줄로
      // 꺾이던 것을 막는다 — 넘치는 폭은 헤더의 overflow-hidden + 접힘 정책(#762)이
      // 담당한다(잘림은 접힘 임계가 처리하는 실패 모드, 줄바꿈은 아니었다).
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-transparent px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg disabled:opacity-50 ${className}`.trim()}
    >
      {icon}
      {children}
    </button>
  );
});

