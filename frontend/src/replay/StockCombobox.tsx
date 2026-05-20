import { useEffect, useMemo, useRef, useState } from 'react';
import { useStockDates } from '../api/stock-dates';

export default function StockCombobox({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (code: string) => void;
}) {
  const { data: inventory = [] } = useStockDates();
  const stocks = useMemo(() => {
    const m = new Map<string, { code: string; name: string; dates: number }>();
    for (const r of inventory) {
      const e = m.get(r.code) ?? { code: r.code, name: r.name, dates: 0 };
      e.dates += 1;
      m.set(r.code, e);
    }
    return [...m.values()].sort((a, b) => b.dates - a.dates || a.code.localeCompare(b.code));
  }, [inventory]);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return stocks;
    return stocks
      .filter((s) => s.code.startsWith(f) || s.name.toLowerCase().includes(f))
      .sort((a, b) => Number(b.code.startsWith(f)) - Number(a.code.startsWith(f)));
  }, [stocks, q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const selected = stocks.find((s) => s.code === value);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-input border rounded text-sm min-w-[240px] hover:bg-bg-input-hover"
      >
        <span className="font-mono text-accent">{selected?.code ?? '종목 선택'}</span>
        <span className="flex-1 text-left">{selected?.name ?? ''}</span>
        <span className="text-fg-dim">▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[320px] bg-bg-card border border-border-strong rounded shadow-xl z-50">
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setHi((h) => Math.min(h + 1, matches.length - 1));
              if (e.key === 'ArrowUp') setHi((h) => Math.max(h - 1, 0));
              if (e.key === 'Enter' && matches[hi]) {
                onChange(matches[hi].code);
                setOpen(false);
              }
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="종목 코드 또는 이름 검색..."
            className="w-full bg-bg-subtle border-b p-2.5 text-sm font-mono outline-none"
          />
          <div className="max-h-72 overflow-y-auto py-1">
            {matches.map((s, i) => (
              <div
                key={s.code}
                onClick={() => {
                  onChange(s.code);
                  setOpen(false);
                }}
                className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer ${
                  i === hi ? 'bg-bg-input-hover' : ''
                }`}
              >
                <span className="font-mono text-xs text-accent w-14">{s.code}</span>
                <span className="flex-1 text-sm">{s.name}</span>
                <span className="font-mono text-[10.5px] text-fg-dim">{s.dates} dates</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
