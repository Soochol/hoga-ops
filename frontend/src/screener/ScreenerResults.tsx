import type { OccurrenceExclusions } from './useOccurrenceExclusions';
import { useMemo, useState } from 'react';
import type { PanelScan } from '../state/screenerPanel';
import { EmptyState } from '../ui/DataSurface';
import { SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { ResultTable, type DepthSides } from './ResultTable';
import type { ScreenerRowLive } from './useScreenerRowsLive';
import { sortScreenerRows, type ScreenerResultSortMode } from './sortResults';
import { downloadResultsCsv } from './exportResults';
import type { JumpModifiers } from '../live/useJumpToLive';

/** 배지는 현재 편집 조건이 아닌 실행했던 조건을 따른다. 옛 기록은 추측하지 않는다. */
function depthSidesForScan(scan: PanelScan): DepthSides {
  let types: string[] = [];
  try {
    const request = JSON.parse(scan.requestJson ?? scan.scanKey ?? '{}');
    if (Array.isArray(request?.conditions)) {
      types = request.conditions.flatMap((c: { type?: unknown } | null) => typeof c?.type === 'string' ? [c.type] : []);
    }
  } catch { /* 이전 저장 상태에 요청이 없으면 검증 배지를 생략한다. */ }
  return {
    ask: types.some((t) => t === 'ask_depth_new_high' || t === 'ask_depth_new_high_period'),
    bid: types.some((t) => t === 'bid_depth_new_high' || t === 'bid_depth_new_high_period'),
    askRenewal: types.includes('ask_depth_renewal'), bidRenewal: types.includes('bid_depth_renewal'),
  };
}

/** 부모는 새 조회마다 key를 바꾼다. 검색/선택은 한 조회에만 속하며 시세 갱신과는 독립. */
export function ScreenerResults({ scan, liveRows, sortMode, onSortChange, onActivate, occurrenceController }: {
  scan: PanelScan;
  occurrenceController?: OccurrenceExclusions;
  liveRows: ScreenerRowLive[];
  sortMode: ScreenerResultSortMode;
  onSortChange: (mode: ScreenerResultSortMode) => void;
  onActivate: (code: string, name?: string, e?: JumpModifiers) => void;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'live' | 'snapshot'>('live');
  const [selectedCodes, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(() => new Set(scan.rows.filter(r => selectedCodes.has(r.code)).map(r => r.code)),
    [scan.rows, selectedCodes]);
  const snapshotRows = useMemo(() => scan.rows.map((r) => ({ ...r, change_won: null })), [scan.rows]);
  const sorted = useMemo(() => sortScreenerRows(mode === 'live' ? liveRows : snapshotRows, sortMode),
    [mode, liveRows, snapshotRows, sortMode]);
  const normalizedQuery = query.trim().toLocaleLowerCase().replaceAll(/\s+/g, '');
  const filtered = useMemo(() => sorted.filter((r) =>
    `${r.code}${r.name}`.toLocaleLowerCase().replaceAll(/\s+/g, '').includes(normalizedQuery)), [sorted, normalizedQuery]);
  const shownSelected = filtered.filter((r) => selected.has(r.code)).length;
  const allSelected = filtered.length > 0 && shownSelected === filtered.length;
  const toggle = (code: string) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const toggleAll = () => setSelected((old) => {
    const next = new Set(old);
    for (const row of filtered) {
      if (allSelected) next.delete(row.code); else next.add(row.code);
    }
    return next;
  });
  const depthSides = useMemo(() => depthSidesForScan(scan), [scan]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-sm pb-sm">
        <input type="search" aria-label="결과 내 종목 검색" placeholder="결과 내 종목명·코드 검색"
          value={query} onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 w-48 rounded-md border border-border bg-bg-input px-2 py-1 text-sm text-fg" />
        <span role="status" className="font-data text-xs text-fg-dim">
          표시 {filtered.length.toLocaleString('ko-KR')} / {scan.rows.length.toLocaleString('ko-KR')}건
          {scan.rows.some(r => r.occurrences !== undefined) && ` · 발생 ${filtered.reduce((n, r) => n + (r.occurrences?.length ?? 0), 0)}건`}
          {' · '}선택 {selected.size}건{selected.size > shownSelected && ` (숨김 ${selected.size - shownSelected}건 포함)`}
        </span>
        <span className="flex-1" />
        <SegmentedControl aria-label="결과 시세 보기">
          {(['live', 'snapshot'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}
              className={`px-3 py-sm text-sm ${mode === value ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}>
              {value === 'live' ? '현재 시세' : '조회 당시'}
            </button>
          ))}
        </SegmentedControl>
        <ToolbarButton type="button" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>선택 해제</ToolbarButton>
        <ToolbarButton type="button" disabled={selected.size === 0}
          onClick={() => downloadResultsCsv(scan, sorted.filter((r) => selected.has(r.code)).map((r) => r.code), liveRows)}>
          선택 CSV
        </ToolbarButton>
        <ToolbarButton type="button" disabled={filtered.length === 0}
          onClick={() => downloadResultsCsv(scan, filtered.map((r) => r.code), liveRows)}>검색 결과 CSV</ToolbarButton>
      </div>
      <p className="pb-sm text-xs text-fg-dim">
        {mode === 'live' ? '가격·등락률: 현재 시세(마지막 수신값)' : '가격·등락률: 조회 당시 값 · 날짜는 조회 가격의 기준일'}
        {' · '}거래대금: 조회 당시 추정치
        {' · '}CSV에는 조회 당시 값과 현재 시세를 함께 저장
      </p>
      {scan.rows.length > 0 && filtered.length === 0 ? (
        <EmptyState className="flex-1" title="검색어에 맞는 결과가 없습니다">
          받은 결과 안에서만 검색합니다
          <ToolbarButton type="button" onClick={() => setQuery('')}>검색어 지우기</ToolbarButton>
        </EmptyState>
      ) : (
        <ResultTable rows={filtered} onActivate={onActivate} sortMode={sortMode} onSortChange={onSortChange}
          occurrenceController={occurrenceController}
          embedded depthValues={scan.depthValues} depthSides={depthSides} quoteMode={mode}
          selection={{ codes: selected, allSelected, someSelected: shownSelected > 0, onToggle: toggle, onToggleAll: toggleAll }} />
      )}
    </>
  );
}
