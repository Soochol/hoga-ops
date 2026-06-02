import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getWatchlist } from '../api/watchlist';
import { useJumpToLive } from '../live/useJumpToLive';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLivePageStore } from '../state/livePage';
import { useRemoveFromWatchlist, useReorderWatchlist } from './useWatchlist';
import { WatchlistRowMenu } from './WatchlistRowMenu';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableQuoteRow } from './SortableQuoteRow';
import { reorderCodes } from './reorderCodes';

/**
 * Read-only Watchlist Panel (CONTEXT.md), app-wide via the Right Rail (ADR-0052).
 * 각 행에 KIS 라이브 현재가+등락률 오버레이 (ADR-0056). 클릭 시 activeCode 세팅
 * + /live 점프.
 */
export function WatchlistDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const onPick = useJumpToLive();
  const { data, isLoading, error } = useQuery({
    queryKey: ['watchlist'],
    queryFn: getWatchlist,
    staleTime: 60_000,
  });

  const codes = useMemo(() => data?.entries.map((e) => e.code) ?? [], [data]);
  const quoteByCode = useQuoteByCode(codes);

  const removeM = useRemoveFromWatchlist();
  const reorderM = useReorderWatchlist();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const next = reorderCodes(codes, String(e.active.id), e.over ? String(e.over.id) : null);
    if (next) reorderM.mutate(next);
  };

  const [menu, setMenu] = useState<{ x: number; y: number; code: string; name: string } | null>(null);
  const openMenu = (e: React.MouseEvent, code: string, name: string) => {
    e.preventDefault();                                   // 네이티브 우클릭 메뉴 억제
    setMenu({ x: e.clientX, y: e.clientY, code, name });  // raw 좌표 — 클램프는 메뉴가 실측
  };
  const closeMenu = () => setMenu(null);

  return (
    <div
      id="right-rail-watchlist-panel"
      data-testid="watchlist-panel"
      style={{
        width: 'var(--watchlist-panel-w)',
        height: '100%',
        background: 'var(--bg-card)',
        borderLeft: '1px solid var(--border)',
        overflow: 'auto',
      }}
    >
      <div
        style={{
          padding: 'var(--space-sm) var(--space-md)',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-dim)',
          fontFamily: 'monospace',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        관심종목
      </div>
      {isLoading && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dimmer)', fontSize: 'var(--text-sm)' }}>
          불러오는 중
        </div>
      )}
      {error && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--error)', fontSize: 'var(--text-sm)' }}>
          관심종목을 불러올 수 없습니다
        </div>
      )}
      {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dimmer)', fontSize: 'var(--text-sm)' }}>
          관심종목이 없습니다
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={codes} strategy={verticalListSortingStrategy}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data?.entries.map((entry) => {
              const q = quoteByCode.get(entry.code);
              return (
                <SortableQuoteRow
                  key={entry.code}
                  code={entry.code}
                  name={entry.name}
                  price={q?.price ?? null}
                  pct={q?.change_pct ?? null}
                  changeWon={q?.change_won ?? null}
                  active={entry.code === activeCode}
                  ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
                  testId={`watchlist-row-${entry.code}`}
                  onClick={() => onPick(entry.code)}
                  onContextMenu={(e) => openMenu(e, entry.code, entry.name)}
                  onDelete={() => removeM.mutate(entry.code)}
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
      {menu && (
        <WatchlistRowMenu
          x={menu.x}
          y={menu.y}
          name={menu.name}
          onRemove={() => removeM.mutate(menu.code)}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
