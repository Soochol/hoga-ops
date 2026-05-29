import { useEffect } from 'react';
import { useSymbols } from '../capture/useSymbols';

const DEFAULT_TITLE = 'hoga-ops';

/**
 * Sole writer to `document.title`. Resolves a Code to its Symbol Master name;
 * falls back to the Code itself, then to `'hoga-ops'`. Cleanup restores the
 * default so pages without a current-Code concept inherit it automatically.
 *
 * See: docs/superpowers/specs/2026-05-29-browser-tab-title-design.md
 */
export function useDocumentTitle(code: string | null | undefined): void {
  const { data } = useSymbols();
  useEffect(() => {
    const trimmed = code?.trim() || null;
    const name = trimmed
      ? data?.symbols.find((s) => s.code === trimmed)?.name
      : undefined;
    document.title = name ?? trimmed ?? DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [code, data]);
}
