import { useQuery } from '@tanstack/react-query';
import { useNavigate, useLocation } from 'react-router';
import { getWatchlist, type WatchlistEntry } from '../api/watchlist';
import { useLivePageStore } from '../state/livePage';

/**
 * Read-only Watchlist Panel (CONTEXT.md), surfaced app-wide via the Right Rail
 * (ADR-0052). Promoted from the former /live-only drawer. Clicking a row sets
 * `activeCode` and jumps to /live (when not already there).
 */
export function WatchlistDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data, isLoading, error } = useQuery({
    queryKey: ['watchlist'],
    queryFn: getWatchlist,
    staleTime: 60_000,
  });

  const onPick = (code: string) => {
    setActiveCode(code);
    if (pathname !== '/live') navigate('/live');
  };

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
        {data?.entries.map((entry) => (
          <WatchlistRow
            key={entry.code}
            entry={entry}
            active={entry.code === activeCode}
            onClick={() => onPick(entry.code)}
          />
        ))}
      </ul>
    </div>
  );
}

function WatchlistRow({
  entry,
  active,
  onClick,
}: {
  entry: WatchlistEntry;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li
      data-testid={`watchlist-row-${entry.code}`}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: 'var(--space-sm) var(--space-md)',
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2xs)',
      }}
    >
      <span style={{ fontFamily: 'monospace', color: 'var(--fg-dim)', fontSize: 'var(--text-xs)' }}>
        {entry.code}
      </span>
      <span style={{ color: 'var(--fg)', fontSize: 'var(--text-sm)' }}>
        {entry.name}
      </span>
    </li>
  );
}
