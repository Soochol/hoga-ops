import { useMemo, useState } from 'react';
import type { StockDate } from '../api/types';
import { useStockDateGroups } from './useStockDateGroups';
import { StockDateGroupListItem } from './StockDateGroupListItem';
import { aggregateDiskState } from './DiskStateBadge';

type Props = {
  rows: StockDate[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
};

export function StockDateGroupList({ rows, selectedCode, onSelect }: Props) {
  const [search, setSearch] = useState('');
  // 문제만 보기: 집계 상태가 완결이 아닌 종목(부분/미완결/손상 포함)만 남긴다 —
  // 종전엔 결손 종목을 찾으려면 310개를 눈으로 훑는 수밖에 없었다.
  const [problemsOnly, setProblemsOnly] = useState(false);
  const searched = useStockDateGroups(rows, search);
  const groups = useMemo(
    () => (problemsOnly
      ? searched.filter((g) => aggregateDiskState(g.dates.map((d) => d.disk_state)) !== 'complete')
      : searched),
    [searched, problemsOnly],
  );
  const allGroupsCount = new Set(rows.map(r => r.code)).size;
  const isFiltering = search.trim().length > 0 || problemsOnly;

  return (
    <section
      data-testid="stock-date-group-list-root"
      className="flex h-full flex-col min-h-0 overflow-hidden"
    >
      {/* 검색·필터 중에는 결과가 헤더 카운트에 그대로 반영된다 — 별도의
          "N matches" 줄과 전체 카운트가 따로 놀던 이중 표기를 통합(2026-08-04). */}
      {/* 밑줄이 이 패널의 유일한 경계다 — pane 이 `borderless flat` 이라 테두리·그림자가
          전부 꺼져 있다(`/market` 의 `CARD_HEADER_RULE` 과 같은 선). */}
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs uppercase text-fg-dim font-semibold">
        <span className="min-w-0 flex-1 truncate">
          {isFiltering
            ? <>종목 {allGroupsCount}개 중 <span className="text-fg">{groups.length}개</span> 표시</>
            : <>종목 {allGroupsCount}개 · 캡처 {rows.length}건</>}
        </span>
        <button type="button" aria-pressed={problemsOnly}
          title="완결이 아닌 종목(부분·미완결·손상·차단)만 표시"
          onClick={() => setProblemsOnly((v) => !v)}
          className={`shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-semibold ${
            problemsOnly ? 'bg-tint-selection text-accent' : 'bg-bg-input text-fg-dim hover:text-fg'}`}>
          문제만
        </button>
      </header>
      <div className="p-2 sticky top-0 bg-bg-subtle z-10">
        <div className="relative">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="종목명 또는 코드…"
            className="bg-bg-input border rounded px-3 py-1.5 font-data text-sm text-fg w-full pr-7"
          />
          {search && (
            <button
              type="button"
              aria-label="검색 지우기"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg text-sm leading-none"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {groups.length === 0 ? (
          <div className="px-3 py-4 text-fg-dim text-sm">
            {problemsOnly && search.trim().length === 0 ? '문제 있는 종목이 없습니다' : '검색 결과 없음'}
          </div>
        ) : (
          groups.map((g) => (
            <StockDateGroupListItem
              key={g.code}
              group={g}
              active={g.code === selectedCode}
              onClick={onSelect}
            />
          ))
        )}
      </div>
    </section>
  );
}
