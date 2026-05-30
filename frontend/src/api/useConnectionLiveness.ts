import { useEffect, useState } from 'react';
import { lastHeartbeat } from './eventStream';

/** True when a frame (event/live/heartbeat) arrived within `staleMs`. Polls
 *  every `pollMs`. Drives the connection-liveness UI surfaces (ADR-0053). */
export function useConnectionLiveness(staleMs: number, pollMs = 3000): boolean {
  const [live, setLive] = useState(false);
  useEffect(() => {
    const tick = () => {
      const last = lastHeartbeat();
      setLive(last !== 0 && Date.now() - last < staleMs);
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => clearInterval(id);
  }, [staleMs, pollMs]);
  return live;
}
