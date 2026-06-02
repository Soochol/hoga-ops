import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getWatchlist } from '../api/watchlist';
import { useJumpToLive } from '../live/useJumpToLive';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLivePageStore } from '../state/livePage';
import { QuoteRow } from '../rightrail/QuoteRow';
import { useRemoveFromWatchlist } from './useWatchlist';
import { TrashIcon } from '../ui/TrashIcon';

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
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {data?.entries.map((entry) => {
          const q = quoteByCode.get(entry.code);
          return (
            <QuoteRow
              key={entry.code}
              name={entry.name}
              price={q?.price ?? null}
              pct={q?.change_pct ?? null}
              changeWon={q?.change_won ?? null}
              active={entry.code === activeCode}
              ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
              testId={`watchlist-row-${entry.code}`}
              onClick={() => onPick(entry.code)}
              trailingAction={
                <button
                  type="button"
                  aria-label={`${entry.name} 관심종목 해제`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); removeM.mutate(entry.code); }}
                  className="leading-none text-fg-dimmer opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-error focus-visible:text-error transition-[opacity,color] duration-[80ms]"
                >
                  <TrashIcon className="w-[1em] h-[1em]" />
                </button>
              }
            />
          );
        })}
      </ul>
    </div>
  );
}
