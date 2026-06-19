import {
  captureHealthLabel,
  captureHealthSeverity,
  type CaptureHealthSeverity,
} from './liveStatusProjection';

export { captureHealthLabel, captureHealthSeverity };

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
