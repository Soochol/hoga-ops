import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useLivePageStore } from '../state/livePage';
import { LiveHeader } from './LiveHeader';
import { LiveStatusBar } from './LiveStatusBar';
import { LiveToolbar } from './LiveToolbar';
import { LiveWorkarea } from './LiveWorkarea';

/**
 * /live page — KIS-based real-time indicator chart (Stage 9-α shell).
 *
 * Four-row grid mirroring /replay's PriceStrip pattern:
 *   1. LiveHeader      (var(--h-live-header))  — title + ⭐ toggle
 *   2. LiveStatusBar   (var(--h-pricestrip))   — code/price/source/timeframe
 *   3. LiveToolbar     (var(--h-toolbar))      — timeframe selector
 *   4. LiveWorkarea    (1fr)                   — chart + sidebar (filled by 9-γ + 11)
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

  const activeCode = queryCode ?? storedCode;

  return (
    <div
      className="h-full grid"
      style={{
        gridTemplateRows:
          'var(--h-live-header) var(--h-pricestrip) var(--h-toolbar) 1fr',
      }}
    >
      <LiveHeader />
      <LiveStatusBar activeCode={activeCode} />
      <LiveToolbar />
      <LiveWorkarea activeCode={activeCode} />
    </div>
  );
}

export default LivePage;
