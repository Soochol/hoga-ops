import { useEffect, useMemo, useRef, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { useStockDates } from '../api/stock-dates';

export default function DateRangePicker({
  code,
  from,
  to,
  onChange,
}: {
  code: string | null;
  from: string | null;
  to: string | null;
  onChange: (from: string, to: string) => void;
}) {
  const { data = [] } = useStockDates();
  const captured = useMemo(
    () => new Set(data.filter((r) => r.code === code).map((r) => r.date)),
    [data, code],
  );

  // Use local date components, NOT toISOString() — the picker's Date objects
  // represent local-midnight calendar days; toISOString() converts to UTC,
  // which off-by-ones at any nonzero timezone offset (KST is +09:00, so
  // local May 20 midnight becomes UTC May 19 15:00 → "20260519" mismatch).
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  };

  const disabledMatcher = (d: Date) => !captured.has(fmt(d));

  const [openWhich, setOpenWhich] = useState<'from' | 'to' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpenWhich(null);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div ref={ref} className="flex items-center gap-1.5 relative">
      <DateButton label={from} onClick={() => setOpenWhich('from')} />
      <span className="text-fg-dim">→</span>
      <DateButton label={to} onClick={() => setOpenWhich('to')} />
      {openWhich && (
        <div className="absolute top-full mt-1 z-50 bg-bg-card border border-border-strong rounded shadow-xl p-2">
          <DayPicker
            mode="single"
            disabled={disabledMatcher}
            onSelect={(d) => {
              if (!d) return;
              const s = fmt(d);
              const newFrom = openWhich === 'from' ? s : from ?? s;
              const newTo = openWhich === 'to' ? s : to ?? s;
              onChange(newFrom, newTo);
              setOpenWhich(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function DateButton({ label, onClick }: { label: string | null; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-bg-input border rounded font-mono text-xs"
    >
      {label ? `${label.slice(0, 4)}-${label.slice(4, 6)}-${label.slice(6, 8)}` : 'YYYY-MM-DD'}
    </button>
  );
}
