import { useMemo, useState } from 'react';
import type { StockDateGroup } from './types';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';
import { DiskStateBadge, isRecapturable } from './DiskStateBadge';
import { sortDates, nextSortState, type SortKey, type SortState } from './sortDates';
import { useInventoryRecapture } from './useInventoryRecapture';
import { useInventoryUnblock } from './useInventoryUnblock';
import { RecaptureActionBar } from './RecaptureActionBar';
import { useCaptureQueue } from '../capture/useCaptureQueue';
import { StatusBadge } from '../ui/StatusBadge';

type Props = {
  group: StockDateGroup | null;
};

export function StockDateGroupDetail({ group }: Props) {
  const [sort, setSort] = useState<SortState>(null);
  const sortedDates = useMemo(
    () => (group ? sortDates(group.dates, sort) : []),
    [group, sort],
  );

  const { recapture, status, isPending } = useInventoryRecapture();
  // ADR-0042: unblock action lives at component top per React Rules of Hooks.
  // It's used inside the blocked-row branch below; hoisting it here keeps the
  // hook call order stable when rows flip between blocked and unblocked.
  const { unblock } = useInventoryUnblock();
  const { queue } = useCaptureQueue();
  // Optimistic guard: the queue snapshot only catches up after the POST
  // response + SSE round-trip. Between click and snapshot refresh, the
  // user can rapid-double-click the same row's ↻ and fire two POSTs. Track
  // the (code,date) of an in-flight submit locally to disable that row immediately.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

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
  // Derive from group.dates (stable date-desc) rather than sortedDates so the
  // POST body's dates[] is deterministic regardless of the user's current sort
  // column. Backend correctness doesn't care; request logs + snapshot tests do.
  const recapturableDates = group.dates
    .filter((r) => isRecapturable(r.disk_state))
    .map((r) => r.date);
  const recapturableCount = recapturableDates.length;

  const onSort = (column: SortKey) => setSort((prev) => nextSortState(prev, column));

  const handleRecaptureRow = async (date: string) => {
    const key = `${group.code}|${date}`;
    setPendingKey(key);
    try {
      await recapture(group.code, [date]);
    } finally {
      setPendingKey(null);
    }
  };
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
              <SortableTh column="failStreak" sort={sort} onSort={onSort} title="연속 실패 횟수 — 5회 시 차단">재시도</SortableTh>
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
              const rowKey = `${r.code}|${r.date}`;
              const inFlight = inFlightSet.has(rowKey) || pendingKey === rowKey;
              // ADR-0042 row tint: blocked rows pick up DESIGN.md error chip
              // bg (#F43F5E @ 10%) so the row itself signals "not normal".
              const trClass = r.blocked
                ? 'border-b bg-tint-error'
                : 'border-b';
              return (
                <tr
                  key={`${r.code}-${r.date}`}
                  className={trClass}
                >
                  <td
                    className="px-2 py-1.5 text-center"
                  >
                    {r.blocked ? (
                      <UnblockCell
                        onClick={() => unblock.mutate({ code: r.code, date: r.date })}
                        isPending={unblock.isPending}
                      />
                    ) : recap ? (
                      <RowRecaptureCell
                        isInFlight={inFlight}
                        onClick={() => handleRecaptureRow(r.date)}
                      />
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-center"><DiskStateBadge state={r.disk_state} /></td>
                  <td
                    data-testid="fail-streak-cell"
                    className="px-3 py-1.5 text-center"
                  >
                    <FailStreakCell failStreak={r.fail_streak} blocked={r.blocked} />
                  </td>
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

function FailStreakCell({ failStreak, blocked }: { failStreak: number; blocked: boolean }) {
  // ADR-0042: per-(Code, Stock-Date) consecutive-failure surfacing, relocated
  // from the ↻ action cell into its own sortable 재시도 column. Renders the
  // shared StatusBadge so the warn/error pill shape stays in lockstep with the
  // capture-queue and full-capture badges.
  if (blocked) {
    // Visible text is just "차단됨" — the column header "재시도" supplies the
    // context, and aria-label / red row-tint / 잠금 해제 button carry the rest.
    return (
      <StatusBadge tone="error" ariaLabel="5회 연속 실패로 차단됨 — 잠금 해제 필요">
        차단됨
      </StatusBadge>
    );
  }
  if (failStreak > 0) {
    // "N/5" under the 재시도 column — no redundant "재시도" prefix in the cell.
    return (
      <StatusBadge
        tone="warn"
        ariaLabel={`재시도 ${failStreak}/5 — ${5 - failStreak}회 더 실패하면 차단됩니다`}
      >
        {failStreak}/5
      </StatusBadge>
    );
  }
  // fail_streak === 0 (정상): 최근 실패 없음 — 조용한 placeholder.
  return <span className="text-fg-dimmer">—</span>;
}

function RowRecaptureCell({
  isInFlight,
  onClick,
}: {
  isInFlight: boolean;
  onClick: () => void;
}) {
  // ADR-0042: the "재시도 N/5" status moved to its own 재시도 column
  // (see FailStreakCell); this cell is now just the ↻ Re-capture action.
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

function UnblockCell({ onClick, isPending }: { onClick: () => void; isPending: boolean }) {
  // ADR-0042 blocked row: the blocked status (차단됨) moved to the 재시도 column
  // (see FailStreakCell); this cell keeps just the 잠금 해제 action that resets
  // the fail_streak counter. Button uses --error (DESIGN.md L82-100
  // status-semantic for system feedback — capture failed/blocked).
  return (
    <button
      type="button"
      aria-label="잠금 해제 (fail_streak 카운터 0으로 초기화)"
      disabled={isPending}
      onClick={onClick}
      className={[
        'bg-transparent border-none p-0 text-badge underline',
        isPending
          ? 'text-fg-dim cursor-not-allowed'
          : 'text-[var(--error)] hover:text-fg cursor-pointer',
      ].join(' ')}
    >
      잠금 해제
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
