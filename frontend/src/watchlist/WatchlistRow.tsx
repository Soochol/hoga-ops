import type { WatchlistEntry } from '../api/watchlist';

function fmtDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

export interface WatchlistRowProps {
  entry: WatchlistEntry;
  onRemove: (code: string) => void;
  removing: boolean;
  justAdded?: boolean;
}

export function WatchlistRow({ entry, onRemove, removing, justAdded }: WatchlistRowProps) {
  return (
    <div
      data-testid={`row-${entry.code}`}
      data-just-added={justAdded ? 'true' : undefined}
      className="grid grid-cols-[6ch_1fr_8ch_8ch_3ch] items-center gap-3 px-6 py-2 border-b border-border text-sm hover:bg-bg-input transition-colors"
      style={{
        background: justAdded ? 'var(--selection-tint)' : undefined,
        transition: 'background 800ms ease-out',
      }}
    >
      <span className="font-mono text-fg-dim">{entry.code}</span>
      <span className="truncate">{entry.name}</span>
      <span className="font-mono text-xs text-fg-dim">{fmtDate(entry.registered_at_kst_date)}</span>
      <span className="font-mono text-xs">
        {entry.last_success_date
          ? <span className="text-success">{fmtDate(entry.last_success_date)}</span>
          : <span className="text-fg-dimmer italic">아직 없음</span>}
      </span>
      <button
        type="button"
        aria-label={`Remove ${entry.name}`}
        onClick={() => onRemove(entry.code)}
        disabled={removing}
        className="text-fg-dimmer hover:text-error disabled:opacity-40"
      >
        🗑
      </button>
    </div>
  );
}
