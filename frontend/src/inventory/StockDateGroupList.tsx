import { useState } from 'react';
import type { StockDate } from '../api/types';
import { useStockDateGroups } from './useStockDateGroups';
import { StockDateGroupListItem } from './StockDateGroupListItem';

type Props = {
  rows: StockDate[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
};

export function StockDateGroupList({ rows, selectedCode, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const groups = useStockDateGroups(rows, search);
  const allGroupsCount = new Set(rows.map(r => r.code)).size;
  const isSearching = search.trim().length > 0;

  return (
    <section
      data-testid="stock-date-group-list-root"
      className="flex h-full flex-col min-h-0 overflow-hidden"
    >
      {/* 검색 중에는 필터 결과가 헤더 카운트에 그대로 반영된다 — 별도의
          "N matches" 줄과 전체 카운트가 따로 놀던 이중 표기를 통합(2026-08-04). */}
      <header className="px-3 py-2 text-xs uppercase text-fg-dim font-semibold">
        {isSearching
          ? <>종목 {allGroupsCount}개 중 <span className="text-fg">{groups.length}개</span> 표시</>
          : <>종목 {allGroupsCount}개 · 캡처 {rows.length}건</>}
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
          <div className="px-3 py-4 text-fg-dim text-sm">검색 결과 없음</div>
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
