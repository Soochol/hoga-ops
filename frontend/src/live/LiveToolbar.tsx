import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  CALENDAR_TIMEFRAMES,
  MINUTE_TIMEFRAMES,
  isMinuteTimeframe,
  type CalendarTimeframe,
  type MinuteTimeframe,
  useLivePageStore,
} from '../state/livePage';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import LiveDrawingMenu from './LiveDrawingMenu';

type Props = {
  onOpenIndicators: () => void;
  onOpenSettings: () => void;
  studySaveControl?: ReactNode;
};

const CALENDAR_LABELS: Record<CalendarTimeframe, string> = {
  D: '일',
  W: '주',
  M: '월',
};

function minuteLabel(tf: MinuteTimeframe): string {
  return `${tf.slice(0, -1)}분`;
}

export function LiveToolbar({ onOpenIndicators, onOpenSettings, studySaveControl }: Props) {
  const tf = useLivePageStore((s) => s.candleTimeframe);
  const setTf = useLivePageStore((s) => s.setCandleTimeframe);
  const rememberedMinute = useLivePageStore((s) => s.lastMinuteTimeframe);
  const [minuteMenuOpen, setMinuteMenuOpen] = useState(false);
  const minuteWrapRef = useRef<HTMLDivElement>(null);
  const minuteButtonRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const displayedMinute = isMinuteTimeframe(tf) ? tf : rememberedMinute;

  const closeMinuteMenu = useCallback(() => setMinuteMenuOpen(false), []);
  useDismissablePopover(minuteMenuOpen, minuteWrapRef, closeMinuteMenu);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const onMinuteSelectorClick = () => {
    if (isMinuteTimeframe(tf)) {
      setAnchorRect(minuteButtonRef.current?.getBoundingClientRect() ?? null);
      setMinuteMenuOpen((open) => !open);
      return;
    }
    setMinuteMenuOpen(false);
    setTf(rememberedMinute);
  };

  const pickMinute = (next: MinuteTimeframe) => {
    setMinuteMenuOpen(false);
    setTf(next);
  };

  const pickCalendar = (next: CalendarTimeframe) => {
    setMinuteMenuOpen(false);
    setTf(next);
  };

  const minuteButtonLabel = isMinuteTimeframe(tf)
    ? `분봉 선택 열기: ${minuteLabel(displayedMinute)}`
    : `${minuteLabel(rememberedMinute)}봉으로 전환`;

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
      <div className="flex gap-1" role="group" aria-label="LiveTimeframe">
        <div ref={minuteWrapRef} className="relative">
          <button
            ref={minuteButtonRef}
            type="button"
            onClick={onMinuteSelectorClick}
            aria-label={minuteButtonLabel}
            aria-haspopup={isMinuteTimeframe(tf) ? 'menu' : undefined}
            aria-expanded={isMinuteTimeframe(tf) ? minuteMenuOpen : undefined}
            className="inline-flex items-center gap-1 rounded font-mono hover:opacity-90 transition-opacity"
            style={{
              padding: '4px 10px',
              background: isMinuteTimeframe(tf) ? 'var(--tint-selection)' : 'var(--bg-input)',
              color: isMinuteTimeframe(tf) ? 'var(--accent)' : 'var(--fg-dim)',
              fontSize: 'var(--text-xs)',
              border: '1px solid',
              borderColor: isMinuteTimeframe(tf) ? 'var(--accent)' : 'var(--border)',
            }}
          >
            <span>{minuteLabel(displayedMinute)}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          {minuteMenuOpen && anchorRect && (
            <div
              ref={menuPositionRef}
              role="menu"
              aria-label="분봉 목록"
              className="w-24 bg-bg-card border border-border rounded shadow-lg z-30 py-1"
              style={{ position: 'fixed', left, top }}
            >
              {MINUTE_TIMEFRAMES.map((minute) => {
                const selected = tf === minute;
                return (
                  <button
                    key={minute}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => pickMinute(minute)}
                    className={
                      (selected
                        ? 'bg-bg-input-hover text-accent'
                        : 'text-fg-dim hover:text-fg hover:bg-bg-input-hover') +
                      ' w-full text-left px-3 py-1.5 text-sm font-mono'
                    }
                  >
                    {minuteLabel(minute)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {CALENDAR_TIMEFRAMES.map((calendar) => {
          const active = tf === calendar;
          return (
            <button
              key={calendar}
              type="button"
              onClick={() => pickCalendar(calendar)}
              aria-pressed={active}
              className="px-2 py-1 rounded font-mono hover:opacity-90 transition-opacity"
              style={{
                background: active ? 'var(--tint-selection)' : 'var(--bg-input)',
                color: active ? 'var(--accent)' : 'var(--fg-dim)',
                fontSize: 'var(--text-xs)',
                border: '1px solid',
                borderColor: active ? 'var(--accent)' : 'var(--border)',
              }}
            >
              {CALENDAR_LABELS[calendar]}
            </button>
          );
        })}
      </div>
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
    </div>
  );
}
