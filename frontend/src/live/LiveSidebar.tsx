import { useMemo } from 'react';
import CursorSidebar from '../sidebar/CursorSidebar';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import type { LiveSeriesData } from '../api/liveSeries';
import {
  aggregateBrokerSeries,
  latestOrderbookSnapshot,
} from './liveSidebarAdapters';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import { useLivePageStore } from '../state/livePage';
import { useAuctionMaskActive } from '../state/useAuctionMaskActive';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
} from '../api/useLiveCursor';
import type { MinuteTimeframe, LiveTimeframe } from '../state/livePage';
import { isMinuteTimeframe } from '../state/livePage';
import { useLiveStatus } from '../api/liveStatus';

interface Props {
  code: string | null;
  /** Owned by LivePage's single useLiveSeries call (ADR-0040 spirit). The
   * sidebar must NOT call useLiveSeries itself — that would open a second
   * SSE connection and a parallel buffer that drifts out of sync on HMR
   * re-mounts. */
  live: LiveSeriesData;
}

/**
 * Live Sidebar — two cards (10호가 / 거래원) wired to live data.
 *
 * Reuses the existing CursorSidebar layout shell from /replay so visual
 * parity is automatic. The data wiring differs:
 *   - /replay uses cursor-keyed REST hooks (useCursor, useBrokerSeriesForDay)
 *   - /live uses useLiveSeries (initial REST + SSE) in latest mode
 *   - /live uses useLiveCursor hooks in spot mode (cursor set via hover)
 *
 * Per ADR-0044 and Design C1: header toggles between LIVE● pulse (latest
 * mode) and "과거 시점" + pinned timestamp (spot mode) when cursor is set.
 *
 * The third "체결" card was removed 2026-05-28 (ADR-0047). The chart's
 * 체결강도 pane provides equivalent information in compact form.
 */
export function LiveSidebar({ code, live }: Props) {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);

  // ADR-0067: REST 준실시간 안내 — code가 live_set(WS 실시간 수집) 밖이면 안내 표시.
  const { data: liveStatusData } = useLiveStatus();
  const liveSet = liveStatusData?.live_set ?? [];
  const showRestNotice = !!code && !liveSet.includes(code);
  // Spot mode is minute-only (ADR-0044): D/W/M have no per-cursor parquet. The
  // chart still publishes cursorMs on D for the Pane Legend, so gate spot entry
  // on the timeframe here — NOT on cursorMs alone.
  const isSpot = cursorMs !== null && isMinuteTimeframe(timeframe);

  // Latest-mode data flows through `live` — LivePage owns the single
  // useLiveSeries call site. useSpot hooks in spot mode sit dormant when
  // cursorMs is null, no extra fetches.
  const { ob, broker } = live;
  const latestOrderbook = useMemo(() => latestOrderbookSnapshot(ob), [ob]);
  const latestBrokerSeries = useMemo(() => aggregateBrokerSeries(broker), [broker]);
  const latestBrokerTs =
    broker.length > 0 ? (broker[broker.length - 1].t_ms as number) : Date.now();

  // Spot-mode data (dormant when cursorMs null).
  const spotTimeframe: MinuteTimeframe | null =
    timeframe && isMinuteTimeframe(timeframe) ? timeframe : null;
  const spotOrderbook = useLiveOrderbookAtCursor({ code, timeframe: spotTimeframe });
  const spotBrokers = useLiveBrokersAtCursor({ code, timeframe: spotTimeframe });

  // Axis for Auction Mask in spot mode.
  const axis = useLiveAxisStore((s) => s.axis);
  const maskRatio = useAuctionMaskActive(axis, isSpot ? cursorMs : null);

  // Branch on spot vs latest.
  const spotSnap = spotOrderbook?.snapshot ?? null;
  const spotAvailableFrom = spotOrderbook?.available_from ?? null;
  const orderbookForCard = isSpot ? spotSnap : latestOrderbook;
  const brokerSeriesForCard = isSpot
    ? spotBrokers
    : (broker.length === 0 ? undefined : latestBrokerSeries);
  const brokerCursorMs = isSpot ? (cursorMs ?? latestBrokerTs) : latestBrokerTs;

  // T14b: "다음 가용: HH:MM" hint above orderbook table when spot orderbook
  // has no snapshot yet but backend knows when the first row arrives.
  const showAvailableHint =
    isSpot && spotOrderbook !== undefined && spotSnap === null && spotAvailableFrom !== null;

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
      {showRestNotice && (
        // TODO(label): 안내 문구 확정
        <div
          data-testid="live-sidebar-rest-notice"
          style={{
            padding: 'var(--space-xs) var(--space-md)',
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-dimmer)',
            borderBottom: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          관심종목 밖 · 준실시간(REST) 표시 · 관심종목에 추가하면 실시간
        </div>
      )}
      <SidebarHeader cursorMs={cursorMs} latestOrderbookTs={latestOrderbook?.ts_ms ?? null} timeframe={timeframe} />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <CursorSidebar
          orderbook={
            <>
              {showAvailableHint && (
                <div
                  data-testid="orderbook-available-hint"
                  style={{
                    padding: 'var(--space-xs) var(--space-md)',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--fg-dimmer)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  다음 가용: {formatTime(spotAvailableFrom!)}
                </div>
              )}
              <OrderbookTable snapshot={orderbookForCard} />
              <TotalQtyBar snapshot={orderbookForCard} maskRatio={maskRatio} />
            </>
          }
          brokers={
            <BrokerTrajectoryTable series={brokerSeriesForCard} cursorMs={brokerCursorMs} />
          }
        />
      </div>
    </div>
  );
}

function SidebarHeader({
  cursorMs,
  latestOrderbookTs,
  timeframe,
}: {
  cursorMs: number | null;
  latestOrderbookTs: number | null;
  timeframe: LiveTimeframe;
}) {
  // Design review B2: keep the timestamp pinned right in BOTH modes so it
  // doesn't jump columns on mouse leave/enter. Left slot carries the mode
  // label only. C4: 한글 카피로 "과거 시점" 사용 (DESIGN.md Copy Tone).
  const isSpot = cursorMs !== null && isMinuteTimeframe(timeframe);
  const rightTs = isSpot ? cursorMs : latestOrderbookTs;
  return (
    <div
      className="font-mono"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-xs)',
        padding: 'var(--space-sm) var(--space-md)',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg-dim)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
        {isSpot ? (
          <span>과거 시점</span>
        ) : (
          <>
            <span
              data-testid="live-sidebar-pulse"
              aria-label="live pulse"
              style={{
                display: 'inline-block',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: 'var(--accent)',
                animation: 'live-pulse 1.5s ease-in-out infinite',
              }}
            />
            <span>LIVE</span>
          </>
        )}
      </span>
      {rightTs !== null && (
        <span style={{ color: 'var(--fg-dimmer)' }}>{formatTime(rightTs)}</span>
      )}
    </div>
  );
}

// KST formatting via toLocaleTimeString — matches the rest of the sidebar
// (OrderbookTable, BrokerTrajectoryTable). Local-tz machine-time clocks
// would desync from the chart x-axis on non-KST workstations.
function formatTime(ts_ms: number): string {
  return new Date(ts_ms).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
