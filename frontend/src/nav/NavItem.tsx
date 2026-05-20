import { NavLink } from 'react-router';

export default function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3.5 py-2.5 rounded ${
          isActive
            ? 'bg-tint-selection text-fg font-medium'
            : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
        }`
      }
    >
      {label}
    </NavLink>
  );
}
