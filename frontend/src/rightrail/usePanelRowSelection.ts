import { useCallback, useEffect, useRef, useState } from 'react';

/** Row identities are folder memberships, never just stock codes. */
export function usePanelRowSelection(visibleIds: string[]) {
  const [selectedRows, setSelectedRows] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const clear = useCallback(() => {
    anchor.current = null;
    setSelectedRows(old => old.size ? new Set() : old);
  }, []);

  useEffect(() => {
    const visible = new Set(visibleIds);
    if (anchor.current && !visible.has(anchor.current)) anchor.current = null;
    if ([...selectedRows].some(id => !visible.has(id))) {
      // External refresh can remove/collapse a row; hidden memberships must not stay selected.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedRows(old => new Set([...old].filter(id => visible.has(id))));
    }
  }, [visibleIds, selectedRows]);

  const select = (id: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) => {
    // Ctrl/⌘ opens a browser tab through onPick. Leave selection and its anchor intact,
    // including when Shift or Alt is also held.
    if (modifiers.ctrlKey || modifiers.metaKey) return false;
    if (!visibleIds.includes(id)) return false;
    if (modifiers.shiftKey) {
      const start = visibleIds.indexOf(anchor.current ?? id);
      const end = visibleIds.indexOf(id);
      if (start < 0) anchor.current = id;
      else if (!anchor.current) anchor.current = id;
      const from = start < 0 ? end : start;
      const range = visibleIds.slice(Math.min(from, end), Math.max(from, end) + 1);
      setSelectedRows(old => new Set(modifiers.altKey ? [...old, ...range] : range));
      return true;
    }
    anchor.current = id;
    if (modifiers.altKey) {
      setSelectedRows(old => {
        const next = new Set(old);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      return true;
    }
    setSelectedRows(old => old.size ? new Set() : old);
    return false;
  };
  return { selectedRows, clear, select };
}
