import { NavLink } from 'react-router';
import type { MouseEvent } from 'react';

export default function TopNavItem({ to, label, onClick }: {
  to: string;
  label: string;
  /** 이동에 곁들이는 부수 효과(우측 패널 열기 등). 호출부가 새 탭 클릭을 걸러낸다. */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        [
          'h-full inline-flex items-center whitespace-nowrap no-underline transition-colors',
          'text-sm',
          isActive ? 'text-fg font-bold' : 'text-fg-dim font-semibold hover:text-fg',
        ].join(' ')
      }
    >
      {label}
    </NavLink>
  );
}
