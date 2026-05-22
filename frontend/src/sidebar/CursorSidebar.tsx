import { type ReactNode } from 'react';
import OrderbookTable from './OrderbookTable';
import BrokerNetTable from './BrokerNetTable';
import FillTape from './FillTape';
import {
  useOrderbookAtCursor,
  useBrokersAtCursor,
  useTradesAroundCursor,
} from '../api/useCursor';
import { useTabsStore } from '../state/tabs';

type Props = {
  orderbook?: ReactNode;
  brokers?: ReactNode;
  fills?: ReactNode;
  /** Optional toolbar slot rendered above the 3 cards (e.g. volume-profile toggle). */
  header?: ReactNode;
};

/**
 * Connected variant that pulls live cursor-keyed data from `useCursor` and
 * renders the 3 sidebar cards. Used by ReplayViewer; the dumb
 * `CursorSidebar` below remains exported for testability.
 *
 * Also wires the per-tab `volumeProfileMode` toggle (전체 / 일별) into the
 * `header` slot — read/write goes through `useTabsStore` (Task 9 / Task 21).
 */
export function CursorSidebarConnected() {
  const orderbook = useOrderbookAtCursor();
  const brokers = useBrokersAtCursor();
  const trades = useTradesAroundCursor();
  return (
    <CursorSidebar
      header={<VolumeProfileModeToggle />}
      orderbook={<OrderbookTable snapshot={orderbook} />}
      brokers={<BrokerNetTable brokers={brokers} />}
      fills={<FillTape trades={trades} />}
    />
  );
}

function VolumeProfileModeToggle() {
  const activeId = useTabsStore((s) => s.activeTabId);
  const volMode = useTabsStore((s) => s.getPrefs(activeId).volumeProfileMode);
  const setVolMode = (m: 'range' | 'per-day') => {
    if (volMode !== m) useTabsStore.getState().setVolumeProfileMode(activeId, m);
  };
  return (
    <div
      data-testid="volume-profile-mode-toggle"
      className="flex items-center gap-1 text-xs px-1 py-1"
    >
      <span className="text-fg-dim mr-2">Volume Profile</span>
      {(['range', 'per-day'] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={volMode === m}
          onClick={() => setVolMode(m)}
          className={
            volMode === m
              ? 'px-2 py-0.5 bg-accent text-accent-fg rounded'
              : 'px-2 py-0.5 text-fg-dim hover:text-fg'
          }
        >
          {m === 'range' ? '전체' : '일별'}
        </button>
      ))}
    </div>
  );
}

export default function CursorSidebar({ orderbook, brokers, fills, header }: Props) {
  return (
    <aside
      className={
        header
          ? 'grid grid-rows-[auto_2fr_1fr_1fr] gap-2 p-2 bg-bg w-sidebar h-full min-h-0'
          : 'grid grid-rows-[2fr_1fr_1fr] gap-2 p-2 bg-bg w-sidebar h-full min-h-0'
      }
    >
      {header}
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="거래원" testId="card-brokers">
        {brokers ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="체결" testId="card-fills">
        {fills ?? <Placeholder />}
      </SidebarCard>
    </aside>
  );
}

function SidebarCard({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-card={testId.replace(/^card-/, '')}
      className="flex flex-col min-h-0 bg-bg-card border rounded overflow-hidden"
    >
      <header className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
        {label}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

function Placeholder() {
  return <div className="grid place-items-center h-full text-fg-dimmer text-xs">—</div>;
}
