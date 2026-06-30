import { SYSTEM_NAV_ITEMS, WORKSPACE_NAV_ITEMS } from './items';
import TopNavItem from './TopNavItem';
import { CaptureInlineStatus } from './CaptureInlineStatus';
import StatusDot from './StatusDot';

export default function TopNav() {
  return (
    <nav
      aria-label="주요 메뉴"
      className="h-top-nav min-w-0 border-b border-border bg-bg-subtle px-lg"
    >
      <div className="grid h-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-xl">
        <div className="inline-flex items-center gap-sm whitespace-nowrap">
          <span
            aria-hidden="true"
            className="grid h-[22px] w-[22px] place-items-center rounded bg-fg text-bg text-xs font-extrabold leading-none"
          >
            H
          </span>
          <span className="text-lg font-extrabold leading-none text-fg">hoga-ops</span>
        </div>

        <div className="flex h-full min-w-0 items-center gap-xl overflow-hidden">
          {WORKSPACE_NAV_ITEMS.map((item) => (
            <TopNavItem key={item.to} to={item.to} label={item.label} />
          ))}
        </div>

        <div className="flex min-w-max items-center gap-lg text-xs font-semibold text-fg-dim">
          <CaptureInlineStatus />
          {SYSTEM_NAV_ITEMS.map((item) => (
            <TopNavItem key={item.to} to={item.to} label={item.label} />
          ))}
          <StatusDot />
        </div>
      </div>
    </nav>
  );
}
