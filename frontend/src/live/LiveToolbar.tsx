/**
 * 차트 액션 버튼 — 낱개 부품 (#759 결정 7).
 *
 * 원래는 `LiveChartActionButtons` 한 묶음이었고, 그 근거는 "/live 전역 툴바와
 * /study 툴바가 똑같이 쓴다" 였다. #758 로 그 전제가 깨졌다 — 보조지표는 차트
 * 창 헤더가 소유한다(창의 것). 조립처마다 필요한 조합이 달라졌으므로 묶음을 풀어
 * 낱개로 둔다.
 *
 * 여기 있던 `SettingsButton` 은 **삭제됐다**(2026-08-17). 설정은 앱 전역 드로어이고
 * 진입점이 상단 TopNav 「설정」 하나로 모였다 — 툴바에 두면 같은 드로어를 여는 두
 * 번째 버튼일 뿐이고, `/live`·`/study` 에만 있어 진입점으로도 고르지 않았다.
 *
 * 남은 조립: 차트 창 헤더 = 보조지표.
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
