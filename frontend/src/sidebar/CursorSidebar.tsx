import { type ReactNode } from 'react';
import OrderbookTable from './OrderbookTable';
import BrokerNetTable from './BrokerNetTable';
import FillTape from './FillTape';
import {
  useOrderbookAtCursor,
  useBrokersAtCursor,
  useTradesAroundCursor,
} from '../api/useCursor';

type Props = {
  orderbook?: ReactNode;
  brokers?: ReactNode;
  fills?: ReactNode;
};

/**
 * Connected variant that pulls live cursor-keyed data from `useCursor` and
 * renders the 3 sidebar cards. Used by ReplayViewer; the dumb
 * `CursorSidebar` below remains exported for testability.
 */
export function CursorSidebarConnected() {
  const orderbook = useOrderbookAtCursor();
  const brokers = useBrokersAtCursor();
  const trades = useTradesAroundCursor();
  return (
    <CursorSidebar
      orderbook={<OrderbookTable snapshot={orderbook} />}
      brokers={<BrokerNetTable brokers={brokers} />}
      fills={<FillTape trades={trades} />}
    />
  );
}

export default function CursorSidebar({ orderbook, brokers, fills }: Props) {
  return (
    <aside className="grid grid-rows-[2fr_1fr_1fr] gap-2 p-2 bg-bg w-[320px] h-full min-h-0">
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
      className="flex flex-col min-h-0 bg-bg-card border rounded overflow-hidden"
    >
      <header className="px-3 py-2 border-b text-[10.5px] font-semibold uppercase tracking-wider text-fg-dimmer">
        {label}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

function Placeholder() {
  return <div className="grid place-items-center h-full text-fg-dimmer text-xs">—</div>;
}
