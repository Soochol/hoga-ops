import type { ReactNode } from 'react';
import { useLivePageStore } from '../state/livePage';
import { TimeframeControl } from './TimeframeControl';
import { IconToolbarButton, WorkspaceToolbar } from '../ui/WorkspaceShell';
import { LayoutPresetMenu } from './presets/LayoutPresetMenu';

type Props = {
  onOpenIndicators: () => void;
  onOpenSettings: () => void;
  /** 활성 종목 지난 N일 hogaplay 수집 다이얼로그 열기 — 주식 종목일 때만 전달(지수 미지원). */
  onOpenCollect?: () => void;
  studySaveControl?: ReactNode;
};

type ActionButtonsProps = {
  onOpenIndicators: () => void;
  onOpenSettings: () => void;
  studySaveControl?: ReactNode;
};

export function LiveChartActionButtons({ onOpenIndicators, onOpenSettings, studySaveControl }: ActionButtonsProps) {
  return (
    <>
      <IconToolbarButton
        data-testid="live-indicators-button"
        onClick={onOpenIndicators}
        aria-label="보조지표"
        className="ml-1"
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        )}
      >
        <span>보조지표</span>
      </IconToolbarButton>
      <IconToolbarButton
        data-testid="live-settings-button"
        onClick={onOpenSettings}
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
      {studySaveControl}
    </>
  );
}

export function LiveToolbar({ onOpenIndicators, onOpenSettings, onOpenCollect, studySaveControl }: Props) {
  const tf = useLivePageStore((s) => s.candleTimeframe);
  const setTf = useLivePageStore((s) => s.setCandleTimeframe);
  const rememberedMinute = useLivePageStore((s) => s.lastMinuteTimeframe);

  return (
    <WorkspaceToolbar testId="live-toolbar" className="flex-nowrap">
      <TimeframeControl timeframe={tf} rememberedMinute={rememberedMinute} onChange={setTf} />
      <LiveChartActionButtons
        onOpenIndicators={onOpenIndicators}
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
