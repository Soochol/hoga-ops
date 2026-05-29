import { type ReactNode } from 'react';
import OrderbookTable from './OrderbookTable';
import BrokerTrajectoryTable from './BrokerTrajectoryTable';
import TotalQtyBar from './TotalQtyBar';
import {
  useOrderbookAtCursor,
  useCursor,
} from '../api/useCursor';
import { useBrokerSeriesForDay } from '../api/brokerSeries';
import { useAuctionMaskActive } from '../state/useAuctionMaskActive';
import type { VirtualAxis } from '../util/virtualAxis';

type Props = {
  orderbook?: ReactNode;
  brokers?: ReactNode;
};

/**
 * Connected variant for /replay. Binds two cards to their hooks:
 *   - 10호가 (cursor-keyed): useSpot-family (useOrderbookAtCursor)
 *   - 거래원 (day-keyed in identity, cursor-projected in per-row net):
 *     react-query (useBrokerSeriesForDay) per ADR-0023
 *
 * The 체결 card was removed 2026-05-28 (ADR-0047). The chart's 체결강도 pane
 * provides an aggregate visualization of fill activity in its place.
 */
export function CursorSidebarConnected({ axis }: { axis: VirtualAxis }) {
  const orderbook = useOrderbookAtCursor();
  const { code, date, cursorMs } = useCursor();
  const { data, isLoading } = useBrokerSeriesForDay(code, date);
  const series = isLoading ? undefined : (data?.brokers ?? null);
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
    />
  );
}

export default function CursorSidebar({ orderbook, brokers }: Props) {
  return (
    <aside
      id="replay-sidebar"
      className="grid grid-rows-[minmax(624px,2fr)_1.4fr] gap-[var(--space-sm)] p-[var(--space-sm)] bg-bg h-full min-h-0"
    >
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="거래원" testId="card-brokers">
        {brokers ?? <Placeholder />}
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
