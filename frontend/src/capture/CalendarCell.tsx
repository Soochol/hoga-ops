import { useState, type MouseEventHandler } from 'react';
import type { CalendarStatus } from '../api/types';
import { CALENDAR_STATUS, tooltipFor } from './calendarStatus';

export interface CalendarCellProps {
  date: string;                  // YYYYMMDD
  status: CalendarStatus;
  selected?: boolean;            // range endpoint
  inRange?: boolean;             // between endpoints
  onClick?: (date: string) => void;
}

export function CalendarCell({ date, status, selected = false, inRange = false, onClick }: CalendarCellProps) {
  const day = parseInt(date.slice(6, 8), 10);
  const descriptor = CALENDAR_STATUS[status];
  const disabled = descriptor.disabled;
  // F1 (design review): hover state honors DESIGN.md token --bg-input-hover.
  const [hovered, setHovered] = useState(false);

  let background: string = 'transparent';
  if (selected) background = 'var(--accent)';
  else if (inRange) background = 'rgba(20,184,166,0.18)';
  else if (hovered && !disabled) background = 'var(--bg-input-hover)';   // F1

  const color: string = selected ? 'var(--bg)' : descriptor.baseColorVar;
  const cursor = disabled ? 'not-allowed' : 'pointer';

  const tooltip = tooltipFor(status, date);

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
      title={tooltip}        // F2: spec §4.2 tooltip
      aria-label={tooltip}
      style={{
        background,
        color,
        cursor,
        // Focus ring per DESIGN.md focus state (teal accent border).
        boxShadow: hovered && !disabled && !selected ? '0 0 0 1px var(--accent)' : 'none',
      }}
      className="relative w-8 h-8 rounded-md border-none p-0 font-medium text-sm font-mono tabular-nums outline-none"
    >
      {day}
      {descriptor.marker !== null && (
        <span
          aria-hidden
          style={{ color: descriptor.badgeColor ?? 'inherit' }}
          className="absolute top-px right-0.5 text-xs leading-none"
        >
          {descriptor.marker}
        </span>
      )}
    </button>
  );
}
