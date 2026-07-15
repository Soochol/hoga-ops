import { useLocation } from 'react-router';
import { SYSTEM_NAV_ITEMS, WORKSPACE_NAV_ITEMS } from './items';
import TopNavItem from './TopNavItem';
import { CaptureInlineStatus } from './CaptureInlineStatus';
import StatusDot from './StatusDot';
import { LiveSymbolSearch } from '../live/LiveSymbolSearch';

const NAV_BUTTON_CLASS = [
  'h-full inline-flex items-center whitespace-nowrap transition-colors',
  'text-sm text-fg-dim font-semibold hover:text-fg',
].join(' ');

export default function TopNav({ onOpenSettings }: { onOpenSettings: () => void }) {
  // 종목 검색은 /live 전용이므로 해당 라우트에서만 헤더에 마운트한다. 검색창의
  // ＋버튼·"/" 키 포커스 배선은 liveSearchFocus 이벤트 버스로 위치와 무관하게 동작한다.
  const isLive = useLocation().pathname === '/live';
  return (
    <nav
      aria-label="주요 메뉴"
      className="h-top-nav min-w-0 bg-bg px-lg"
    >
      <div className="grid h-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-xl">
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

        <div className="flex min-w-0 items-center">
          {isLive && <LiveSymbolSearch />}
        </div>

        <div className="flex min-w-max items-center gap-lg text-xs font-semibold text-fg-dim">
          <CaptureInlineStatus />
          {SYSTEM_NAV_ITEMS.map((item) => (
            item.to === '/settings'
              ? (
                <button
                  key={item.to}
                  type="button"
                  onClick={onOpenSettings}
                  className={NAV_BUTTON_CLASS}
                >
                  {item.label}
                </button>
              )
              : <TopNavItem key={item.to} to={item.to} label={item.label} />
          ))}
          <StatusDot />
        </div>
      </div>
    </nav>
  );
}
