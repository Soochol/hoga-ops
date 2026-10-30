import { useWorkspaceStore, windowSymbolOf } from '../../state/workspace';

/** Open the displayed subject without replacing another window's pinned symbol. */
export function openTradeWindow(sourceId: string): string | null {
  const ws = useWorkspaceStore.getState();
  const source = ws.windows.find(w => w.id === sourceId && (w.kind === 'book' || w.kind === 'order'));
  const symbol = windowSymbolOf(ws, source);
  if (!source || !symbol || symbol.kind === 'index' || symbol.kind === 'us_stock') return null;
  const existing = [...ws.zOrder].reverse().find(id => {
    const win = ws.windows.find(w => w.id === id);
    return win?.kind === 'trade' && win.group === source.group && windowSymbolOf(ws, win)?.code === symbol.code;
  });
  if (existing) {
    ws.focusWindow(existing);
    return existing;
  }
  ws.focusWindow(source.id);
  const id = ws.addWindow('trade');
  ws.setWindowGroup(id, source.group);
  if (source.pinned) ws.pinWindowToSymbol(id, symbol);
  ws.focusWindow(id);
  return id;
}
