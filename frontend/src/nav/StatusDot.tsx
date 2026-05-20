import { useEffect, useState } from 'react';
import { lastHeartbeat } from '../api/sse';

type Status = 'green' | 'yellow' | 'red';

export default function StatusDot() {
  const [status, setStatus] = useState<Status>('yellow');
  useEffect(() => {
    const tick = () => {
      const last = lastHeartbeat();
      if (last === 0) setStatus('yellow');
      else if (Date.now() - last > 60_000) setStatus('yellow');
      else setStatus('green');
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);
  const color =
    status === 'green' ? 'var(--up)' : status === 'yellow' ? 'var(--accent)' : 'var(--down)';
  const text =
    status === 'green'
      ? 'SSE 연결 활성'
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
      SSE · :8000
    </span>
  );
}
