import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { STATUS_STALE_MS } from '../api/liveness';

type Status = 'green' | 'yellow' | 'red';

export default function StatusDot() {
  const live = useConnectionLiveness(STATUS_STALE_MS, 5000);
  const status: Status = live ? 'green' : 'yellow';
  const color =
    status === 'green' ? 'var(--success)' : status === 'yellow' ? 'var(--warn)' : 'var(--error)';
  const text =
    status === 'green'
      ? '실시간 연결 활성'
      : status === 'yellow'
        ? '재연결 중...'
        : '백엔드 응답 없음';
  return (
    <span title={text}>
      <span
        className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
        style={{
          background: color,
          boxShadow: status === 'green' ? `0 0 4px ${color}` : undefined,
        }}
      />
      WS · :8000
    </span>
  );
}
