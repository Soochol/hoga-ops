import { Fragment, useMemo, useState } from 'react';
import type { StockDateGroup } from './types';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume, fmtClock, fmtGapDuration } from './format';
import { DiskStateBadge, VenueStateCell, isRecapturable } from './DiskStateBadge';
import { sortDates, nextSortState, type SortKey, type SortState } from './sortDates';
import { useInventoryRecapture } from './useInventoryRecapture';
import { useInventoryUnblock } from './useInventoryUnblock';
import { useStockDateGaps } from './useStockDateGaps';
import { RecaptureActionBar } from './RecaptureActionBar';
import { useCaptureQueue } from '../capture/useCaptureQueue';
import { StatusBadge } from '../ui/StatusBadge';

/** Columns spanned by an expanded gap-detail row (matches the 9-col table). */
const TABLE_COLSPAN = 10;  // venue 열 추가(ADR-0140 §7)

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
      {/* 밑줄이 이 패널의 **유일한 경계다** — pane 이 `PanelCard borderless flat` 이라
          테두리·그림자·톤 스텝이 전부 꺼져 있고, 좌측 리스트와 갈라 주는 건 gap 뿐이었다.
          `/market` 이 같은 문제에 낸 답(`CARD_HEADER_RULE`)과 같은 선이다. */}
      <header className="flex items-baseline justify-between gap-4 border-b border-border px-4 py-3">
        <h2 className="text-md font-semibold shrink-0">
          <span className="text-accent font-data">{group.code}</span>{' '}
          <span className="text-fg">{group.name}</span>
        </h2>
        {/* 메타와 재캡처 버튼을 한 줄로 — 세로로 쌓으면 헤더가 2행이 되어 표가 그만큼
            밀린다. 좁은 pane 에서는 wrap 이 받아낸다. */}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-md gap-y-2xs">
          <span className="text-xs text-fg-dim font-data tabular-nums">
            {group.dates.length}일치 · 거래량 {fmtVolume(totalVolume)} · {fmtSize(group.totalSizeBytes)}
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
        <table className="w-full border-collapse font-data text-sm tabular-nums">
          <thead className="bg-bg-subtle sticky top-0">
            <tr>
              {/* 헤더는 한국어(Copy tone — 사용자 문구), OHLC 만 도메인 식별자로 영어 유지.
                  /screener 결과 표(코드·종목명·시장…)와 같은 규칙. */}
              <th className="px-2 py-2 border-b w-8" aria-label="재캡처" />
              <SortableTh column="state"    sort={sort} onSort={onSort}>상태</SortableTh>
              <SortableTh column="failStreak" sort={sort} onSort={onSort} title="연속 실패 횟수 — 5회 시 차단">재시도</SortableTh>
              {/* 정렬 불가 — venue 상태는 여러 값의 묶음이라 한 축으로 못 세운다.
                  행 정렬은 hogaplay 주 상태(`state`)가 계속 담당한다. */}
              <th className="px-3 py-2 border-b text-left font-normal text-fg-dim" title="kiwoom_live 시장별 상태 — 자리가 없으면 그 시장에 미상장">시장</th>
              <SortableTh column="date"     sort={sort} onSort={onSort}>날짜</SortableTh>
              <SortableTh column="captured" sort={sort} onSort={onSort}>수집 시각</SortableTh>
              <SortableTh column="volume"   sort={sort} onSort={onSort} right>거래량</SortableTh>
              <SortableTh column="pages"    sort={sort} onSort={onSort} right>페이지</SortableTh>
              <SortableTh column="size"     sort={sort} onSort={onSort} right>크기</SortableTh>
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
              // 서버 판정. 종전엔 GapPanel 이 identical_capture_count >= 2 로
              // 자체 계산했는데 그건 확정 경로 셋 중 하나뿐이라, 세션 경계·보유
              // 창 만료로 확정된 행은 "확정" 문구도 강제 재캡처 버튼도 못 받았다
              // — 워커는 이미 그 행들을 건너뛰고 있었는데도.
              const gapConfirmed = r.upstream_gap_confirmed === true;
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
                      <DiskStateBadge
                        state={r.disk_state}
                        upstreamGapConfirmed={r.upstream_gap_confirmed}
                      />
                      {hasGapPanel && (
                        <button
                          type="button"
                          aria-label={gapExpanded ? '결손 구간 접기' : '결손 구간 보기'}
                          aria-expanded={gapExpanded}
                          onClick={() => setExpandedGapKey(gapExpanded ? null : rowKey)}
                          // 확정 행은 배지와 같은 톤으로 가라앉힌다 — ⊘ 옆에 amber
                          // "결손" 이 남으면 배지만 바꾼 의미가 반감된다.
                          className={[
                            'text-badge underline hover:text-fg cursor-pointer bg-transparent border-none p-0',
                            gapConfirmed ? 'text-fg-dim' : 'text-warn',
                          ].join(' ')}
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
                  <td className="px-3 py-1.5"><VenueStateCell venues={r.venues} /></td>
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
                        confirmed={gapConfirmed}
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
  code, date, identicalCaptureCount, confirmed, isInFlight, onForceRecapture,
}: {
  code: string;
  date: string;
  identicalCaptureCount: number | null;
  /** 서버 판정(`upstream_gap_confirmed`). 여기서 다시 계산하지 않는다 — 종전의
   *  `identical_capture_count >= 2` 는 확정 경로 셋 중 ADR-0093 하나뿐이었다. */
  confirmed: boolean;
  isInFlight: boolean;
  onForceRecapture: () => void;
}) {
  // WS1: lazily fetch the gap boundaries only when this row is expanded.
  const { data, isLoading, isError } = useStockDateGaps(code, date, true);
  // 확정 사유를 아는 경우에만 근거를 덧붙인다. ADR-0126(세션 경계)·ADR-0131
  // (보유 창 만료)로 확정된 행은 카운터가 1 이하라 "N회 동일" 이 성립하지 않는다.
  const identicalReason = (identicalCaptureCount ?? 0) >= 2;

  if (isLoading) {
    return <div className="text-xs text-fg-dim font-data" data-testid="gap-panel-loading">결손 구간 조회 중…</div>;
  }
  if (isError || data === undefined) {
    return <div className="text-xs text-error font-data">결손 구간을 불러오지 못했습니다</div>;
  }
  if (data.sparse) {
    return (
      <div className="text-xs text-fg-dim font-data" data-testid="gap-panel-sparse">
        세션 내 데이터가 너무 적어 결손 구간을 특정할 수 없습니다
      </div>
    );
  }
  if (data.gap_ranges.length === 0) {
    return (
      <div className="text-xs text-fg-dim font-data" data-testid="gap-panel-empty">
        연속거래 구간에서 감지된 결손이 없습니다
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="gap-panel">
      <div className={`text-xs font-semibold ${confirmed ? 'text-fg-dim' : 'text-warn'}`}>
        업스트림 결손 {data.gap_ranges.length}구간
        {confirmed && (
          <span data-testid="gap-panel-confirmed" className="ml-2 text-fg-dim font-normal">
            · {identicalReason
              ? `${identicalCaptureCount}회 재캡처 동일 결과 — 업스트림 결손 확정`
              : '업스트림 결손 확정 — 재캡처가 이 구간을 채울 수 없습니다'}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-0.5 font-data text-xs tabular-nums text-fg">
        {data.gap_ranges.map((g) => (
          <li key={g.start_ms}>
            {fmtClock(g.start_ms)} ~ {fmtClock(g.end_ms)}
            <span className="text-fg-dim"> ({fmtGapDuration(g.start_ms, g.end_ms)})</span>
          </li>
        ))}
      </ul>
      <div className="text-xs text-fg-dim leading-snug">
        수집은 끝까지 완료됐으나 원본 아카이브에 이 구간 데이터가 없습니다.
        {confirmed
          ? ' 재캡처해도 동일한 결과가 나옵니다 — 자동 재캡처는 건너뜁니다'
          : ' 재캡처해도 복구되지 않을 수 있습니다'}
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
      aria-label={isInFlight ? '재캡처 중…' : '이 날짜 재캡처'}
      disabled={isInFlight}
      onClick={onClick}
      className={[
        // p-1 -m-1: 히트 영역만 키우고 레이아웃은 불변(터치 타깃 확대).
        'bg-transparent border-none p-1 -m-1 text-sm',
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
      aria-label="잠금 해제 (연속 실패 카운터 초기화)"
      disabled={isPending}
      onClick={onClick}
      className={[
        'bg-transparent border-none p-1 -m-1 text-badge underline',
        isPending
          ? 'text-fg-dim cursor-not-allowed'
          : 'text-error hover:text-fg cursor-pointer',
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
  // 비활성 인디케이터(↕)는 상시 표시 — /screener 결과 표와 같은 문법. 종전의
  // hover 전용 노출(opacity-0 group-hover)은 터치·키보드 사용자가 정렬 가능
  // 여부 자체를 알 수 없었다. 라벨도 활성 컨트롤이므로 fg-dim 이 바닥이다.
  const indicator = dir === 'desc' ? '▼' : dir === 'asc' ? '▲' : '↕';
  const indicatorClass = active ? 'text-accent' : 'opacity-40';
  const labelClass = active ? 'text-fg' : 'text-fg-dim hover:text-fg';

  return (
    <th
      aria-sort={ariaSort}
      className={`px-3 py-2 border-b text-xs uppercase font-semibold ${
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
        <span className={`font-data ${indicatorClass}`} aria-hidden="true">
          {indicator}
        </span>
      </button>
    </th>
  );
}
