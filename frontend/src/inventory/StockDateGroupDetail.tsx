import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { StockDate } from '../api/types';
import { useTabsStore } from '../state/tabs';
import { useStockDateGroups } from './useStockDateGroups';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';
import { DiskStateBadge } from './DiskStateBadge';

type Props = {
  rows: StockDate[];
  selectedCode: string | null;
};

export function StockDateGroupDetail({ rows, selectedCode }: Props) {
  const navigate = useNavigate();
  const groups = useStockDateGroups(rows, '');
  const group = useMemo(() => {
    if (selectedCode === null) return null;
    return groups.find(g => g.code === selectedCode) ?? groups[0] ?? null;
  }, [groups, selectedCode]);

  if (group === null) {
    return (
      <section className="bg-bg-card border rounded-lg p-md text-fg-dim">
        종목을 선택하세요
      </section>
    );
  }

  const totalVolume = group.dates.reduce((s, d) => s + d.total_volume, 0);

  const onRowClick = (r: StockDate) => {
    const tabId = useTabsStore.getState().newTab();
    useTabsStore.getState().setSelection(tabId, {
      code: r.code,
      fromDate: r.date,
      toDate: r.date,
      timeframe: '1m',
    });
    navigate('/replay');
  };

  return (
    <section className="bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-hidden">
      <header className="px-4 py-3 border-b flex items-baseline justify-between">
        <h2 className="text-md font-semibold">
          <span className="text-accent font-mono">{group.code}</span>{' '}
          <span className="text-fg">{group.name}</span>
        </h2>
        <span className="text-xs text-fg-dim font-mono tabular-nums">
          {group.dates.length} dates · {fmtVolume(totalVolume)} vol · {fmtSize(group.totalSizeBytes)}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse font-mono text-sm tabular-nums">
          <thead className="bg-bg-subtle sticky top-0">
            <tr>
              <Th>State</Th>
              <Th>Date</Th>
              <Th>Captured</Th>
              <Th right>Volume</Th>
              <Th right>Pages</Th>
              <Th right>Size</Th>
              <Th right>OHLC</Th>
            </tr>
          </thead>
          <tbody>
            {group.dates.map((r) => (
              <tr
                key={`${r.code}-${r.date}`}
                onClick={() => onRowClick(r)}
                className="border-b hover:bg-bg-input-hover cursor-pointer"
              >
                <td className="px-3 py-1.5 text-center"><DiskStateBadge state={r.disk_state} /></td>
                <td className="px-3 py-1.5">{fmtDate(r.date)}</td>
                <td className="px-3 py-1.5 text-fg-dim">{fmtTime(r.captured_at)}</td>
                <td className="px-3 py-1.5 text-right">{r.total_volume.toLocaleString('ko-KR')}</td>
                <td className="px-3 py-1.5 text-right text-fg-dim">{r.pages_collected}</td>
                <td className="px-3 py-1.5 text-right text-fg-dim">{fmtSize(r.file_size_bytes)}</td>
                <td className="px-3 py-1.5 text-right">{fmtOHLC(r.today_open, r.today_close)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`px-3 py-2 border-b text-xs uppercase tracking-wider font-semibold text-fg-dimmer ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
