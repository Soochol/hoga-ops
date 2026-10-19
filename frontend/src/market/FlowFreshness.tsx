import { flowStatus } from './flowStatus';
import { useEffect, useState } from 'react';
import type { FlowCollection } from '../api/market';

/** Only this small status surface ticks; the full-day chart does not rerender each second. */
export function FlowFreshness({ collection, target, receivedAt, error }: {
  collection?: FlowCollection | null;
  target: string;
  receivedAt: number;
  error: boolean;
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
  const message = error ? '서버 연결 확인 필요'
    : status === 'delayed' ? '수신 지연' : status === 'unavailable' ? '수집 설정 없음' : null;
  if (!message) return null;
  return (
    <p role="status" className="text-2xs text-fg-dim">
      {message}{error && receivedAt > 0 && ' · 마지막 데이터 유지'}
    </p>
  );
}
