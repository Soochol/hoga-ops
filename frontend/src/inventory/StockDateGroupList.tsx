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
    <section className="bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-hidden">
      <header className="px-3 py-2 border-b text-xs uppercase tracking-wider text-fg-dimmer font-semibold">
        종목 {allGroupsCount}개 · 캡처 {rows.length}건
      </header>
      <div className="p-2 border-b sticky top-0 bg-bg-card z-10">
        <div className="relative">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="종목명 또는 코드…"
            className="bg-bg-input border rounded px-3 py-1.5 font-mono text-sm text-fg w-full pr-7"
          />
          {search && (
            <button
              type="button"
              aria-label="clear search"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dimmer hover:text-fg text-sm leading-none"
            >
              ×
            </button>
          )}
        </div>
        {isSearching && (
          <div className="text-xs text-fg-dimmer mt-1 font-mono">{groups.length} matches</div>
        )}
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
