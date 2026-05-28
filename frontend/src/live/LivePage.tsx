import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useLivePageStore } from '../state/livePage';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveBannerState } from './useLiveBannerState';
import { LiveHeader } from './LiveHeader';
import { LiveStatusBar } from './LiveStatusBar';
import { LiveToolbar } from './LiveToolbar';
import { LiveWorkarea } from './LiveWorkarea';
import { LiveStateBanner } from './LiveStateBanner';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useLiveBundle } from './useLiveBundle';
import { todayKstYyyymmdd } from './liveDateTime';
import IndicatorPanel from './indicators/IndicatorPanel';

/**
 * /live page — KIS-based real-time indicator chart.
 *
 * Five-row grid (Stage 9-β adds LiveStateBanner as auto-sized row 2):
 *   1. LiveHeader      (var(--h-live-header))  — title + ⭐ toggle
 *   2. LiveStateBanner (auto)                  — empty/error state matrix
 *   3. LiveStatusBar   (var(--h-pricestrip))   — code/price/source/timeframe + cycle_lag pill
 *   4. LiveToolbar     (var(--h-toolbar))      — timeframe selector
 *   5. LiveWorkarea    (1fr)                   — chart + sidebar (filled by 9-γ + 11)
 *
 * Active code resolution (Addendum H-extra, 9.2):
 *   1. ?code= query param wins
 *   2. localStorage `live.page.v1` activeCode falls through
 *   3. (Future, Stage 11) first watchlist entry
 *   4. Empty state otherwise
 */
export function LivePage() {
  const [params] = useSearchParams();
  const queryCode = params.get('code');
  const storedCode = useLivePageStore((s) => s.activeCode);
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);

  // Sync query param → store so deep links update activeCode atomically.
  useEffect(() => {
    if (queryCode && queryCode !== storedCode) {
      setActiveCode(queryCode);
    }
  }, [queryCode, storedCode, setActiveCode]);

  const { data: status } = useLiveStatus();
  const banner = useLiveBannerState(status);

  // Keyboard shortcuts (Addendum 9.y / Design B7).
  // j/k traversal callbacks will be supplied by Stage 11 when the watchlist
  // panel is wired up; for now they're no-ops.
  useLiveKeyboard({});

  const activeCode = queryCode ?? storedCode;
  const watchlistEmpty = banner.primary === 'watchlist_empty';
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);

  // Single useLiveBundle source for the page: LiveStatusBar (current price +
  // source chip) and LiveWorkarea (chart + banner + clamp affordances) both
  // read the same bundle. Calling the hook once here means SSE pushes only
  // recompute the memoized bundle once per render and the TanStack query key
  // is derived from a single `today` reference (no KST-midnight drift).
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const today = todayKstYyyymmdd();
  const { bundle, clampEngaged, isPastCandlesLoading } = useLiveBundle(
    activeCode,
    timeframe,
    today,
  );

  return (
    <div
      className="h-full grid"
      style={{
        // minmax(0, 1fr) on the workarea row prevents the chart canvas's
        // intrinsic size from pushing the row past viewport height.
        gridTemplateRows:
          'var(--h-live-header) auto var(--h-pricestrip) var(--h-toolbar) minmax(0, 1fr)',
      }}
    >
      <LiveHeader />
      <LiveStateBanner primary={banner.primary} stack={banner.stack} />
      <LiveStatusBar
        activeCode={activeCode}
        cycleLagMs={status?.cycle_lag_ms ?? 0}
        bundle={bundle}
      />
      <LiveToolbar onOpenIndicators={() => setIndicatorPanelOpen(true)} />
      <LiveWorkarea
        activeCode={activeCode}
        watchlistEmpty={watchlistEmpty}
        bundle={bundle}
        clampEngaged={clampEngaged}
        isPastCandlesLoading={isPastCandlesLoading}
      />
      {indicatorPanelOpen && (
        <IndicatorPanel onClose={() => setIndicatorPanelOpen(false)} />
      )}
    </div>
  );
}

export default LivePage;
