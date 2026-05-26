import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { StockDate } from '../api/types';
import { useTabsStore } from '../state/tabs';
import { useStockDateGroups } from './useStockDateGroups';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';
import { DiskStateBadge, isRecapturable } from './DiskStateBadge';
import { sortDates, nextSortState, type SortKey, type SortState } from './sortDates';
import { useInventoryRecapture } from './useInventoryRecapture';
import { RecaptureActionBar } from './RecaptureActionBar';
import { useCaptureQueue } from '../capture/useCaptureQueue';

type Props = {
  rows: StockDate[];
  selectedCode: string | null;
};

export function StockDateGroupDetail({ rows, selectedCode }: Props) {
  const navigate = useNavigate();
  const groups = useStockDateGroups(rows, '');
  const group = useMemo(() => {
    if (selectedCode === null) return null;
    return groups.find((g) => g.code === selectedCode) ?? groups[0] ?? null;
  }, [groups, selectedCode]);

  const [sort, setSort] = useState<SortState>(null);
  const sortedDates = useMemo(
    () => (group ? sortDates(group.dates, sort) : []),
    [group, sort],
  );

  const { recapture, status, isPending } = useInventoryRecapture();
  const { queue } = useCaptureQueue();

  // In-flight set: any (code, date) currently in queue.active ∪ queue.queued.
  // SSE updates from capture_queued / capture_progress / capture_finished
  // invalidate the queue cache (see useCaptureQueue), so this Set tracks live.
  const inFlightSet = useMemo(() => {
    const s = new Set<string>();
    if (!queue) return s;
    for (const i of queue.active) s.add(`${i.code}|${i.date}`);
    for (const i of queue.queued) s.add(`${i.code}|${i.date}`);
    return s;
  }, [queue]);

  if (group === null) {
    return (
      <section className="bg-bg-card border rounded-lg p-md text-fg-dim">
        종목을 선택하세요
      </section>
    );
  }

  const totalVolume = group.dates.reduce((s, d) => s + d.total_volume, 0);
  const recapturableDates = sortedDates.filter((r) => isRecapturable(r.disk_state)).map((r) => r.date);
  const recapturableCount = recapturableDates.length;

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

  const onSort = (column: SortKey) => setSort((prev) => nextSortState(prev, column));

  const handleRecaptureRow = (date: string) => recapture(group.code, [date]);
  const handleRecaptureAll = () => recapture(group.code, recapturableDates);

  return (
    <section className="bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-hidden">
      <header className="px-4 py-3 border-b flex items-baseline justify-between gap-4">
        <h2 className="text-md font-semibold shrink-0">
          <span className="text-accent font-mono">{group.code}</span>{' '}
          <span className="text-fg">{group.name}</span>
        </h2>
        <div className="flex flex-col items-end gap-1 min-w-0">
          <span className="text-xs text-fg-dim font-mono tabular-nums">
            {group.dates.length} dates · {fmtVolume(totalVolume)} vol · {fmtSize(group.totalSizeBytes)}
          </span>
          <RecaptureActionBar
            recapturableCount={recapturableCount}
            onRecaptureAll={handleRecaptureAll}
            status={status}
            isPending={isPending}
          />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse font-mono text-sm tabular-nums">
          <thead className="bg-bg-subtle sticky top-0">
            <tr>
              <th className="px-2 py-2 border-b w-8" aria-label="re-capture" />
              <SortableTh column="state"    sort={sort} onSort={onSort}>State</SortableTh>
              <SortableTh column="date"     sort={sort} onSort={onSort}>Date</SortableTh>
              <SortableTh column="captured" sort={sort} onSort={onSort}>Captured</SortableTh>
              <SortableTh column="volume"   sort={sort} onSort={onSort} right>Volume</SortableTh>
              <SortableTh column="pages"    sort={sort} onSort={onSort} right>Pages</SortableTh>
              <SortableTh column="size"     sort={sort} onSort={onSort} right>Size</SortableTh>
              <SortableTh column="ohlc"     sort={sort} onSort={onSort} right title="종가 기준 정렬">OHLC</SortableTh>
            </tr>
          </thead>
          <tbody>
            {sortedDates.map((r) => {
              const recap = isRecapturable(r.disk_state);
              const inFlight = inFlightSet.has(`${r.code}|${r.date}`);
              return (
                <tr
                  key={`${r.code}-${r.date}`}
                  onClick={() => onRowClick(r)}
                  className="border-b hover:bg-bg-input-hover cursor-pointer"
                >
                  <td
                    className="px-2 py-1.5 text-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {recap ? (
                      <RowRecaptureButton
                        isInFlight={inFlight}
                        onClick={() => handleRecaptureRow(r.date)}
                      />
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-center"><DiskStateBadge state={r.disk_state} /></td>
                  <td className="px-3 py-1.5">{fmtDate(r.date)}</td>
                  <td className="px-3 py-1.5 text-fg-dim">{fmtTime(r.captured_at)}</td>
                  <td className="px-3 py-1.5 text-right">{r.total_volume.toLocaleString('ko-KR')}</td>
                  <td className="px-3 py-1.5 text-right text-fg-dim">{r.pages_collected}</td>
                  <td className="px-3 py-1.5 text-right text-fg-dim">{fmtSize(r.file_size_bytes)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtOHLC(r.today_open, r.today_close)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RowRecaptureButton({
  isInFlight,
  onClick,
}: {
  isInFlight: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={isInFlight ? 'Re-capturing…' : 'Re-capture this Stock-Date'}
      disabled={isInFlight}
      onClick={onClick}
      className={[
        'bg-transparent border-none p-0 text-sm',
        isInFlight
          ? 'text-fg-dim animate-spin cursor-not-allowed'
          : 'text-accent hover:text-fg cursor-pointer',
      ].join(' ')}
    >
      ↻
    </button>
  );
}

type SortableThProps = {
  column: SortKey;
  sort: SortState;
  onSort: (column: SortKey) => void;
  right?: boolean;
  title?: string;
  children: React.ReactNode;
};

function SortableTh({ column, sort, onSort, right, title, children }: SortableThProps) {
  const active = sort?.key === column;
  const dir = active ? sort.dir : null;
  const ariaSort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  const indicator = dir === 'desc' ? '▼' : dir === 'asc' ? '▲' : '▾';
  const indicatorClass = active ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-30';
  const labelClass = active ? 'text-fg' : 'text-fg-dimmer';

  return (
    <th
      aria-sort={ariaSort}
      className={`px-3 py-2 border-b text-xs uppercase tracking-wider font-semibold ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      <button
        type="button"
        title={title}
        onClick={() => onSort(column)}
        className={`group inline-flex items-center gap-1 select-none ${labelClass} ${
          right ? 'flex-row-reverse' : 'flex-row'
        }`}
      >
        <span>{children}</span>
        <span className={`font-mono ${indicatorClass}`} aria-hidden="true">
          {indicator}
        </span>
      </button>
    </th>
  );
}
