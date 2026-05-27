import { LiveEmptyState } from './LiveEmptyState';

interface Props {
  activeCode: string | null;
  watchlistEmpty: boolean;
}

export function LiveWorkarea({ activeCode, watchlistEmpty }: Props) {
  if (watchlistEmpty) {
    return (
      <div data-testid="live-workarea" className="h-full">
        <LiveEmptyState cause="watchlist_empty" />
      </div>
    );
  }
  if (!activeCode) {
    return (
      <div data-testid="live-workarea" className="h-full">
        <LiveEmptyState cause="no_active_code" />
      </div>
    );
  }
  return (
    <div
      data-testid="live-workarea"
      className="grid h-full"
      style={{ gridTemplateColumns: '1fr var(--sidebar-w)', background: 'var(--bg)' }}
    >
      <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dim)' }}>
        <div>캔들 차트 영역 (Stage 9-γ)</div>
        <div>호가 지표 차트 영역 (Stage 9-γ)</div>
      </div>
      <div
        style={{
          borderLeft: '1px solid var(--border)',
          padding: 'var(--space-md)',
          color: 'var(--fg-dim)',
        }}
      >
        Live Sidebar (Stage 11)
      </div>
    </div>
  );
}
