import {
  captureHealthLabel,
  captureHealthSeverity,
  type CaptureHealthSeverity,
} from './liveStatusProjection';
import { noticeColors } from '../ui/noticeTone';

export { captureHealthLabel, captureHealthSeverity };

export function captureHealthPillColor(severity: CaptureHealthSeverity): {
  bg: string; border: string; fg: string;
} {
  // border는 완결된 CSS 값(2026-07-15 borderless): ok=정보성 상태라 외곽선 없이 plain
  // 텍스트, error는 tint 채움 + 외곽선으로 알림 pill을 유지한다.
  //
  switch (severity) {
    case 'warn':
    case 'error': {
      const colors = noticeColors(severity);
      return { bg: colors.background, border: `1px solid ${colors.border}`, fg: colors.foreground };
    }
    case 'ok':
      return { bg: 'transparent', border: 'none', fg: 'var(--fg-dim)' };
  }
}
