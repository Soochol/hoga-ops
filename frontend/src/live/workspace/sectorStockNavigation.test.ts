import { beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../state/workspace';
import { openSectorStock } from './sectorStockNavigation';

beforeEach(() => {
  useWorkspaceStore.setState({ windows: [], zOrder: [], groupSymbols: {}, maximizedId: null, canvasSize: { w: 1000, h: 700 } });
});
it('연속 탐색은 결과 차트를 재사용하고 지수·다른 그룹을 보존한다', () => {
  const ws = useWorkspaceStore.getState();
  const source = ws.addWindow('sector-ranking');
  ws.setGroupSymbol(1, { code: 'KOSPI', name: 'KOSPI', kind: 'index' });
  const id = openSectorStock('005930', '삼성전자', 1, null);
  ws.focusWindow(source);
  expect(openSectorStock('000660', 'SK하이닉스', 1, id)).toBe(id);
  const after = useWorkspaceStore.getState();
  expect(after.windows).toHaveLength(2);
  expect(after.groupSymbols[1]?.code).toBe('KOSPI');
  expect(after.groupSymbols[2]?.code).toBe('000660');
});
it('결과 창이 고정되면 다른 그룹을 사용한다', () => {
  const ws = useWorkspaceStore.getState();
  const id = openSectorStock('005930', '삼성전자', 1, null)!;
  ws.toggleWindowPin(id);
  expect(openSectorStock('000660', 'SK하이닉스', 1, id)).not.toBe(id);
  expect(useWorkspaceStore.getState().windows.find((win) => win.id === id)?.pinned?.code).toBe('005930');
});
it('10개 그룹이 모두 사용 중이면 기존 창을 변경하지 않고 새 탭으로 연다', () => {
  const ws = useWorkspaceStore.getState();
  for (let group = 1; group <= 10; group++) ws.setWindowGroup(ws.addWindow('chart'), group);
  const before = useWorkspaceStore.getState().windows;
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  expect(openSectorStock('005930', '삼성전자', 1, null)).toBeNull();
  expect(useWorkspaceStore.getState().windows).toBe(before);
  expect(open).toHaveBeenCalledWith('/live?code=005930', '_blank', 'noopener');
  open.mockRestore();
});
it('최대화는 저장된 배치를 바꾸지 않고 복원·포커스 전환·닫기로 해제된다', () => {
  const ws = useWorkspaceStore.getState();
  const id = ws.addWindow('book');
  const other = ws.addWindow('chart');
  const rect = useWorkspaceStore.getState().windows.find((win) => win.id === id)!.rect;
  ws.toggleMaximize(id);
  expect(useWorkspaceStore.getState().maximizedId).toBe(id);
  expect(useWorkspaceStore.getState().windows.find((win) => win.id === id)!.rect).toBe(rect);
  ws.toggleMaximize(id);
  expect(useWorkspaceStore.getState().maximizedId).toBeNull();
  ws.toggleMaximize(id);
  ws.focusWindow(other);
  expect(useWorkspaceStore.getState().maximizedId).toBeNull();
  ws.toggleMaximize(id);
  ws.closeWindow(id);
  expect(useWorkspaceStore.getState().maximizedId).toBeNull();
});
it('추가 창은 실제 캔버스에서 콘텐츠 기본 크기를 유지하고 화면 안에 배치한다', () => {
  const ws = useWorkspaceStore.getState();
  ws.addWindow('investor');
  const rect = useWorkspaceStore.getState().windows[0].rect;
  expect(rect.w * 1000).toBe(400);
  expect(rect.x + rect.w).toBeLessThanOrEqual(1);
  ws.setCanvasSize({ w: 200, h: 150 });
  ws.addWindow('book');
  expect(useWorkspaceStore.getState().windows[1].rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
});
