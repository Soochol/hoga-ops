import { useEffect, useState } from 'react';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { STATUS_STALE_MS } from '../api/liveness';
import { getConfig } from '../api/client';
import { resolveApiOrigin } from '../config';

type Status = 'green' | 'yellow' | 'red';

/** 툴팁이 가리키는 백엔드. `:8000` 은 한때 **문자열 리터럴**이었고, 그래서
 *  e2e(:8765)·prod same-origin·`/config.json` 재정의에서 전부 거짓이었다 —
 *  Playwright 스냅샷에서 "테스트가 사용자 dev 서버에 붙었다" 로 잘못 읽혔다.
 *  API 클라이언트와 **같은 설정**에서 뽑는다. */
function useApiOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getConfig().then((cfg) => {
      if (cancelled) return;
      const loc = typeof window === 'undefined' ? '' : window.location.origin;
      setOrigin(resolveApiOrigin(cfg, loc));
    });
    return () => { cancelled = true; };
  }, []);
  return origin;
}

/**
 * 백엔드 연결 상태 점.
 *
 * 옛 `WS · :8000` **텍스트 라벨은 제거됐다**(2026-08-16 사용자 요청) — 상단 바에서
 * 자리를 차지하는 데 비해 오리진은 툴팁으로 충분했다. 점 자체는 남긴다: 이 리포는
 * 폴러 침묵사망(ADR-0064)·좀비 WS recv 를 반복해서 겪었고, 그때 화면에서 이상을
 * 알려 준 유일한 신호가 이 색이었다. 오리진은 계속 **설정에서** 읽는다(위 주석의
 * 리터럴 사고를 되돌리지 말 것).
 */
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
  // 해소 전에는 오리진을 **비워 둔다** — 자리를 채우려고 아무 포트나 적는 것이
  // 애초의 버그였다.
  const label = origin ? `${text} · ${origin}` : text;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="ws-status-dot"
      className="inline-block w-1.5 h-1.5 rounded-full align-middle"
      style={{
        background: color,
        boxShadow: status === 'green' ? `0 0 4px ${color}` : undefined,
      }}
    />
  );
}
