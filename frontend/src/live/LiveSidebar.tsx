import { useMemo } from 'react';
import CursorSidebar from '../sidebar/CursorSidebar';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import FillTape from '../sidebar/FillTape';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import { useLiveSeries } from '../api/liveSeries';
import {
  aggregateBrokerSeries,
  flattenTrades,
  latestOrderbookSnapshot,
} from './liveSidebarAdapters';

interface Props {
  code: string | null;
}

/**
 * Live Sidebar — three cards (10호가 / 거래원 / 체결) wired to live data.
 *
 * Reuses the existing CursorSidebar layout shell from /replay so visual
 * parity is automatic. The data wiring differs:
 *   - /replay uses cursor-keyed REST hooks (useCursor, useBrokerSeriesForDay)
 *   - /live uses useLiveSeries (initial REST + SSE)
 *
 * Per Design C1: header has a LIVE● pulse so users can see at a glance
 * that this sidebar is auto-tracking the latest tick, not cursor-anchored.
 * Cursor interaction is intentionally disabled (mode='live') — clicking
 * inside the sidebar to seek is a /replay-only affordance.
 */
export function LiveSidebar({ code }: Props) {
  const { ob, trade, broker } = useLiveSeries(code ?? '');

  // Project live snapshots into the wire shapes the presentational
  // components consume. useMemo so the adapters don't re-run on every
  // tick re-render that doesn't change the underlying arrays.
  const orderbook = useMemo(() => latestOrderbookSnapshot(ob), [ob]);
  const brokerSeries = useMemo(() => aggregateBrokerSeries(broker), [broker]);
  const trades = useMemo(() => flattenTrades(trade), [trade]);

  // For BrokerTrajectoryTable's cursorMs: in /live mode the cursor is
  // always "now" — use the latest broker snapshot's t_ms so the
  // per-row "net at cursor" reads the most recent observed value.
  const latestBrokerTs = broker.length > 0 ? (broker[broker.length - 1].t_ms as number) : Date.now();

  return (
    <div
      data-testid="live-sidebar"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-card)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          padding: 'var(--space-sm) var(--space-md)',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-dim)',
        }}
      >
        <span
          data-testid="live-sidebar-pulse"
          aria-label="live pulse"
          style={{
            display: 'inline-block',
            width: 'var(--space-xs)',
            height: 'var(--space-xs)',
            borderRadius: '50%',
            background: 'var(--accent)',
            animation: 'live-pulse 1.5s ease-in-out infinite',
          }}
        />
        <span style={{ fontFamily: 'monospace' }}>LIVE</span>
        {orderbook && (
          <span style={{ marginLeft: 'auto', color: 'var(--fg-dimmer)' }}>
            {formatHms(orderbook.ts_ms)}
          </span>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <CursorSidebar
          orderbook={
            <>
              <OrderbookTable snapshot={orderbook} />
              <TotalQtyBar snapshot={orderbook} maskRatio={false} />
            </>
          }
          brokers={
            <BrokerTrajectoryTable
              series={broker.length === 0 ? undefined : brokerSeries}
              cursorMs={latestBrokerTs}
            />
          }
          fills={<FillTape trades={trade.length === 0 ? undefined : trades} />}
        />
      </div>
    </div>
  );
}

function formatHms(t_ms: number): string {
  const d = new Date(t_ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
