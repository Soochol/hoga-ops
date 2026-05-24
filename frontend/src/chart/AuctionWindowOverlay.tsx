import { useEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { useChartPrefs } from './ChartPrefsContext';

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
};

/**
 * Subtle background band over the last 10 minutes of each segment's Regular
 * Session (the Closing Auction Window — 15:20–15:30 KST on full-day, last
 * 10 min on half-day sessions). Gives analysts a visual cue distinguishing
 * a "flat 0" tick from a "masked to 0" tick on RatioPane when the auction
 * mask toggle is active.
 *
 * Coordinates are recomputed via the same RAF-coalesced subscribeVisible
 * + ResizeObserver path as DayBoundaryOverlay so pan/zoom/resize stay
 * smooth.
 */
const AUCTION_WINDOW_LENGTH_MS = 10 * 60 * 1000;

export default function AuctionWindowOverlay({ chart, axis }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const prefs = useChartPrefs();

  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => force((n) => n + 1));
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const parent = containerRef.current?.parentElement;
    const ro =
      parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro && parent) ro.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart]);

  if (!prefs.auctionWindowMask) return null;
  if (axis.segments.length === 0) return null;

  const ts = chart.timeScale();
  const bands = axis.segments.map((seg) => {
    // Virtual time of the auction start = segment's virtualEnd - 10min.
    const sessionLen = seg.sessionCloseMs - seg.sessionOpenMs;
    const virtualEnd = seg.virtualStart + sessionLen;
    const auctionVirtualStart = virtualEnd - AUCTION_WINDOW_LENGTH_MS;
    const x1 = ts.timeToCoordinate((auctionVirtualStart / 1000) as UTCTimestamp);
    const x2 = ts.timeToCoordinate((virtualEnd / 1000) as UTCTimestamp);
    return { date: seg.date, x1, x2 };
  });

  return (
    <div
      ref={containerRef}
      data-overlay="auction-window"
      className="absolute inset-0 pointer-events-none z-0"
    >
      {bands.map((b) =>
        b.x1 == null || b.x2 == null ? null : (
          <div
            key={b.date}
            data-auction-band={b.date}
            className="absolute top-0 bottom-0"
            style={{
              left: `${b.x1 as number}px`,
              width: `${(b.x2 as number) - (b.x1 as number)}px`,
              backgroundColor: 'var(--tint-auction-window)',
            }}
          />
        ),
      )}
    </div>
  );
}
