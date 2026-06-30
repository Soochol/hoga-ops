import { NavLink } from 'react-router';

export default function TopNavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
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
