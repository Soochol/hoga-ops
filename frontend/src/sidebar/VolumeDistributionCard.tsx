import type { DayVolumeDistribution } from '../api/types';
import { classifyWithinSegment } from '../util/sessionTime';

type Props = {
  profile: DayVolumeDistribution | null | undefined;
  cursorMs: number | null;
  closePoints?: readonly ClosePoint[];
  color: string;
  maxColor: string;
};

type ClosePoint = {
  t_ms: number;
  close: number;
};

export function VolumeDistributionCard({
  profile,
  cursorMs,
  closePoints = [],
  color,
  maxColor,
}: Props) {
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
  const lastCloseMs = closePoints.length > 0 ? closePoints[closePoints.length - 1]?.t_ms : null;
  const axisEndMs = Math.max(profile.session_open_ms, profile.last_trade_ms ?? lastCloseMs ?? profile.session_close_ms);
  const markerPct = markerVisible && axisEndMs > profile.session_open_ms
    ? ((cursorMs - profile.session_open_ms) / (axisEndMs - profile.session_open_ms)) * 100
    : 0;
  const closePath = buildClosePath({
    points: closePoints,
    priceMin: profile.price_min,
    priceMax: profile.price_max,
    sessionOpenMs: profile.session_open_ms,
    axisEndMs,
  });
  return (
    <div
      data-testid="volume-distribution-card"
      className="flex h-full min-h-0 flex-col gap-1 px-2 py-2 text-[11px]"
    >
      <div className="relative min-h-0 flex-1">
        {markerVisible && (
          <div
            data-testid="volume-distribution-cursor-marker"
            className="pointer-events-none absolute bottom-0 top-0 border-l border-dotted border-accent"
            style={{ left: `${Math.min(100, Math.max(0, markerPct))}%` }}
          />
        )}
        {closePath && (
          <svg
            data-testid="volume-distribution-close-graph"
            className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
          >
            <path
              d={closePath}
              fill="none"
              stroke="var(--fg)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity="0.9"
              strokeWidth="1.6"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        <div className="flex h-full min-h-0 flex-col gap-1">
          {rows.map((bin, index) => {
            const isMax = maxQty > 0 && bin.qty === maxQty;
            const width = maxQty > 0 ? `${(bin.qty / maxQty) * 100}%` : '0%';
            return (
              <div
                key={`${bin.price_low}-${bin.price_high}-${index}`}
                data-testid="volume-distribution-row"
                className="min-h-0"
              >
                <div
                  data-testid="volume-distribution-track"
                  className="h-2 overflow-hidden rounded-sm border border-border-subtle bg-bg-input"
                >
                  <div
                    data-testid={isMax ? 'volume-distribution-max-bar' : 'volume-distribution-bar'}
                    className="h-full"
                    style={{ width, backgroundColor: isMax ? maxColor : color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div data-testid="volume-distribution-time-axis">
        <div className="h-px bg-border/70" />
      </div>
    </div>
  );
}

function buildClosePath({
  points,
  priceMin,
  priceMax,
  sessionOpenMs,
  axisEndMs,
}: {
  points: readonly ClosePoint[];
  priceMin: number;
  priceMax: number;
  sessionOpenMs: number;
  axisEndMs: number;
}): string | null {
  if (points.length < 2 || axisEndMs <= sessionOpenMs || priceMax <= priceMin) return null;
  const coords = points
    .filter((point) =>
      Number.isFinite(point.t_ms) &&
      Number.isFinite(point.close) &&
      point.t_ms >= sessionOpenMs &&
      point.t_ms <= axisEndMs &&
      point.close >= priceMin &&
      point.close <= priceMax,
    )
    .map((point) => {
      const x = ((point.t_ms - sessionOpenMs) / (axisEndMs - sessionOpenMs)) * 100;
      const y = ((priceMax - point.close) / (priceMax - priceMin)) * 100;
      return [clampPct(x), clampPct(y)] as const;
    });
  if (coords.length < 2) return null;
  return coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}
