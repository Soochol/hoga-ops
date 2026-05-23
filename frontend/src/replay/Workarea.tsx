import { useEffect, useMemo, useState } from 'react';
import { useTabsStore, type Tab } from '../state/tabs';
import { useRange } from '../api/range';
import { createVirtualAxis } from '../util/virtualAxis';
import ChartStage from '../chart/ChartStage';
import ChartErrorBoundary from '../chart/ChartErrorBoundary';
import { CursorSidebarConnected } from '../sidebar/CursorSidebar';
import RangeAdjustmentNotice from './RangeAdjustmentNotice';

/**
 * Workarea — wires `useRange` to `ChartStage` + `CursorSidebarConnected`
 * for the active tab. Supports a Stock-Date Range (fromDate..toDate) at a
 * given Timeframe (ADR-0013, ADR-0014).
 *
 * Status transitions:
 *  - `isLoading` → `setStatus(tab.id, 'loading')`
 *  - `isError`   → `setStatus(tab.id, 'error', message)`
 *  - `bundle`    → `putBundle(tab.id, bundle.from_date, bundle)` (also sets status to `'loaded'`)
 */
export default function Workarea({ tab }: { tab: Tab }) {
  const code = tab.selection?.code ?? null;
  const fromDate = tab.selection?.fromDate ?? null;
  const toDate = tab.selection?.toDate ?? null;
  const timeframe = tab.selection?.timeframe ?? null;

  const { data: bundle, isLoading, isError, error } = useRange(code, fromDate, toDate, timeframe);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  const axis = useMemo(
    () =>
      createVirtualAxis(
        bundle?.segments.map((s) => ({
          date: s.date,
          sessionOpenMs: s.session_open_ms,
          sessionCloseMs: s.session_close_ms,
        })) ?? [],
      ),
    [bundle?.segments],
  );

  useEffect(() => {
    if (!tab.selection) return;
    if (isLoading) {
      useTabsStore.getState().setStatus(tab.id, 'loading');
    } else if (isError) {
      useTabsStore.getState().setStatus(tab.id, 'error', String(error ?? 'unknown error'));
    } else if (bundle) {
      useTabsStore.getState().putBundle(tab.id, bundle.from_date, bundle);
      // putBundle also sets status to 'loaded'.
    }
  }, [tab.id, tab.selection, isLoading, isError, error, bundle]);

  if (isError) {
    return (
      <div className="grid place-items-center h-full text-error">
        Load failed: {String(error ?? 'unknown')}
      </div>
    );
  }

  const showNotice =
    !noticeDismissed &&
    bundle != null &&
    fromDate != null &&
    toDate != null &&
    bundle.segments.length > 0 &&
    (bundle.segments[0].date !== fromDate ||
      bundle.segments[bundle.segments.length - 1].date !== toDate);

  const onAdjust = () => {
    if (!bundle || !tab.selection) return;
    useTabsStore.getState().setSelection(tab.id, {
      ...tab.selection,
      fromDate: bundle.segments[0].date,
      toDate: bundle.segments[bundle.segments.length - 1].date,
    });
    setNoticeDismissed(false);
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg">
      {showNotice && (
        <RangeAdjustmentNotice
          requestedFrom={fromDate!}
          requestedTo={toDate!}
          actualFirst={bundle!.segments[0].date}
          actualLast={bundle!.segments[bundle!.segments.length - 1].date}
          onAdjust={onAdjust}
          onDismiss={() => setNoticeDismissed(true)}
        />
      )}
      <div className="grid grid-cols-[1fr_var(--sidebar-w)] gap-2 p-2 flex-1 min-h-0">
        <ChartErrorBoundary>
          <ChartStage
            key={`${code}:${fromDate}:${toDate}`}
            bundle={bundle ?? null}
            axis={axis}
          />
        </ChartErrorBoundary>
        <CursorSidebarConnected />
      </div>
    </div>
  );
}
