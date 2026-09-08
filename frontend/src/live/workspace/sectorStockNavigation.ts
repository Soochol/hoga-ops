import { MAX_GROUP, MIN_GROUP, useWorkspaceStore, type GroupId } from '../../state/workspace';
import { openLiveInNewTab } from '../liveNavigate';
import { stockInstrument } from '../liveInstrument';

/** 랭킹의 지수 그룹을 보존한다. 이 랭킹에서 연 차트만 재사용하며 다른 작업 창은 덮어쓰지 않는다. */
export function openSectorStock(code: string, name: string, sourceGroup: GroupId, previousId: string | null): string | null {
  const ws = useWorkspaceStore.getState();
  const previous = ws.windows.find((win) => win.id === previousId && win.kind === 'chart'
    && !win.pinned && win.group !== sourceGroup
    && ws.groupSymbols[win.group]?.kind !== 'index'
    && !ws.windows.some((other) => other.group === win.group && other.kind === 'sector-ranking'));
  if (previous) {
    ws.setWindowSymbol(previous.id, { code, name });
    ws.focusWindow(previous.id);
    return previous.id;
  }
  const group = Array.from({ length: MAX_GROUP - MIN_GROUP + 1 }, (_, i) => (i + MIN_GROUP) as GroupId)
    .find((candidate) => candidate !== sourceGroup && !ws.windows.some((win) => win.group === candidate));
  if (group === undefined) {
    openLiveInNewTab(stockInstrument(code, name));
    return null;
  }
  const id = ws.addWindow('chart');
  ws.setWindowGroup(id, group);
  ws.setGroupSymbol(group, { code, name });
  return id;
}
