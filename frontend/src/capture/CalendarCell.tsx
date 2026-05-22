import { useState, type CSSProperties, type MouseEventHandler } from 'react';
import { markerFor } from './useCalendar';
import type { CalendarStatus } from '../api/types';

const DISABLED_STATUSES: ReadonlySet<CalendarStatus> = new Set([
  'weekend', 'holiday', 'future', 'today_locked',
]);

const STATUS_BADGE_COLOR: Partial<Record<CalendarStatus, string>> = {
  complete: 'var(--up)',
  source_partial: 'var(--warn)',
  client_incomplete: 'var(--down)',
};

export interface CalendarCellProps {
  date: string;                  // YYYYMMDD
  status: CalendarStatus;
  selected?: boolean;            // range endpoint
  inRange?: boolean;             // between endpoints
  onClick?: (date: string) => void;
}

function tooltipFor(status: CalendarStatus, date: string): string {
  // spec §4.2: hover tooltip per status. weekend/holiday/future/today_locked
  // show the reason; complete/source_partial/client_incomplete show status name
  // (the caller — DateRangePicker — extends this when it has captured_at_ms).
  switch (status) {
    case 'weekend': return `${date} · weekend`;
    case 'holiday': return `${date} · KRX holiday`;
    case 'future': return `${date} · future date`;
    case 'today_locked': return `${date} · today < 18:00 KST (locked)`;
    case 'complete': return `${date} · captured (complete)`;
    case 'source_partial': return `${date} · captured (source partial — data gaps)`;
    case 'client_incomplete': return `${date} · partial pages on disk (resume on capture)`;
    case 'none': default: return date;
  }
}

export function CalendarCell({ date, status, selected = false, inRange = false, onClick }: CalendarCellProps) {
  const day = parseInt(date.slice(6, 8), 10);
  const disabled = DISABLED_STATUSES.has(status);
  // F1 (design review): hover state honors DESIGN.md token --bg-input-hover.
  const [hovered, setHovered] = useState(false);

  const baseColor: string =
    status === 'weekend' || status === 'holiday' || status === 'future' ? 'var(--fg-dimmer)'
    : status === 'today_locked' ? 'var(--fg-dim)'
    : 'var(--fg)';

  let background: string = 'transparent';
  if (selected) background = 'var(--accent)';
  else if (inRange) background = 'rgba(20,184,166,0.18)';
  else if (hovered && !disabled) background = 'var(--bg-input-hover)';   // F1

  const color: string = selected ? 'var(--bg)' : baseColor;
  const cursor: CSSProperties['cursor'] = disabled ? 'not-allowed' : 'pointer';

  const marker = markerFor(status);
  const markerColor = STATUS_BADGE_COLOR[status];

  const handleClick: MouseEventHandler<HTMLButtonElement> = () => {
    if (disabled) return;
    onClick?.(date);
  };

  return (
    <button
      type="button"
      data-testid={`calendar-cell-${date}`}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}      // keyboard focus mirrors hover for a11y
      onBlur={() => setHovered(false)}
      disabled={disabled}
      title={tooltipFor(status, date)}        // F2: spec §4.2 tooltip
      aria-label={tooltipFor(status, date)}
      style={{
        position: 'relative',
        width: 32, height: 32,
        borderRadius: 4,
        border: 'none',
        padding: 0,
        background,
        color,
        cursor,
        font: '500 12px "Geist Mono", monospace',
        fontVariantNumeric: 'tabular-nums',
        // Focus ring per DESIGN.md focus state (teal accent border).
        outline: 'none',
        boxShadow: hovered && !disabled && !selected ? '0 0 0 1px var(--accent)' : 'none',
      }}
    >
      {day}
      {marker !== null && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 1, right: 2,
            fontSize: 9, lineHeight: 1,
            color: markerColor ?? 'inherit',
          }}
        >
          {marker}
        </span>
      )}
    </button>
  );
}
