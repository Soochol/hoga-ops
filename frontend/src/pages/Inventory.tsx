import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useStockDates } from '../api/stock-dates';
import { useTabsStore } from '../state/tabs';
import type { StockDate } from '../api/types';

type SortKey =
  | 'code'
  | 'name'
  | 'date'
  | 'captured_at'
  | 'total_volume'
  | 'pages_collected'
  | 'file_size_bytes'
  | 'today_close';
type SortDir = 'asc' | 'desc';

export default function Inventory() {
  const { data: rows = [], isLoading } = useStockDates();
  const [sortKey, setSortKey] = useState<SortKey>('captured_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const navigate = useNavigate();

  const sorted = useMemo(() => {
    const cmp = (a: StockDate, b: StockDate) => {
      const av = a[sortKey] as string | number;
      const bv = b[sortKey] as string | number;
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv);
      return (av as number) - (bv as number);
    };
    const arr = [...rows].sort(cmp);
    return sortDir === 'desc' ? arr.reverse() : arr;
  }, [rows, sortKey, sortDir]);

  const onHeader = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'code' || key === 'name' || key === 'date' ? 'asc' : 'desc');
    }
  };

  const onRowClick = (r: StockDate) => {
    const tabId = useTabsStore.getState().newTab();
    useTabsStore.getState().setSelection(tabId, {
      code: r.code,
      fromDate: r.date,
      toDate: r.date,
    });
    navigate('/replay');
  };

  if (isLoading) {
    return <div className="p-8 text-fg-dim">Loading inventory…</div>;
  }
  if (rows.length === 0) {
    return <div className="p-8 text-fg-dim">캡처된 데이터가 없습니다.</div>;
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <h2 className="text-md font-semibold mb-4">Inventory ({rows.length})</h2>
      <table className="w-full border-collapse font-mono text-[11.5px] tabular-nums">
        <thead className="bg-bg-subtle">
          <tr>
            <Th sortKey="code" current={sortKey} dir={sortDir} onClick={onHeader}>Code</Th>
            <Th sortKey="name" current={sortKey} dir={sortDir} onClick={onHeader}>Name</Th>
            <Th sortKey="date" current={sortKey} dir={sortDir} onClick={onHeader}>Date</Th>
            <Th sortKey="captured_at" current={sortKey} dir={sortDir} onClick={onHeader}>Captured</Th>
            <Th sortKey="total_volume" current={sortKey} dir={sortDir} onClick={onHeader} right>Volume</Th>
            <Th sortKey="pages_collected" current={sortKey} dir={sortDir} onClick={onHeader} right>Pages</Th>
            <Th sortKey="file_size_bytes" current={sortKey} dir={sortDir} onClick={onHeader} right>Size</Th>
            <Th sortKey="today_close" current={sortKey} dir={sortDir} onClick={onHeader} right>OHLC</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={`${r.code}-${r.date}`}
              onClick={() => onRowClick(r)}
              className="border-b hover:bg-bg-input-hover cursor-pointer"
            >
              <td className="px-3 py-1.5 text-accent">{r.code}</td>
              <td className="px-3 py-1.5">{r.name}</td>
              <td className="px-3 py-1.5">{fmtDate(r.date)}</td>
              <td className="px-3 py-1.5 text-fg-dim">{fmtTime(r.captured_at)}</td>
              <td className="px-3 py-1.5 text-right">{r.total_volume.toLocaleString('ko-KR')}</td>
              <td className="px-3 py-1.5 text-right text-fg-dim">{r.pages_collected}</td>
              <td className="px-3 py-1.5 text-right text-fg-dim">{fmtSize(r.file_size_bytes)}</td>
              <td className="px-3 py-1.5 text-right">
                {fmtOHLC(r.today_open, r.today_close)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  sortKey,
  current,
  dir,
  onClick,
  right,
  children,
}: {
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
  right?: boolean;
  children: React.ReactNode;
}) {
  const active = current === sortKey;
  return (
    <th
      onClick={() => onClick(sortKey)}
      className={`px-3 py-2 border-b cursor-pointer select-none text-[10.5px] uppercase tracking-wider font-semibold text-fg-dimmer hover:text-fg ${
        right ? 'text-right' : 'text-left'
      } ${active ? 'text-fg' : ''}`}
    >
      {children}
      {active && <span className="ml-1">{dir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );
}

function fmtDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
}
function fmtSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtOHLC(o: number, c: number): string {
  const dir = c >= o ? '↑' : '↓';
  return `${c.toLocaleString('ko-KR')} ${dir}`;
}
