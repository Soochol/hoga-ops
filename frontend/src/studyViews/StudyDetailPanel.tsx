import { useMemo } from 'react';
import type { StudyBrokerBucket } from '../api/studyViews';
import OrderbookTable from '../sidebar/OrderbookTable';
import { brokerDisplayShort } from '../sidebar/brokerDisplayNames';
import type { StudySnapshotDetailInput } from './studySnapshotAdapter';
import { bucketStartForCursor } from './studySnapshotAdapter';

type CandlePoint = { ts_ms: number };

type Props = {
  details: StudySnapshotDetailInput;
  candles: CandlePoint[];
  bucketMs: number;
  cursorMs: number | null;
};

export function StudyDetailPanel({ details, candles, bucketMs, cursorMs }: Props) {
  const bucketStart = useMemo(() => {
    if (candles.length === 0) return null;
    if (cursorMs == null) return candles[candles.length - 1]?.ts_ms ?? null;
    return bucketStartForCursor(candles, bucketMs, cursorMs);
  }, [bucketMs, candles, cursorMs]);

  const orderbook = bucketStart == null ? undefined : details.orderbookByBucketStart.get(bucketStart);
  const brokers = bucketStart == null ? undefined : details.brokersByBucketStart.get(bucketStart);
  const snapshot = orderbook?.available ? orderbook.snapshot : null;

  return (
    <aside data-testid="study-detail-panel" className="h-full min-w-[260px] overflow-auto border-l bg-bg-card">
      <section>
        <h2 className="border-b px-3 py-2 text-sm font-semibold">10호가</h2>
        <OrderbookTable snapshot={snapshot} />
      </section>
      <section>
        <h2 className="border-y px-3 py-2 text-sm font-semibold">거래원</h2>
        <BrokerDetailRows bucket={brokers} />
      </section>
      {details.detailWarnings.length > 0 && (
        <section className="border-t px-3 py-2 text-xs text-fg-dim">
          {details.detailWarnings[0].message}
        </section>
      )}
    </aside>
  );
}

function BrokerDetailRows({ bucket }: { bucket: StudyBrokerBucket | undefined }) {
  if (!bucket || !bucket.available || bucket.brokers.length === 0) {
    return <div className="grid place-items-center p-3 text-xs text-fg-dimmer">거래원 정보 없음</div>;
  }

  return (
    <div className="font-mono text-sm tabular-nums divide-y divide-border-strong">
      {bucket.brokers.slice(0, 10).map((broker) => (
        <div
          key={broker.broker}
          data-testid="study-broker-row"
          className="grid grid-cols-[70px_1fr] gap-2 px-2.5 py-0.5"
        >
          <span className="truncate" title={broker.broker}>{brokerDisplayShort(broker.broker)}</span>
          <span
            className={broker.net > 0
              ? 'text-price-up text-right'
              : broker.net < 0
                ? 'text-price-down text-right'
                : 'text-fg-dimmer text-right'}
          >
            {broker.net > 0 ? '+' : ''}
            {broker.net.toLocaleString('ko-KR')}
          </span>
        </div>
      ))}
    </div>
  );
}
