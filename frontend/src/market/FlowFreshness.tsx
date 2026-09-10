import { flowStatus } from './flowStatus';
import { useEffect, useState } from 'react';
import type { FlowCollection, InvestorFlowCoverage } from '../api/market';

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
export function FlowFreshness({ collection, target, receivedAt, error, coverage }: {
  collection?: FlowCollection | null;
  target: string;
  receivedAt: number;
  error: boolean;
  coverage?: InvestorFlowCoverage;
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
  const gaps = coverage?.gap_ranges ?? [];
  return (
    <div className="text-2xs text-fg-dim">
      <p role="status">
        {error ? '서버 연결 확인 필요' : STATUS_LABELS[status]}
        {health?.last_success_at_ms != null && ` · 마지막 정상 수신 ${time(health.last_success_at_ms)}`}
        {error && receivedAt > 0 && ' · 마지막 데이터 유지'}
      </p>
      {coverage && (
        <details>
          <summary className="cursor-pointer">수집 이력 · 첫 저장 {time(coverage.first_sample_ms)}</summary>
          <p>마지막 저장 {time(coverage.last_sample_ms)} · 동일 응답은 저장을 생략합니다.</p>
          <p>첫 저장 이전에는 저장 이력이 없습니다.</p>
          {gaps.map((gap) => (
            <p key={`${gap.start_ms}-${gap.end_ms}`}>
              저장 표본 공백 {time(gap.start_ms)}–{time(gap.end_ms)} · {health?.gaps.some(f => f.start_ms < gap.end_ms && f.end_ms > gap.start_ms)
                ? '수신 실패 기록 포함' : '원인 확인 불가'}
            </p>
          ))}
          {health?.gaps.map((gap) => (
            <p key={`receipt-${gap.start_ms}-${gap.end_ms}`}>
              수신 실패 기록 {time(gap.start_ms)}–{time(gap.end_ms)}
            </p>
          ))}
          {health?.failure_started_at_ms != null && <p>수신 실패 기록 {time(health.failure_started_at_ms)}부터</p>}
        </details>
      )}
    </div>
  );
}
