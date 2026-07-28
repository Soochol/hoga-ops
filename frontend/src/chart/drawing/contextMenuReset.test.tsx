import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDrawingToolContextMenuReset } from './contextMenuReset';
import { useDrawingsStore } from '../../state/drawings';

function Host() {
  useDrawingToolContextMenuReset();
  return <div data-testid="host" />;
}

/**
 * 이 훅이 전역인 이유가 곧 회귀 조건이다 — 해제를 노드에 걸면 그 노드 밖이 사각지대로
 * 남고(1차 오버레이 → 가장자리 7~8px, 2차 차트 창 루트 → 창 밖 전부), 사각지대에서는
 * 네이티브 메뉴가 떠서 다음 우클릭까지 삼킨다("여러 번 눌러야" 의 정체).
 * 그래서 검증도 **차트와 무관한 노드**(document.body)에서 쏜다.
 */
describe('useDrawingToolContextMenuReset', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveTool('select');
  });

  it('도구 활성 중이면 차트 밖 우클릭도 select 로 되돌린다', () => {
    useDrawingsStore.getState().setActiveTool('pencil');
    render(<Host />);

    const prevented = !fireEvent.contextMenu(document.body);

    expect(prevented).toBe(true);
    expect(useDrawingsStore.getState().activeTool).toBe('select');
  });

  it('select 모드에선 리스너가 없어 우클릭을 가로채지 않는다', () => {
    render(<Host />);

    // 관심종목·히트맵 행 메뉴 등 기존 우클릭 UI 가 무손상이어야 한다.
    const prevented = !fireEvent.contextMenu(document.body);

    expect(prevented).toBe(false);
    expect(useDrawingsStore.getState().activeTool).toBe('select');
  });

  it('해제 후에는 리스너를 걷어 두 번째 우클릭을 가로채지 않는다', () => {
    useDrawingsStore.getState().setActiveTool('trendline');
    render(<Host />);

    fireEvent.contextMenu(document.body);
    const secondPrevented = !fireEvent.contextMenu(document.body);

    expect(secondPrevented).toBe(false);
  });

  it('언마운트 후에는 리스너가 남지 않는다', () => {
    useDrawingsStore.getState().setActiveTool('rect');
    const { unmount } = render(<Host />);
    unmount();

    const prevented = !fireEvent.contextMenu(document.body);

    expect(prevented).toBe(false);
    expect(useDrawingsStore.getState().activeTool).toBe('rect');
  });
});
