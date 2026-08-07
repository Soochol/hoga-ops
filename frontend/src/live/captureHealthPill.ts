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
  // 텍스트, error는 tint 채움 + 외곽선으로 알림 pill을 유지한다.
  //
  // 앰버 케이스(`rgba(245,158,11,.10)` + `--warn`)는 severity 에서 'warn' 이 사라지며
  // 같이 내렸다 — 그 등급으로 가는 유일한 reason 두 개가 ADR-0118 PR-G 이후 백엔드에
  // 없다. 되살릴 땐 severity 타입·이 스위치·CAPTURE_REASON_VIEW 를 한 번에 손대면 된다.
  switch (severity) {
    case 'error':
      return { bg: 'var(--tint-error)', border: '1px solid var(--error)', fg: 'var(--error)' };
    case 'ok':
      return { bg: 'transparent', border: 'none', fg: 'var(--fg-dim)' };
  }
}
