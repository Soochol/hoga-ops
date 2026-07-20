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
  /**
   * 극저폭 접힘(#762 2단계): 일·주·월 버튼을 드롭다운 안으로 합쳐 한 컨트롤로
   * 만든다. 라벨만 접어도 헤더는 213px 를 요구하는데 창은 160px 까지 좁아져
   * 액션 버튼이 다시 잘렸다 — 이 모드에서 필요 폭이 ~110px 로 떨어진다.
   */
  compact?: boolean;
};

const CALENDAR_LABELS: Record<CalendarTimeframe, string> = {
  D: '일',
  W: '주',
  M: '월',
};

function minuteLabel(tf: MinuteTimeframe): string {
  return `${tf.slice(0, -1)}분`;
}

export function TimeframeControl({ timeframe, rememberedMinute, onChange, compact = false }: Props) {
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
    // compact 에서는 이 버튼이 유일한 진입로다 — 캘린더 봉일 때도 분봉으로
    // 튀지 않고 메뉴를 연다(안 그러면 일→월 전환에 분봉을 거쳐야 한다).
    if (!isCurrentMinute && !compact) {
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

  // compact 은 캘린더 봉도 이 버튼이 표시한다 — 현재 봉을 그대로 보여준다.
  const triggerLabel = compact && !isCurrentMinute
    ? CALENDAR_LABELS[timeframe as CalendarTimeframe]
    : minuteLabel(displayedMinute);
  const minuteButtonLabel = compact
    ? `봉 선택 열기: ${triggerLabel}`
    : isCurrentMinute
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
      {compact && CALENDAR_TIMEFRAMES.map((calendar) => {
        const selected = timeframe === calendar;
        return (
          <button
            key={calendar}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            onClick={() => pickCalendar(calendar)}
            className={
              (selected
                ? 'bg-bg-input-hover text-accent'
                : 'text-fg-dim hover:text-fg hover:bg-bg-input-hover') +
              ' w-full text-left px-3 py-1.5 text-sm font-mono'
            }
          >
            {CALENDAR_LABELS[calendar]}
          </button>
        );
      })}
      {compact && <div className="my-1 border-t border-border" />}
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
            // compact 에서는 이 버튼이 항상 현재 봉을 나타내므로 늘 활성이다.
            background: compact || isCurrentMinute ? 'var(--tint-selection)' : 'transparent',
            color: compact || isCurrentMinute ? 'var(--accent)' : 'var(--fg-dim)',
          }}
        >
          <span>{triggerLabel}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        {minuteMenu && createPortal(minuteMenu, document.body)}
      </div>
      {!compact && CALENDAR_TIMEFRAMES.map((calendar) => {
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
