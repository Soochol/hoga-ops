import { useCallback, useRef, useState } from 'react';
import {
  CALENDAR_TIMEFRAMES,
  MINUTE_TIMEFRAMES,
  isMinuteTimeframe,
  type CalendarTimeframe,
  type LiveTimeframe,
  type MinuteTimeframe,
} from '../state/livePage';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';

type Props = {
  timeframe: LiveTimeframe;
  rememberedMinute: MinuteTimeframe;
  onChange: (timeframe: LiveTimeframe) => void;
};

const CALENDAR_LABELS: Record<CalendarTimeframe, string> = {
  D: '일',
  W: '주',
  M: '월',
};

function minuteLabel(tf: MinuteTimeframe): string {
  return `${tf.slice(0, -1)}분`;
}

export function TimeframeControl({ timeframe, rememberedMinute, onChange }: Props) {
  const [minuteMenuOpen, setMinuteMenuOpen] = useState(false);
  const minuteWrapRef = useRef<HTMLDivElement>(null);
  const minuteButtonRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const displayedMinute = isMinuteTimeframe(timeframe) ? timeframe : rememberedMinute;

  const closeMinuteMenu = useCallback(() => setMinuteMenuOpen(false), []);
  useDismissablePopover(minuteMenuOpen, minuteWrapRef, closeMinuteMenu);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const onMinuteSelectorClick = () => {
    if (isMinuteTimeframe(timeframe)) {
      setAnchorRect(minuteButtonRef.current?.getBoundingClientRect() ?? null);
      setMinuteMenuOpen((open) => !open);
      return;
    }
    setMinuteMenuOpen(false);
    onChange(rememberedMinute);
  };

  const pickMinute = (next: MinuteTimeframe) => {
    setMinuteMenuOpen(false);
    onChange(next);
  };

  const pickCalendar = (next: CalendarTimeframe) => {
    setMinuteMenuOpen(false);
    onChange(next);
  };

  const minuteButtonLabel = isMinuteTimeframe(timeframe)
    ? `분봉 선택 열기: ${minuteLabel(displayedMinute)}`
    : `${minuteLabel(rememberedMinute)}봉으로 전환`;

  return (
    <div className="flex gap-1" role="group" aria-label="LiveTimeframe">
      <div ref={minuteWrapRef} className="relative">
        <button
          ref={minuteButtonRef}
          type="button"
          onClick={onMinuteSelectorClick}
          aria-label={minuteButtonLabel}
          aria-haspopup={isMinuteTimeframe(timeframe) ? 'menu' : undefined}
          aria-expanded={isMinuteTimeframe(timeframe) ? minuteMenuOpen : undefined}
          className="inline-flex items-center gap-1 rounded font-mono hover:opacity-90 transition-opacity"
          style={{
            padding: '4px 10px',
            background: isMinuteTimeframe(timeframe) ? 'var(--tint-selection)' : 'var(--bg-input)',
            color: isMinuteTimeframe(timeframe) ? 'var(--accent)' : 'var(--fg-dim)',
            fontSize: 'var(--text-xs)',
            border: '1px solid',
            borderColor: isMinuteTimeframe(timeframe) ? 'var(--accent)' : 'var(--border)',
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
              const selected = timeframe === minute;
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
        const active = timeframe === calendar;
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
  );
}
