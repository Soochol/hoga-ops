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
      <div className="font-medium text-sm font-mono text-fg-dim mb-1.5">
        {`${year}.${String(month).padStart(2, '0')}`}
      </div>
      <div className="grid grid-cols-[repeat(7,2rem)] gap-0.5">
        {cells}
      </div>
    </div>
  );
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  // month is 1-12. Shift by delta months, normalizing across year boundaries.
  const idx = (year * 12 + (month - 1)) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

const YEAR_SPAN = 5;  // year selector covers [reference-YEAR_SPAN, reference+1]

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

  // Internal display state — props are initial values only. Lets the picker
  // navigate (prev / next / jump / today) without the parent re-rendering.
  const [displayYear, setDisplayYear] = useState(referenceYear);
  const [displayMonth, setDisplayMonth] = useState(referenceMonth);

  const nextYear = displayMonth === 12 ? displayYear + 1 : displayYear;
  const nextMonth = displayMonth === 12 ? 1 : displayMonth + 1;

  const left = useCalendar(code, displayYear, displayMonth);
  const right = useCalendar(code, nextYear, nextMonth);

  const shiftBy = (delta: number) => {
    const { year, month } = shiftMonth(displayYear, displayMonth, delta);
    setDisplayYear(year);
    setDisplayMonth(month);
  };
  const goToToday = () => {
    setDisplayYear(referenceYear);
    setDisplayMonth(referenceMonth);
  };

  // Year selector: a small window around the reference month — enough for
  // common back-fills without flooding the dropdown.
  const yearOptions = Array.from({ length: YEAR_SPAN + 2 }, (_, i) => referenceYear - YEAR_SPAN + i);

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

  const atReference = displayYear === referenceYear && displayMonth === referenceMonth;

  return (
    <div className="flex flex-col gap-2">
      <div data-testid="picker-nav" className="flex items-center gap-1.5 font-medium text-sm font-mono text-fg-dim">
        <button type="button" aria-label="Previous month" onClick={() => shiftBy(-1)} className={navBtnCls}>‹</button>
        <select
          aria-label="Year"
          value={displayYear}
          onChange={(e) => setDisplayYear(Number(e.target.value))}
          className={navSelectCls}
        >
          {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select
          aria-label="Month"
          value={displayMonth}
          onChange={(e) => setDisplayMonth(Number(e.target.value))}
          className={navSelectCls}
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
          ))}
        </select>
        <button type="button" aria-label="Next month" onClick={() => shiftBy(1)} className={navBtnCls}>›</button>
        <button
          type="button"
          onClick={goToToday}
          disabled={atReference}
          className={`${navBtnCls} px-2${atReference ? ' opacity-40' : ''}`}
        >Today</button>
      </div>
      <div className="flex gap-4">
        <MonthGrid code={code} year={displayYear} month={displayMonth} value={displayValue} statusByDate={statusByDate} onPick={onPick} />
        <MonthGrid code={code} year={nextYear} month={nextMonth} value={displayValue} statusByDate={statusByDate} onPick={onPick} />
      </div>
    </div>
  );
}

const navBtnCls = 'bg-transparent border border-border-strong text-fg-dim rounded-md py-[0.1rem] px-xs font-medium text-sm font-mono cursor-pointer leading-none';
const navSelectCls = 'bg-bg-input border text-fg rounded-md py-[0.1rem] px-xs font-medium text-sm font-mono cursor-pointer';
