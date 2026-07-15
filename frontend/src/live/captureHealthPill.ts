import {
  captureHealthLabel,
  captureHealthSeverity,
  type CaptureHealthSeverity,
} from './liveStatusProjection';

export { captureHealthLabel, captureHealthSeverity };

export function captureHealthPillColor(severity: CaptureHealthSeverity): {
  bg: string; border: string; fg: string;
} {
  // border는 완결된 CSS 값(2026-07-15 borderless): ok=정보성 상태라 외곽선 없이 plain
  // 텍스트, warn/error는 tint 채움 + 외곽선으로 알림 pill을 유지한다.
  switch (severity) {
    case 'error':
      return { bg: 'var(--tint-error)', border: '1px solid var(--error)', fg: 'var(--error)' };
    case 'warn':
      return { bg: 'rgba(245, 158, 11, 0.10)', border: '1px solid var(--warn)', fg: 'var(--warn)' };
    case 'ok':
      return { bg: 'transparent', border: 'none', fg: 'var(--fg-dimmer)' };
  }
}
