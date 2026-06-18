import { useMemo } from 'react';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import CursorSidebar from '../sidebar/CursorSidebar';
import OrderbookTable from '../sidebar/OrderbookTable';
import type { RangeSegment } from '../api/types';
import type { StudySnapshotDetailInput } from './studySnapshotAdapter';
import { bucketStartForCursor, studyBrokerBucketsToSeries } from './studySnapshotAdapter';

type CandlePoint = { ts_ms: number };

type Props = {
  details: StudySnapshotDetailInput;
  candles: CandlePoint[];
  segments: RangeSegment[];
  bucketMs: number;
  cursorMs: number | null;
};

export function StudyDetailPanel({ details, candles, segments, bucketMs, cursorMs }: Props) {
  const bucketStart = useMemo(() => {
    if (candles.length === 0) return null;
    if (cursorMs == null) return candles[candles.length - 1]?.ts_ms ?? null;
    return bucketStartForCursor(candles, bucketMs, cursorMs);
  }, [bucketMs, candles, cursorMs]);

  const orderbook = bucketStart == null ? undefined : details.orderbookByBucketStart.get(bucketStart);
  const activeSegment = useMemo(() => {
    if (bucketStart == null) return null;
    return segments.find((segment) => (
      segment.session_open_ms <= bucketStart && bucketStart <= segment.session_close_ms
    )) ?? null;
  }, [bucketStart, segments]);
  const brokerSeries = useMemo(
    () => studyBrokerBucketsToSeries(
      details.brokersByBucketStart,
      activeSegment
        ? { fromMs: activeSegment.session_open_ms, toMs: activeSegment.session_close_ms }
        : null,
    ),
    [activeSegment, details.brokersByBucketStart],
  );
  const visibleBrokerSeries = useMemo(() => {
    if (bucketStart == null) return [];
    const bucket = details.brokersByBucketStart.get(bucketStart);
    if (!bucket?.available) return [];
    const visible = new Set(bucket.brokers.map((broker) => broker.broker));
    return brokerSeries.filter((entry) => visible.has(entry.broker));
  }, [brokerSeries, bucketStart, details.brokersByBucketStart]);
  const snapshot = orderbook?.available ? orderbook.snapshot : null;

  return (
    <div data-testid="study-detail-panel" className="grid h-full min-w-0 grid-rows-[minmax(0,1fr)_auto] bg-bg-card">
      <CursorSidebar
        orderbook={<OrderbookTable snapshot={snapshot} />}
        brokers={(
          <BrokerTrajectoryTable
            series={visibleBrokerSeries}
            cursorMs={bucketStart}
            gapThresholdMs={Math.max(30_000, bucketMs + 1)}
          />
        )}
      />
      {details.detailWarnings.length > 0 && (
        <section className="border-t px-3 py-2 text-xs text-fg-dim">
          {details.detailWarnings[0].message}
        </section>
      )}
    </div>
  );
}
