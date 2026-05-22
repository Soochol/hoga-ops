import { useEffect, useMemo } from 'react';
import { useTabsStore, type Tab } from '../state/tabs';
import { useStockDates } from '../api/stock-dates';
import { useSession } from '../api/session';
import { buildSegments, type Segment } from '../util/time';
import ChartStage from '../chart/ChartStage';
import ChartErrorBoundary from '../chart/ChartErrorBoundary';
import { CursorSidebarConnected } from '../sidebar/CursorSidebar';

/**
 * Workarea — wires `useSession` to `ChartStage` + `CursorSidebarConnected`
 * for the active tab. MVP: single-day only (`fromDate === toDate`).
 *
 * Status transitions:
 *  - `isLoading` → `setStatus(tab.id, 'loading')`
 *  - `isError`   → `setStatus(tab.id, 'error', message)`
 *  - `session`   → `putBundle(tab.id, date, session)` (also sets status to `'loaded'`)
 */
export default function Workarea({ tab }: { tab: Tab }) {
  const code = tab.selection?.code ?? null;
  const date = tab.selection?.fromDate ?? null; // MVP: single-day only
  const { data: session, isLoading, isError, error } = useSession(code, date);
  const { data: inventory = [] } = useStockDates();

  // Build segments from inventory for the active code+date.
  const segments: Segment[] = useMemo(() => {
    if (!code || !date) return [];
    const matches = inventory.filter((r) => r.code === code && r.date === date);
    return buildSegments(
      matches.map((r) => ({
        date: r.date,
        sessionOpenMs: r.regular_session_open_ms,
        sessionCloseMs: r.regular_session_close_ms,
      })),
    );
  }, [inventory, code, date]);

  // Status transitions: loading/loaded/error → store.
  useEffect(() => {
    if (!tab.selection) return;
    if (isLoading) {
      useTabsStore.getState().setStatus(tab.id, 'loading');
    } else if (isError) {
      useTabsStore.getState().setStatus(tab.id, 'error', String(error ?? 'unknown error'));
    } else if (session && date) {
      useTabsStore.getState().putBundle(tab.id, date, session);
      // putBundle also sets status to 'loaded'.
    }
  }, [tab.id, tab.selection, isLoading, isError, error, session, date]);

  if (isError) {
    return (
      <div className="grid place-items-center h-full text-down">
        Load failed: {String(error ?? 'unknown')}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[1fr_var(--sidebar-w)] gap-2 p-2 h-full min-h-0 bg-bg">
      <ChartErrorBoundary>
        <ChartStage bundle={session ?? null} segments={segments} />
      </ChartErrorBoundary>
      <CursorSidebarConnected />
    </div>
  );
}
