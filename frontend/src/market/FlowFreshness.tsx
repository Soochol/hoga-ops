import { flowStatus } from './flowStatus';
import { useEffect, useState } from 'react';
import type { FlowCollection } from '../api/market';
import { DataStamp } from './marketCardBits';

const STATUS_LABELS = {
  waiting: '수신 대기', receiving: '정상 수신', delayed: '수신 지연',
  closed: '수집 종료', unavailable: '수집 설정 없음', unknown: '수신 상태 확인 불가',
};


function time(ms: number | null | undefined): string {
  return ms == null ? '없음' : new Date(ms).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Only this small status surface ticks; the full-day chart does not rerender each second. */
export function FlowFreshness({ collection, target, receivedAt, error, date }: {
  collection?: FlowCollection | null;
  target: string;
  receivedAt: number;
  error: boolean;
  date?: string | null;
}) {
  const [elapsed, setElapsed] = useState({ stamp: 0, ms: 0 });
  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => {
      setElapsed({ stamp: receivedAt, ms: performance.now() - start });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [receivedAt]);
  const health = collection?.targets[target];
  const status = collection && health
    ? flowStatus(collection, health, elapsed.stamp === receivedAt ? elapsed.ms : 0) : 'unknown';
  return (
    <div className="flex flex-wrap items-baseline gap-x-sm gap-y-2xs text-2xs text-fg-dim">
      <DataStamp date={date} />
      <p role="status" className="flex flex-wrap gap-x-sm gap-y-2xs">
        {health?.last_success_at_ms != null && (
          <span className="font-data tabular-nums" title="마지막 정상 수신 시각">
            {time(health.last_success_at_ms)} 수신
          </span>
        )}
        <span>{error ? '서버 연결 확인 필요' : STATUS_LABELS[status]}
          {error && receivedAt > 0 && ' · 마지막 데이터 유지'}
        </span>
      </p>
    </div>
  );
}
