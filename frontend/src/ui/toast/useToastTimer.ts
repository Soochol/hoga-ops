import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';

export const DEFAULT_TOAST_DURATION_MS = 5000;

/** One clock for dismissal and the CSS progress bar. Null duration is persistent.
 * Deletion deadlines owned by a store must not use this pausable presentation clock.
 */
export function useToastTimer({ visible, durationMs, resetKey, onExpire }: {
  visible: boolean;
  durationMs: number | null;
  resetKey?: unknown;
  onExpire: () => void;
}) {
  const expire = useRef(onExpire);
  useLayoutEffect(() => { expire.current = onExpire; }, [onExpire]);
  const remaining = useRef(durationMs ?? 0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [identity, setIdentity] = useState({ resetKey, visible, durationMs, cycle: 0 });
  if (!Object.is(identity.resetKey, resetKey) || identity.visible !== visible || identity.durationMs !== durationMs) {
    setIdentity({ resetKey, visible, durationMs, cycle: identity.cycle + 1 });
  }
  if (!visible && (hovered || focused)) { setHovered(false); setFocused(false); }
  const paused = hovered || focused;

  useEffect(() => {
    remaining.current = durationMs ?? 0;
  }, [visible, durationMs, resetKey]);

  useEffect(() => {
    if (!visible || durationMs == null || paused) return;
    const started = Date.now();
    const timeout = setTimeout(() => { remaining.current = 0; expire.current(); }, remaining.current);
    return () => {
      clearTimeout(timeout);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [visible, durationMs, resetKey, paused]);

  return {
    progress: visible && durationMs != null ? { durationMs, paused, resetKey: identity.cycle } : null,
    interactionProps: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocusCapture: () => setFocused(true),
      onBlurCapture: (event: FocusEvent<HTMLElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      },
    },
  };
}
