import type { CSSProperties } from 'react';
import { TIME_AXIS_PX } from './paneFolding';

/**
 * 접힌 지표 개수 알림 — 창이 작아 pane 이 접혔을 때만 뜬다.
 *
 * 이게 없으면 사용자는 **지표가 꺼진 줄 알고 드로어를 다시 만진다.** 실제로는 켜져
 * 있고 지금 크기에서 그릴 자리가 없을 뿐이라(`paneFolding.ts`), "왜 안 보이는지" 와
 * "어떻게 되돌리는지"를 한 줄로 알려주는 게 이 컴포넌트의 전부다.
 *
 * 레전드와 같은 크롬(불투명 `--bg-card` + `--radius-md` + mono `--text-xs`)을 쓰고,
 * 크로스헤어가 아래에서 계속 추적하도록 `pointerEvents: none` 이다.
 */
const noticeStyle: CSSProperties = {
  position: 'absolute',
  left: 'var(--space-xs)',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2xs)',
  background: 'var(--bg-card)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2xs) var(--space-sm)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.4,
  color: 'var(--fg-dimmer)',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
  overflow: 'hidden',
  pointerEvents: 'none',
  // lightweight-charts 내부 위젯(특히 하단 시간축)이 자체 스택 컨텍스트를 만들어
  // 그 위로 올라온다 — PaneLegendOverlay 가 같은 이유로 zIndex 4 를 쓴다.
  zIndex: 4,
};

export function FoldedPaneNotice({
  count,
  timeAxisVisible = true,
}: {
  count: number;
  /** 시간축이 보이면 그 위로 띄운다 — 안 그러면 눈금 라벨을 덮는다. */
  timeAxisVisible?: boolean;
}) {
  if (count <= 0) return null;
  return (
    <div
      data-testid="folded-pane-notice"
      style={{
        ...noticeStyle,
        bottom: timeAxisVisible
          ? `calc(${TIME_AXIS_PX}px + var(--space-2xs))`
          : 'var(--space-xs)',
      }}
      // 마우스를 올릴 수 없으니(pointerEvents:none) 스크린리더용으로만 남긴다.
      aria-label={`창이 작아 지표 ${count}개를 표시하지 않았습니다. 창을 키우면 다시 나타납니다.`}
    >
      지표 {count} 숨김
    </div>
  );
}
