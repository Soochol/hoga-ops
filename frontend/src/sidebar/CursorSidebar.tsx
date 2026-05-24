import { type ReactNode } from 'react';
import OrderbookTable from './OrderbookTable';
import BrokerTrajectoryTable from './BrokerTrajectoryTable';
import FillTape from './FillTape';
import TotalQtyBar from './TotalQtyBar';
import {
  useOrderbookAtCursor,
  useCursor,
  useTradesAroundCursor,
} from '../api/useCursor';
import { useBrokerSeriesForDay } from '../api/brokerSeries';
import { useAuctionMaskActive } from '../state/useAuctionMaskActive';
import type { VirtualAxis } from '../util/virtualAxis';

type Props = {
  orderbook?: ReactNode;
  brokers?: ReactNode;
  fills?: ReactNode;
};

/**
 * Connected variant that pulls live cursor-keyed data for 10호가 / 체결 and
 * day-anchored data for 거래원 (ADR-0023). The 거래원 card's identity is
 * stable across the Stock-Date; cursorMs drives only the per-row net value
 * and the sparkline cursor marker.
 */
export function CursorSidebarConnected({ axis }: { axis: VirtualAxis }) {
  const orderbook = useOrderbookAtCursor();
  const { code, date, cursorMs } = useCursor();
  const { data, isLoading } = useBrokerSeriesForDay(code, date);
  // undefined = loading, null = fetched-empty, value = data. Matches the
  // useSpot contract that OrderbookTable and FillTape consume so the three
  // cards present consistent loading/empty states.
  const series = isLoading ? undefined : (data?.brokers ?? null);
  const trades = useTradesAroundCursor();
  const maskRatio = useAuctionMaskActive(axis);

  return (
    <CursorSidebar
      orderbook={
        <>
          <OrderbookTable snapshot={orderbook} />
          <TotalQtyBar snapshot={orderbook} maskRatio={maskRatio} />
        </>
      }
      brokers={<BrokerTrajectoryTable series={series} cursorMs={cursorMs} />}
      fills={<FillTape trades={trades} />}
    />
  );
}

export default function CursorSidebar({ orderbook, brokers, fills }: Props) {
  return (
    <aside
      id="replay-sidebar"
      className="grid grid-rows-[2fr_1.4fr_1fr] gap-2 p-2 bg-bg h-full min-h-0"
    >
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
