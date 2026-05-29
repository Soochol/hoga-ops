import { useQuery } from '@tanstack/react-query';
import { getWatchlist, type WatchlistEntry } from '../api/watchlist';
import { useLivePageStore } from '../state/livePage';

/**
 * Right-most column of /live, toggled by the ⭐ button in LiveHeader.
 *
 * Lists watchlist entries; clicking sets `activeCode` in the live page
 * store. Stage 11-α.3 keeps this simple: no search, no sort options yet.
 * Add (Suggestion S2) is a future polish.
 */
export function WatchlistPanel() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const { data, isLoading, error } = useQuery({
    queryKey: ['watchlist'],
    queryFn: getWatchlist,
    staleTime: 60_000,
  });

  return (
    <div
      id="live-watchlist-panel"
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
            onClick={() => setActiveCode(entry.code)}
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
      <span style={{ color: active ? 'var(--accent)' : 'var(--fg)', fontSize: 'var(--text-sm)' }}>
        {entry.name}
      </span>
    </li>
  );
}
