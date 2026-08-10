import { useEffect, useState } from 'react';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { STATUS_STALE_MS } from '../api/liveness';
import { getConfig } from '../api/client';
import { formatApiOrigin, resolveApiOrigin } from '../config';

type Status = 'green' | 'yellow' | 'red';

/** 뱃지가 가리키는 백엔드. `:8000` 은 한때 **문자열 리터럴**이었고, 그래서
 *  e2e(:8765)·prod same-origin·`/config.json` 재정의에서 전부 거짓이었다 —
 *  Playwright 스냅샷에서 "테스트가 사용자 dev 서버에 붙었다" 로 잘못 읽혔다.
 *  API 클라이언트와 **같은 설정**에서 뽑는다. */
function useApiOrigin(): { label: string; full: string } | null {
  const [origin, setOrigin] = useState<{ label: string; full: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getConfig().then((cfg) => {
      if (cancelled) return;
      const loc = typeof window === 'undefined' ? '' : window.location.origin;
      setOrigin({ label: formatApiOrigin(cfg, loc), full: resolveApiOrigin(cfg, loc) });
    });
    return () => { cancelled = true; };
  }, []);
  return origin;
}

export default function StatusDot() {
  const live = useConnectionLiveness(STATUS_STALE_MS, 5000);
  const origin = useApiOrigin();
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
    <span title={origin ? `${text} · ${origin.full}` : text}>
      <span
        className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
        style={{
          background: color,
          boxShadow: status === 'green' ? `0 0 4px ${color}` : undefined,
        }}
      />
      {/* 해소 전에는 오리진을 **비워 둔다** — 자리를 채우려고 아무 포트나 적는
          것이 애초의 버그였다. */}
      {origin ? `WS · ${origin.label}` : 'WS'}
    </span>
  );
}
