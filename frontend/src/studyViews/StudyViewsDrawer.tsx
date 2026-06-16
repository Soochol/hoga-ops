import { useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useStudyViews } from './useStudyViews';

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export function filterStudyViews<T extends { name: string; code: string; memo: string }>(rows: T[], query: string): T[] {
  const q = normalize(query);
  if (!q) return rows;
  return rows.filter((row) => [row.name, row.code, row.memo].some((v) => normalize(v).includes(q)));
}

export function StudyViewsDrawer() {
  const { data, isLoading, isError, refetch } = useStudyViews();
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const rows = useMemo(() => filterStudyViews(data?.saves ?? [], query), [data?.saves, query]);
  const canSave = location.pathname === '/live' || location.pathname === '/study';

  return (
    <aside id="right-rail-saved-views-panel" className="h-full min-w-0 overflow-hidden border-l bg-bg">
      <div className="h-full flex flex-col">
        <header className="px-3 py-2 border-b flex items-center justify-between">
          <h2 className="text-sm font-semibold">저장 뷰</h2>
          <button type="button" disabled={!canSave} className="text-xs px-2 py-1 border rounded">
            {location.pathname === '/study' ? '덮어쓰기' : '현재 뷰 저장'}
          </button>
        </header>
        <div className="p-3 border-b">
          <input
            aria-label="저장 뷰 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-bg-input border rounded px-2 py-1 text-sm"
          />
          {!canSave && <p className="mt-2 text-xs text-fg-dim">차트 화면에서 저장할 수 있습니다.</p>}
        </div>
        {isLoading && <div className="p-3 text-sm text-fg-dim">불러오는 중</div>}
        {isError && (
          <div className="p-3 text-sm">
            <p>저장 뷰를 불러오지 못했습니다.</p>
            <button type="button" onClick={() => refetch()} className="mt-2 underline">다시 시도</button>
          </div>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) === 0 && (
          <div className="p-3 text-sm text-fg-dim">저장된 뷰가 없습니다.</div>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) > 0 && rows.length === 0 && (
          <div className="p-3 text-sm text-fg-dim">검색 결과가 없습니다.</div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => navigate(`/study?view=${row.id}`)}
              className="w-full text-left px-3 py-2 border-b hover:bg-bg-input-hover"
            >
              <div className="text-sm font-medium truncate">{row.name}</div>
              <div className="text-xs text-fg-dim truncate">{row.label} {row.code} · {row.timeframe}</div>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
