import { useWorkspaceStore, windowSymbolOf } from '../../state/workspace';
import { isSecondTimeframe } from '../../state/livePage';
import { realMsToYyyymmdd } from '../liveDateTime';

/** One explicit command. Find a matching window without replacing a pinned
 * subject, or create a seconds window in the source chart's group. */
export function openSecondChartRange(sourceId: string, fromMs: number, toMs: number): string | null {
  const ws = useWorkspaceStore.getState();
  const source = ws.windows.find(w => w.id === sourceId && w.kind === 'chart');
  const symbol = windowSymbolOf(ws, source);
  if (!source || !symbol || symbol.kind === 'index' || symbol.kind === 'us_stock' || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const from = Math.min(fromMs, toMs), to = Math.max(fromMs, toMs);
  if (to > Date.now() || from < 0) return null;
  let targetId = [...ws.zOrder].reverse().find(id => {
    const w = ws.windows.find(row => row.id === id);
    return w && w.id !== source.id && w.kind === 'chart' && w.group === source.group
      && w.chart && isSecondTimeframe(w.chart.timeframe) && windowSymbolOf(ws, w)?.code === symbol.code;
  });
  if (!targetId) {
    ws.focusWindow(source.id);
    targetId = ws.addWindow('chart');
    ws.setWindowGroup(targetId, source.group);
    ws.setChartTimeframe(targetId, '5s');
    if (ws.groupSymbols[source.group]?.code !== symbol.code) ws.pinWindowToSymbol(targetId, symbol);
  }
  ws.setSecondChartRange(targetId, { fromMs: from, toMs: to });
  ws.focusWindow(targetId);
  return targetId;
}

/** Upper bound is exclusive for the seconds API; range anchors are inclusive. */
export function secondRangeQuery(range: { fromMs: number; toMs: number }, seconds: number) {
  const date = realMsToYyyymmdd(range.toMs);
  const dayEnd = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00+09:00`) + 86_400_000;
  return { date, fromMs: Math.floor(range.fromMs / (seconds * 1000)) * seconds * 1000,
    endMs: Math.min(dayEnd, Math.floor(range.toMs / (seconds * 1000)) * seconds * 1000 + seconds * 1000) };
}
