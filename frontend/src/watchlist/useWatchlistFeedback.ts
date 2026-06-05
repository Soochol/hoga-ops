import { useEffect, useState } from 'react';
import type { ManualCatchupAllResponse } from '../api/watchlist';

const JUST_ADDED_MS = 5000;

export type RecentAction =
  | { kind: 'added';         code: string; name: string }
  | { kind: 'caught_up_one'; code: string; name: string; enqueued: number; deduped: number; error?: string }
  | { kind: 'caught_up_all'; summary: ManualCatchupAllResponse['results'] };

/** Single owner of the add/catch-up success/failure feedback + its 5s auto-clear.
 *  Shared by the drawer footer and the edit modal (each surface owns its own instance). */
export function useWatchlistFeedback() {
  const [recentAction, setRecentAction] = useState<RecentAction | null>(null);
  useEffect(() => {
    if (!recentAction) return;
    const id = setTimeout(() => setRecentAction(null), JUST_ADDED_MS);
    return () => clearTimeout(id);
  }, [recentAction]);
  return { recentAction, setRecentAction };
}
