import { useState, useEffect, useMemo } from 'react';
import { useCalendar } from './useCalendar';
import { CalendarCell } from './CalendarCell';
import type { CalendarStatus } from '../api/types';

export interface DateRange {
  start: string;       // YYYYMMDD
  end: string | null;  // null while only anchor is set
}

export interface DateRangePickerProps {
  code: string | null;
  /** Reference month for the left grid (right is +1 month). Caller controls
   *  this; defaults to the current KST month. */
  referenceYear: number;
  referenceMonth: number;  // 1-12
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function dateStr(year: number, month: number, day: number): string {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function inRange(date: string, range: DateRange | null): boolean {
  if (range === null || range.end === null) return false;
  return date >= range.start && date <= range.end;
}

function MonthGrid({
  code, year, month, value, statusByDate, onPick,
}: {
  code: string | null;
  year: number;
  month: number;
  value: DateRange | null;
  statusByDate: Map<string, CalendarStatus>;
  onPick: (date: string) => void;
}) {
  const last = daysInMonth(year, month);
  const cells = [];
  for (let day = 1; day <= last; day++) {
    const d = dateStr(year, month, day);
    const status: CalendarStatus = statusByDate.get(d) ?? 'none';
    const selected = value?.start === d || value?.end === d;
    cells.push(
      <CalendarCell
        key={d} date={d} status={status}
        selected={selected} inRange={inRange(d, value)}
        onClick={code === null ? undefined : onPick}
      />
    );
  }
  return (
    <div>
      <div style={{ font: '500 11px "Geist Mono", monospace', color: 'var(--fg-dim)', marginBottom: 6 }}>
        {`${year}.${String(month).padStart(2, '0')}`}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 32px)', gap: 2 }}>
        {cells}
      </div>
    </div>
  );
}

export function DateRangePicker({ code, referenceYear, referenceMonth, value, onChange }: DateRangePickerProps) {
  // Q14: re-render every 60s so today_locked transitions cleanly through 18:00 KST.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Internal anchor state: lets the picker complete a range across two clicks
  // even when the parent doesn't yet pipe the partial `{start, end: null}` back
  // through `value`. Cleared once a complete range is emitted.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);

  const nextYear = referenceMonth === 12 ? referenceYear + 1 : referenceYear;
  const nextMonth = referenceMonth === 12 ? 1 : referenceMonth + 1;

  const left = useCalendar(code, referenceYear, referenceMonth);
  const right = useCalendar(code, nextYear, nextMonth);

  const statusByDate = useMemo(() => {
    const m = new Map<string, CalendarStatus>();
    left.data?.cells.forEach((c) => m.set(c.date, c.status));
    right.data?.cells.forEach((c) => m.set(c.date, c.status));
    return m;
  }, [left.data, right.data]);

  const onPick = (date: string) => {
    // Complete range already present → start fresh anchor.
    if (value !== null && value.end !== null) {
      setPendingAnchor(date);
      onChange({ start: date, end: null });
      return;
    }
    // Determine the current anchor from either source.
    const anchor = value?.start ?? pendingAnchor;
    if (anchor === null) {
      setPendingAnchor(date);
      onChange({ start: date, end: null });
      return;
    }
    // Completing the range — swap if reversed.
    setPendingAnchor(null);
    if (date < anchor) {
      onChange({ start: date, end: anchor });
    } else {
      onChange({ start: anchor, end: date });
    }
  };

  // If the parent doesn't reflect the partial range yet, surface pendingAnchor
  // visually so the user sees their first click highlighted before the second.
  const displayValue: DateRange | null =
    value ?? (pendingAnchor === null ? null : { start: pendingAnchor, end: null });

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <MonthGrid code={code} year={referenceYear} month={referenceMonth} value={displayValue} statusByDate={statusByDate} onPick={onPick} />
      <MonthGrid code={code} year={nextYear} month={nextMonth} value={displayValue} statusByDate={statusByDate} onPick={onPick} />
    </div>
  );
}
