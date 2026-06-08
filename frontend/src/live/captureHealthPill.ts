/**
 * 캡처 헬스 pill — cycleLagPill을 대체(spec 2026-06-08 §2.2).
 * 백엔드 _capture_health의 (capture_healthy, capture_reason)를 pill 상태로.
 * cycle_lag_ms(0 고정)가 아니라 정직한 헬스 신호를 표시한다.
 */
export type CaptureHealthSeverity = 'ok' | 'warn' | 'error';

export function captureHealthSeverity(
  healthy: boolean,
  reason: string,
): CaptureHealthSeverity {
  if (healthy) return 'ok';
  // 장외/미기동은 장애가 아님 — 중립(회색). 'closed'는 밤·주말 정상 상태라
  // 반드시 ok여야 한다(없으면 매일 거짓-앰버 — advisor A).
  if (reason === 'offline' || reason === 'closed') return 'ok';
  // 전환 상태(재연결·구독 대기)는 곧 회복 — 경고.
  if (reason === 'reconnecting' || reason === 'subscribing') return 'warn';
  // sub_failed·stale = 캡처가 죽었는데 살아있는 척 — 에러.
  return 'error';
}

export function captureHealthLabel(healthy: boolean, reason: string): string {
  if (healthy) return 'LIVE●';
  switch (reason) {
    case 'offline': return '오프라인';
    case 'closed': return '장 마감';
    case 'reconnecting': return '재연결 중…';
    case 'subscribing': return '구독 중…';
    case 'sub_failed': return '구독 실패';
    case 'stale': return '수신 끊김';
    default: return reason;
  }
}

export function captureHealthPillColor(severity: CaptureHealthSeverity): {
  bg: string; border: string; fg: string;
} {
  switch (severity) {
    case 'error':
      return { bg: 'var(--tint-error)', border: 'var(--error)', fg: 'var(--error)' };
    case 'warn':
      return { bg: 'rgba(245, 158, 11, 0.10)', border: 'var(--warn)', fg: 'var(--warn)' };
    case 'ok':
      return { bg: 'transparent', border: 'var(--border)', fg: 'var(--fg-dimmer)' };
  }
}
