import { useEffect, useState } from 'react';

/**
 * A ticking `Date.now()` — re-renders the caller every `intervalMs` so a live
 * clock / progress head advances on its own. 1s default is plenty for the
 * Session Tape (a 6.5h track moves ~0.004%/s). The interval is cleared on
 * unmount, and a changed `intervalMs` restarts it.
 *
 * Deliberately NOT `requestAnimationFrame`: the tape doesn't need 60fps, and a
 * coarse timer keeps this off the render-hot path.
 */
export function useNowMs(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
