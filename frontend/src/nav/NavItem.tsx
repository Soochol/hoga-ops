import { NavLink } from 'react-router';

export default function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative grid h-9 grid-cols-[24px_1fr] items-center gap-2 rounded-md border px-2 text-sm transition-colors ${
          isActive
            ? 'border-border-strong bg-tint-selection text-fg before:absolute before:left-[-1px] before:top-2 before:bottom-2 before:w-[2px] before:rounded before:bg-accent'
            : 'border-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg'
        }`
      }
    >
      <span aria-hidden className="h-4 w-4" />
      <span>{label}</span>
    </NavLink>
  );
}
