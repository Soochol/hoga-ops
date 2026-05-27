import { LIVE_TIMEFRAMES, useLivePageStore } from '../state/livePage';

export function LiveToolbar() {
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
    </div>
  );
}
