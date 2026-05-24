import { useEffect, useMemo, useRef, useState } from 'react';
import { useTabsStore, type Tab } from '../state/tabs';
import { useRange } from '../api/range';
import { createVirtualAxis } from '../util/virtualAxis';
import ChartStage from '../chart/ChartStage';
import ChartErrorBoundary from '../chart/ChartErrorBoundary';
import { CursorSidebarConnected } from '../sidebar/CursorSidebar';
import RangeAdjustmentNotice from './RangeAdjustmentNotice';
import InvariantOutcomesBanner from './InvariantOutcomesBanner';
import VerticalSplitter from '../layout/VerticalSplitter';
import { useReplayLayoutStore, SIDEBAR_PX_MIN, SIDEBAR_PX_MAX } from '../state/replayLayout';
import CollapsedSidebarHandle from './CollapsedSidebarHandle';

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

  const sidebarPx = useReplayLayoutStore((s) => s.sidebarPx);
  const collapsed = useReplayLayoutStore((s) => s.sidebarCollapsed);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const gridTemplateColumns = collapsed ? '1fr' : `1fr 12px ${sidebarPx}px`;

  const onSplitterDrag = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // chart=1fr, splitter=12px, sidebar=<sidebarPx>px.
    // Sidebar's left edge = rect.right - sidebarPx.
    // We want sidebar.left = clientX + 6 (center of 12px splitter).
    const next = rect.right - clientX - 6;
    useReplayLayoutStore.getState().setSidebarPx(next);
  };

  const onSplitterNudge = (dir: -1 | 1, mag: 'small' | 'large') => {
    const step = mag === 'small' ? 8 : 40;
    // Convention: ArrowRight (dir=+1) shrinks the sidebar (chart grows).
    const next = useReplayLayoutStore.getState().sidebarPx - dir * step;
    useReplayLayoutStore.getState().setSidebarPx(next);
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
      {bundle && (
        <InvariantOutcomesBanner
          excluded={bundle.excluded_dates ?? []}
          warnings={bundle.data_warnings ?? []}
        />
      )}
      <div
        ref={containerRef}
        data-testid="workarea-grid"
        style={{ gridTemplateColumns }}
        className="grid gap-2 p-2 flex-1 min-h-0 relative"
      >
        <ChartErrorBoundary>
          <ChartStage
            key={`${code}:${fromDate}:${toDate}`}
            bundle={bundle ?? null}
            axis={axis}
          />
        </ChartErrorBoundary>
        {!collapsed && (
          <>
            <VerticalSplitter
              ariaLabel={`사이드바 폭 조정 (현재 ${Math.round(sidebarPx)}px)`}
              ariaValueNow={Math.round(sidebarPx)}
              ariaValueMin={SIDEBAR_PX_MIN}
              ariaValueMax={SIDEBAR_PX_MAX}
              onDrag={onSplitterDrag}
              onReset={() => useReplayLayoutStore.getState().resetSidebar()}
              onNudge={onSplitterNudge}
            />
            <CursorSidebarConnected axis={axis} />
          </>
        )}
        {collapsed && <CollapsedSidebarHandle />}
      </div>
    </div>
  );
}
