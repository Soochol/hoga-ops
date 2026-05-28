import { LIVE_TIMEFRAMES, useLivePageStore } from '../state/livePage';

type Props = {
  onOpenIndicators: () => void;
};

export function LiveToolbar({ onOpenIndicators }: Props) {
  const tf = useLivePageStore((s) => s.candleTimeframe);
  const setTf = useLivePageStore((s) => s.setCandleTimeframe);
  return (
    <div
      data-testid="live-toolbar"
      className="flex items-center gap-2 border-b px-3"
      style={{
        height: 'var(--h-toolbar)',
        borderColor: 'var(--border)',
        background: 'var(--bg-card)',
      }}
    >
      <div className="flex gap-1" role="group" aria-label="Timeframe">
        {LIVE_TIMEFRAMES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTf(t)}
            aria-pressed={tf === t}
            className="px-2 py-1 rounded font-mono"
            style={{
              background: tf === t ? 'var(--tint-selection)' : 'var(--bg-input)',
              color: tf === t ? 'var(--accent)' : 'var(--fg-dim)',
              fontSize: 'var(--text-xs)',
              border: '1px solid',
              borderColor: tf === t ? 'var(--accent)' : 'var(--border)',
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <button
        type="button"
        data-testid="live-indicators-button"
        onClick={onOpenIndicators}
        aria-label="보조지표"
        className="ml-1 inline-flex items-center rounded hover:opacity-90 transition-opacity"
        style={{
          gap: '4px',
          padding: '4px 10px',
          background: 'var(--bg-input)',
          color: 'var(--fg-dim)',
          border: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>보조지표</span>
      </button>
    </div>
  );
}
