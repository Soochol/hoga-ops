import type { ReactNode } from 'react';
import { useLivePageStore } from '../state/livePage';
import LiveDrawingMenu from './LiveDrawingMenu';
import { TimeframeControl } from './TimeframeControl';

type Props = {
  onOpenIndicators: () => void;
  onOpenSettings: () => void;
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
      <button
        type="button"
        data-testid="live-indicators-button"
        onClick={onOpenIndicators}
        aria-label="보조지표"
        className="ml-1 inline-flex items-center gap-1 px-2 py-1 rounded hover:opacity-90 transition-opacity"
        style={{
          background: 'var(--bg-input)',
          color: 'var(--fg-dim)',
          border: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>보조지표</span>
      </button>
      <button
        type="button"
        data-testid="live-settings-button"
        onClick={onOpenSettings}
        aria-label="설정"
        className="inline-flex items-center gap-1 px-2 py-1 rounded hover:opacity-90 transition-opacity"
        style={{
          background: 'var(--bg-input)',
          color: 'var(--fg-dim)',
          border: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>설정</span>
      </button>
      <LiveDrawingMenu />
      {studySaveControl}
    </>
  );
}

export function LiveToolbar({ onOpenIndicators, onOpenSettings, studySaveControl }: Props) {
  const tf = useLivePageStore((s) => s.candleTimeframe);
  const setTf = useLivePageStore((s) => s.setCandleTimeframe);
  const rememberedMinute = useLivePageStore((s) => s.lastMinuteTimeframe);

  return (
    <div
      data-testid="live-toolbar"
      className="flex items-center gap-2 border-b px-3 overflow-x-auto flex-nowrap"
      style={{
        height: 'var(--h-toolbar)',
        borderColor: 'var(--border)',
        background: 'var(--bg-card)',
      }}
    >
      <TimeframeControl timeframe={tf} rememberedMinute={rememberedMinute} onChange={setTf} />
      <LiveChartActionButtons
        onOpenIndicators={onOpenIndicators}
        onOpenSettings={onOpenSettings}
        studySaveControl={studySaveControl}
      />
    </div>
  );
}
