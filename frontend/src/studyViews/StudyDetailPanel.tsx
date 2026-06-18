import { useMemo } from 'react';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
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
    () => {
      if (bucketStart == null) return [];
      return studyBrokerBucketsToSeries(
        details.brokersByBucketStart,
        activeSegment
          ? { fromMs: activeSegment.session_open_ms, toMs: activeSegment.session_close_ms }
          : null,
      );
    },
    [activeSegment, bucketStart, details.brokersByBucketStart],
  );
  const snapshot = orderbook?.available ? orderbook.snapshot : null;

  return (
    <aside data-testid="study-detail-panel" className="h-full min-w-[260px] overflow-auto border-l bg-bg-card">
      <section>
        <h2 className="border-b px-3 py-2 text-sm font-semibold">10호가</h2>
        <OrderbookTable snapshot={snapshot} />
      </section>
      <section>
        <h2 className="border-y px-3 py-2 text-sm font-semibold">거래원</h2>
        <BrokerTrajectoryTable
          series={brokerSeries}
          cursorMs={bucketStart}
          gapThresholdMs={Math.max(30_000, bucketMs + 1)}
        />
      </section>
      {details.detailWarnings.length > 0 && (
        <section className="border-t px-3 py-2 text-xs text-fg-dim">
          {details.detailWarnings[0].message}
        </section>
      )}
    </aside>
  );
}
