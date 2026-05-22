import { TIMEFRAME_LABELS, type Timeframe } from '../api/types';

type Props = {
  value: Timeframe;
  onChange: (next: Timeframe) => void;
};

/**
 * 6-step Timeframe segmented control (ADR-0014).
 * User selects 1m/3m/5m/10m/15m/30m; chart re-aggregates all series at the
 * chosen bucket_ms (see useRange / RangeBundle).
 */
export default function TimeframeSelector({ value, onChange }: Props) {
  return (
    <div
      className="inline-flex rounded border border-border overflow-hidden"
      role="group"
      aria-label="Timeframe"
    >
      {TIMEFRAME_LABELS.map((tf) => {
        const active = tf === value;
        return (
          <button
            key={tf}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(tf);
            }}
            className={
              active
                ? 'px-3 py-1.5 text-sm bg-accent text-accent-fg font-semibold'
                : 'px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg'
            }
          >
            {tf}
          </button>
        );
      })}
    </div>
  );
}
