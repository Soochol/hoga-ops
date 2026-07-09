import { Fragment, useMemo, useState } from 'react';
import type { StockDateGroup } from './types';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume, fmtClock, fmtGapDuration } from './format';
import { DiskStateBadge, isRecapturable } from './DiskStateBadge';
import { sortDates, nextSortState, type SortKey, type SortState } from './sortDates';
import { useInventoryRecapture } from './useInventoryRecapture';
import { useInventoryUnblock } from './useInventoryUnblock';
import { useStockDateGaps } from './useStockDateGaps';
import { RecaptureActionBar } from './RecaptureActionBar';
import { useCaptureQueue } from '../capture/useCaptureQueue';
import { StatusBadge } from '../ui/StatusBadge';

/** Columns spanned by an expanded gap-detail row (matches the 9-col table). */
const TABLE_COLSPAN = 9;

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
  // WS1: which source_partial row has its gap-detail panel expanded. Only one
  // at a time — the lazy /gaps fetch is keyed by (code, date).
  const [expandedGapKey, setExpandedGapKey] = useState<string | null>(null);

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
      <section data-testid="stock-date-group-detail-root" className="p-md text-fg-dim">
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

  const handleRecaptureRow = async (date: string, forceRetry = false) => {
    const key = `${group.code}|${date}`;
    setPendingKey(key);
    try {
      await recapture(group.code, [date], forceRetry);
    } finally {
      setPendingKey(null);
    }
  };
  const handleRecaptureAll = () => recapture(group.code, recapturableDates);

  return (
    <section
      data-testid="stock-date-group-detail-root"
      className="flex h-full flex-col min-h-0 overflow-hidden"
    >
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
              // WS1: only source_partial (collection completed, gaps remain =
              // likely upstream-missing) offers the gap-detail panel.
              const hasGapPanel = r.disk_state === 'source_partial';
              const gapExpanded = expandedGapKey === rowKey;
              // ADR-0042 row tint: blocked rows pick up DESIGN.md error chip
              // bg (#F43F5E @ 10%) so the row itself signals "not normal".
              const trClass = r.blocked
                ? 'border-b bg-tint-error'
                : 'border-b';
              return (
                <Fragment key={`${r.code}-${r.date}`}>
                <tr className={trClass}>
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
                  <td className="px-3 py-1.5 text-center">
                    <span className="inline-flex items-center gap-1.5">
                      <DiskStateBadge state={r.disk_state} />
                      {hasGapPanel && (
                        <button
                          type="button"
                          aria-label={gapExpanded ? '결손 구간 접기' : '결손 구간 보기'}
                          aria-expanded={gapExpanded}
                          onClick={() => setExpandedGapKey(gapExpanded ? null : rowKey)}
                          className="text-badge text-[var(--warn)] underline hover:text-fg cursor-pointer bg-transparent border-none p-0"
                        >
                          결손
                        </button>
                      )}
                    </span>
                  </td>
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
                {hasGapPanel && gapExpanded && (
                  <tr className="border-b bg-bg-subtle">
                    <td colSpan={TABLE_COLSPAN} className="px-4 py-3">
                      <GapPanel
                        code={r.code}
                        date={r.date}
                        identicalCaptureCount={r.identical_capture_count ?? null}
                        isInFlight={inFlight}
                        onForceRecapture={() => handleRecaptureRow(r.date, true)}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GapPanel({
  code, date, identicalCaptureCount, isInFlight, onForceRecapture,
}: {
  code: string;
  date: string;
  identicalCaptureCount: number | null;
  isInFlight: boolean;
  onForceRecapture: () => void;
}) {
  // WS1: lazily fetch the gap boundaries only when this row is expanded.
  const { data, isLoading, isError } = useStockDateGaps(code, date, true);
  // ADR-0093: >= 2 completed captures with the identical result = confirmed
  // upstream gap. The worker now skips re-captures (upstream_gap); the only way
  // to re-verify is the force button below.
  const confirmed = (identicalCaptureCount ?? 0) >= 2;

  if (isLoading) {
    return <div className="text-xs text-fg-dim font-mono" data-testid="gap-panel-loading">결손 구간 조회 중…</div>;
  }
  if (isError || data === undefined) {
    return <div className="text-xs text-[var(--error)] font-mono">결손 구간을 불러오지 못했습니다</div>;
  }
  if (data.sparse) {
    return (
      <div className="text-xs text-fg-dim font-mono" data-testid="gap-panel-sparse">
        세션 내 데이터가 너무 적어 결손 구간을 특정할 수 없습니다.
      </div>
    );
  }
  if (data.gap_ranges.length === 0) {
    return (
      <div className="text-xs text-fg-dim font-mono" data-testid="gap-panel-empty">
        연속거래 구간에서 감지된 결손이 없습니다.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="gap-panel">
      <div className="text-xs font-semibold text-[var(--warn)]">
        업스트림 결손 {data.gap_ranges.length}구간
        {confirmed && (
          <span data-testid="gap-panel-confirmed" className="ml-2 text-fg-dim font-normal">
            · {identicalCaptureCount}회 재캡처 동일 결과 — 업스트림 결손 확정
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-0.5 font-mono text-xs tabular-nums text-fg">
        {data.gap_ranges.map((g) => (
          <li key={g.start_ms}>
            {fmtClock(g.start_ms)} ~ {fmtClock(g.end_ms)}
            <span className="text-fg-dim"> ({fmtGapDuration(g.start_ms, g.end_ms)})</span>
          </li>
        ))}
      </ul>
      <div className="text-xs text-fg-dim leading-snug">
        수집은 끝까지 완료됐으나 원본 아카이브에 이 구간 데이터가 없습니다.
        재캡처해도 복구되지 않을 수 있습니다.
      </div>
      {confirmed && (
        <div>
          <button
            type="button"
            data-testid="force-recapture-button"
            disabled={isInFlight}
            onClick={onForceRecapture}
            className={[
              'text-badge underline bg-transparent border-none p-0',
              isInFlight
                ? 'text-fg-dim cursor-not-allowed'
                : 'text-accent hover:text-fg cursor-pointer',
            ].join(' ')}
          >
            {isInFlight ? '강제 재캡처 중…' : '강제 재캡처 (확정 무시하고 재검증)'}
          </button>
        </div>
      )}
    </div>
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
