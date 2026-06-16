import { useEffect } from 'react';
import { useSymbols } from '../capture/useSymbols';
import { formatLiveViewLabel } from '../live/liveViewLabel';
import type { LiveTimeframe } from '../state/livePage';

const DEFAULT_TITLE = 'hoga-ops';

/**
 * Sole writer to `document.title`. Resolves a Code to its Symbol Master name;
 * falls back to the Code itself, then to `'hoga-ops'`. Cleanup restores the
 * default so pages without a current-Code concept inherit it automatically.
 *
 * See: docs/superpowers/specs/2026-05-29-browser-tab-title-design.md
 */
export function useDocumentTitle(code: string | null | undefined, timeframe?: LiveTimeframe): void {
  const { data } = useSymbols();
  useEffect(() => {
    const trimmed = code?.trim() || null;
    const name = trimmed
      ? data?.symbols.find((s) => s.code === trimmed)?.name
      : undefined;
    const base = name ?? trimmed;
    document.title = base ? formatLiveViewLabel(base, timeframe) : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [code, data, timeframe]);
}
