/**
 * WorkspaceLiveToolbar — 워크스페이스 상단 고정 툴바 (ADR-0119 C2c-2c).
 *
 * 창 추가(단일 드롭다운 = WindowAddMenu)·정리(Tidy)와 기존 LiveToolbar 의
 * 액션 버튼(보조지표·설정·수집·저장뷰·프리셋)을 한 행으로 통합.
 * 봉 컨트롤은 창별 소유라 여기 없다(각 차트 창 상단). 활성 그룹은 뱃지로 표시.
 * 지표/설정/수집/저장뷰의 열림 상태는 셸(LivePage 또는 프리뷰 페이지)이 소유하고
 * 콜백으로 받는다 — LiveToolbar 와 같은 계약.
 */
import type { ReactNode } from 'react';
import { IconToolbarButton, WorkspaceToolbar } from '../../ui/WorkspaceShell';
import { LiveChartActionButtons } from '../LiveToolbar';
import { LayoutPresetMenu } from '../presets/LayoutPresetMenu';
import { requestWorkspaceTidy } from './workspaceCanvasControls';
import { useCanOpenIndicatorDrawer } from './WorkspaceIndicatorDrawer';
import { WindowAddMenu } from './WindowAddMenu';
import { useWorkspaceStore, activeGroupOf } from '../../state/workspace';

type Props = {
  onOpenIndicators: () => void;
  onOpenSettings: () => void;
  /** 활성 그룹 종목이 주식일 때만 전달(지수 미지원) — LiveToolbar 계약 동일. */
  onOpenCollect?: () => void;
  studySaveControl?: ReactNode;
};

export function WorkspaceLiveToolbar({
  onOpenIndicators,
  onOpenSettings,
  onOpenCollect,
  studySaveControl,
}: Props) {
  const windowCount = useWorkspaceStore((s) => s.windows.length);
  const activeGroup = useWorkspaceStore((s) => activeGroupOf(s));
  const canOpenIndicators = useCanOpenIndicatorDrawer();

  return (
    <WorkspaceToolbar testId="workspace-live-toolbar" className="flex-nowrap">
      <span
        className="flex items-center gap-1 text-xs text-fg-dim"
        title="활성 그룹 — 검색·관심종목 클릭이 이 그룹의 종목을 교체합니다"
      >
        <span className="font-mono">{windowCount}창</span>
        <span>· 그룹</span>
        <span className="font-mono text-accent">{activeGroup}</span>
      </span>
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      <WindowAddMenu />
      {/* 창 추가가 단일 드롭다운으로 접히면서(A안) accent 채움이던 정리가 툴바에서 가장
          튀게 됐다 — 더 자주 쓰는 창 추가보다 강해 위계가 뒤집힌다. 나머지 액션과 같은
          ghost 로 낮춘다. tint-selection 은 이 코드베이스에서 선택·활성 상태의 표식이고
          정리는 상태 없는 일회성 액션이라 의미론상으로도 맞지 않았다. */}
      <IconToolbarButton
        data-testid="workspace-tidy"
        className="shrink-0"
        onClick={requestWorkspaceTidy}
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="8.5" height="16" rx="1.5" />
            <rect x="14.5" y="4" width="6.5" height="6.5" rx="1.5" />
            <rect x="14.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
          </svg>
        )}
      >
        <span>정리</span>
      </IconToolbarButton>
      <span className="mx-1 h-[14px] w-px shrink-0 bg-border-strong" />
      {/* 차트 창 0개면 지표 드로어는 대상이 없다(#712) — 열기를 no-op 으로 가드. */}
      <LiveChartActionButtons
        onOpenIndicators={canOpenIndicators ? onOpenIndicators : () => {}}
        onOpenSettings={onOpenSettings}
        studySaveControl={studySaveControl}
      />
      {onOpenCollect && (
        <IconToolbarButton
          data-testid="live-collect-button"
          onClick={onOpenCollect}
          aria-label="데이터 수집"
          icon={(
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="m7 11 5 4.5 5-4.5" />
              <path d="M5 21h14" />
            </svg>
          )}
        >
          <span>데이터 수집</span>
        </IconToolbarButton>
      )}
      <LayoutPresetMenu />
    </WorkspaceToolbar>
  );
}
