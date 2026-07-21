/**
 * 차트 액션 버튼 — 낱개 부품 (#759 결정 7).
 *
 * 원래는 `LiveChartActionButtons` 한 묶음이었고, 그 근거는 "/live 전역 툴바와
 * /study 툴바가 똑같이 쓴다" 였다. #758 로 그 전제가 깨졌다 — 보조지표는 차트
 * 창 헤더가 소유하고(창의 것), 설정은 전역 툴바에 남는다(앱의 것). 조립처마다
 * 필요한 조합이 달라졌으므로 묶음을 풀어 낱개로 둔다.
 *
 * 조립: /study = 둘 다 · /live 전역 툴바 = 설정만 · 차트 창 헤더 = 보조지표만.
 */
import { IconToolbarButton } from '../ui/WorkspaceShell';
import { COMPACT_PADDING_INLINE } from './workspace/chartHeaderCompact';

export function IndicatorsButton({
  onClick,
  showLabel = true,
  className,
}: {
  onClick: () => void;
  /** false 면 아이콘만 — 창 헤더가 좁을 때 라벨을 접는다(#762 접힘 정책). */
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <IconToolbarButton
      data-testid="live-indicators-button"
      onClick={onClick}
      aria-label="보조지표"
      title="보조지표"
      className={className}
      style={showLabel ? undefined : { paddingInline: COMPACT_PADDING_INLINE }}
      icon={(
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      )}
    >
      {showLabel && <span>보조지표</span>}
    </IconToolbarButton>
  );
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <IconToolbarButton
      data-testid="live-settings-button"
      onClick={onClick}
      aria-label="설정"
      icon={(
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )}
    >
      <span>설정</span>
    </IconToolbarButton>
  );
}
