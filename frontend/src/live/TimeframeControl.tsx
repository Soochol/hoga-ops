import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const isCurrentMinute = isMinuteTimeframe(timeframe);
  const displayedMinute = isMinuteTimeframe(timeframe) ? timeframe : rememberedMinute;

  const closeMinuteMenu = useCallback(() => setMinuteMenuOpen(false), []);
  useDismissablePopover(minuteMenuOpen, minuteWrapRef, closeMinuteMenu);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const onMinuteSelectorClick = () => {
    if (!isCurrentMinute) {
      setMinuteMenuOpen(false);
      onChange(rememberedMinute);
      return;
    }

    setAnchorRect(minuteButtonRef.current?.getBoundingClientRect() ?? null);
    setMinuteMenuOpen((open) => !open);
  };

  const pickMinute = (next: MinuteTimeframe) => {
    setMinuteMenuOpen(false);
    onChange(next);
  };

  const pickCalendar = (next: CalendarTimeframe) => {
    setMinuteMenuOpen(false);
    onChange(next);
  };

  const minuteButtonLabel = isCurrentMinute
    ? `분봉 선택 열기: ${minuteLabel(displayedMinute)}`
    : `분봉으로 전환: ${minuteLabel(displayedMinute)}`;
  const minuteMenu = minuteMenuOpen && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label="분봉 목록"
      onMouseDown={(event) => event.stopPropagation()}
      className="w-24 bg-bg-card border border-border rounded shadow-lg z-50 py-1"
      style={{ position: 'fixed', left, top }}
    >
      {MINUTE_TIMEFRAMES.map((minute) => {
        const selected = displayedMinute === minute;
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
  ) : null;

  return (
    <div className="flex gap-1" role="group" aria-label="LiveTimeframe">
      <div ref={minuteWrapRef} className="relative">
        <button
          ref={minuteButtonRef}
          type="button"
          onClick={onMinuteSelectorClick}
          aria-label={minuteButtonLabel}
          aria-haspopup="menu"
          aria-expanded={minuteMenuOpen}
          className="inline-flex min-h-6 items-center gap-1 rounded-[7px] font-mono text-xs transition-colors hover:bg-bg-input-hover hover:text-fg"
          style={{
            padding: '4px 10px',
            // 테두리 없는 ghost(2026-07-15) — 비활성은 투명, 활성만 tint-selection+accent로 강조.
            background: isCurrentMinute ? 'var(--tint-selection)' : 'transparent',
            color: isCurrentMinute ? 'var(--accent)' : 'var(--fg-dim)',
          }}
        >
          <span>{minuteLabel(displayedMinute)}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        {minuteMenu && createPortal(minuteMenu, document.body)}
      </div>
      {CALENDAR_TIMEFRAMES.map((calendar) => {
        const active = timeframe === calendar;
        return (
          <button
            key={calendar}
            type="button"
            onClick={() => pickCalendar(calendar)}
            aria-pressed={active}
            className="min-h-6 rounded-[7px] px-2 py-1 font-mono text-xs transition-colors hover:bg-bg-input-hover hover:text-fg"
            style={{
              // 테두리 없는 ghost(2026-07-15) — 비활성은 투명, 활성만 tint-selection+accent로 강조.
              background: active ? 'var(--tint-selection)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--fg-dim)',
            }}
          >
            {CALENDAR_LABELS[calendar]}
          </button>
        );
      })}
    </div>
  );
}
