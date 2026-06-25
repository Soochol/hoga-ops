import type { DayVolumeDistribution } from '../api/types';
import { formatQtyCompact } from '../util/formatQtyCompact';
import { classifyWithinSegment } from '../util/sessionTime';

type Props = {
  profile: DayVolumeDistribution | null | undefined;
  cursorMs: number | null;
  color: string;
  maxColor: string;
};

export function VolumeDistributionCard({ profile, cursorMs, color, maxColor }: Props) {
  if (profile === undefined) {
    return <div className="grid h-full place-items-center text-xs text-fg-dimmer">—</div>;
  }
  if (profile === null || profile.bins.length === 0) {
    return <div className="grid h-full place-items-center text-xs text-fg-dimmer">매물대 분포 없음</div>;
  }

  const maxQty = Math.max(0, ...profile.bins.map((bin) => bin.qty));
  const rows = [...profile.bins].reverse();
  const cursorPhase = cursorMs == null
    ? null
    : classifyWithinSegment({
      sessionOpenMs: profile.session_open_ms,
      sessionCloseMs: profile.session_close_ms,
    }, cursorMs);
  const markerVisible = cursorMs != null && (cursorPhase === 'regular' || cursorPhase === 'auction');
  const markerPct = markerVisible && profile.session_close_ms > profile.session_open_ms
    ? ((cursorMs - profile.session_open_ms) / (profile.session_close_ms - profile.session_open_ms)) * 100
    : 0;

  return (
    <div
      data-testid="volume-distribution-card"
      className="relative flex h-full min-h-0 flex-col gap-1 px-2 py-2 text-[11px]"
    >
      {markerVisible && (
        <div
          data-testid="volume-distribution-cursor-marker"
          className="pointer-events-none absolute bottom-2 top-2 border-l border-dotted border-accent"
          style={{ left: `${Math.min(100, Math.max(0, markerPct))}%` }}
        />
      )}
      {rows.map((bin, index) => {
        const isMax = maxQty > 0 && bin.qty === maxQty;
        const width = maxQty > 0 ? `${(bin.qty / maxQty) * 100}%` : '0%';
        return (
          <div
            key={`${bin.price_low}-${bin.price_high}-${index}`}
            data-testid="volume-distribution-row"
            className="grid min-h-0 grid-cols-[72px_1fr_52px] items-center gap-2"
          >
            <div className="truncate font-mono text-fg-dim">
              {bin.price_low}
              -
              {bin.price_high}
            </div>
            <div className="h-2 overflow-hidden rounded-sm bg-bg">
              <div
                data-testid={isMax ? 'volume-distribution-max-bar' : 'volume-distribution-bar'}
                className="h-full"
                style={{ width, backgroundColor: isMax ? maxColor : color }}
              />
            </div>
            <div className="text-right font-mono text-fg-dimmer">{formatQtyCompact(bin.qty)}</div>
          </div>
        );
      })}
    </div>
  );
}
