import type { ReactNode } from 'react';

/**
 * 사이드바 표면 프리미티브.
 *
 * 한때 `SidebarCard`/`SidebarCardHeader`/`SidebarCardFooter` 가 함께 살았다 —
 * 지표들이 하나의 aside 안에 세로로 쌓이던 시절, 카드 테두리·헤더·각주가
 * 형제 카드끼리를 갈라 놓는 유일한 수단이었기 때문이다. 워크스페이스 창
 * 모델(ADR-0119)로 넘어오며 그 역할을 창 프레임이 가져갔고, 남은 카드 크롬은
 * 창 안의 두 번째 테두리·두 번째 제목이 되어 2026-07-30 에 걷어냈다.
 * 창 안에서 다시 카드를 두르지 말 것 — 분리는 창이 담당한다.
 */
export function SidebarState({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid h-full place-items-center text-xs text-fg-dimmer ${className}`.trim()}>
      {children}
    </div>
  );
}
