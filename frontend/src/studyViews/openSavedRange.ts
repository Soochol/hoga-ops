import type { StudyViewListRow } from '../api/studyViews';
import { activateLiveCode } from '../live/liveNavigate';
import { isSecondTimeframe, useLivePageStore } from '../state/livePage';
import { activationTarget, useWorkspaceStore, windowSymbolOf } from '../state/workspace';
import { savedRangeFocusFromView } from './savedRangeFocus';

/** Drawer and ?view= use the same symbol → resolution → range sequence. */
export function openSavedRange(row: StudyViewListRow): void {
  const ws = useWorkspaceStore.getState();
  const destination = activationTarget(ws);
  activateLiveCode(row.code, row.label);
  if (destination.kind === 'blocked') return;
  const group = destination.kind === 'window' ? destination.window.group : destination.group;
  const current = useWorkspaceStore.getState();
  let target = destination.kind === 'window' && destination.window.kind === 'chart'
    ? current.windows.find(w => w.id === destination.window.id)
    : [...current.zOrder].reverse().map(id => current.windows.find(w => w.id === id))
      .find(w => w?.kind === 'chart' && w.group === group && windowSymbolOf(current, w)?.code === row.code);
  if (isSecondTimeframe(row.timeframe) && !target) {
    const id = current.addWindow('chart');
    current.setWindowGroup(id, group);
    target = useWorkspaceStore.getState().windows.find(w => w.id === id);
  }
  if (target?.chart && (isSecondTimeframe(row.timeframe) || isSecondTimeframe(target.chart.timeframe))) {
    current.setChartTimeframe(target.id, row.timeframe);
    current.setSecondChartRange(target.id, null);
    current.focusWindow(target.id);
  }
  useLivePageStore.getState().focusSavedRange(savedRangeFocusFromView(row));
}
