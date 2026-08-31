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
    // 선택까지 비운다 — 아래 테스트들이 selectedByScope 를 남기면 다음 테스트의
    // "풀렸다" 단언이 이전 실행 덕에 통과하는 위양성이 된다.
    useDrawingsStore.getState().__resetForTests();
  });

  it('도구 활성 중이면 차트 밖 우클릭도 select 로 되돌린다', () => {
    useDrawingsStore.getState().setActiveTool('pencil');
    render(<Host />);

    const prevented = !fireEvent.contextMenu(document.body);

    expect(prevented).toBe(true);
    expect(useDrawingsStore.getState().activeTool).toBe('select');
  });

  it('도구뿐 아니라 선택도 함께 푼다 — 한 번으로 끝나야 한다', () => {
    // 종전엔 도구만 풀어서 선택이 남았다. 하필 속성 패널은 select 모드에서만 뜨므로
    // 우클릭한 순간 툴바가 새로 나타나 "안 풀렸다" 로 읽혔고, 그래서 한 번 더 누르게
    // 되는데 두 번째는 첫 줄에서 빠져나가 아무 일도 하지 않았다.
    const s = () => useDrawingsStore.getState();
    s().setSelected('005930|minute', 'h1');
    s().setActiveTool('pencil');
    render(<Host />);

    fireEvent.contextMenu(document.body);

    expect(s().activeTool).toBe('select');
    expect(s().selectedFor('005930|minute')).toEqual([]);
  });

  it('여러 창(scope)의 선택을 모두 푼다 — 전역 리스너엔 scope 가 없다', () => {
    // scope 별로 지우려면 어느 창인지 알아야 하는데 이 리스너는 화면 전역이다.
    // `activeScope`(마지막 마운트 창이 이김)로 대신하면 엉뚱한 창만 지우고 정작
    // 보이는 선택은 남는 간헐 버그가 된다 — 그래서 전량 해제다.
    const s = () => useDrawingsStore.getState();
    s().setSelected('005930|minute', 'h1');
    s().setSelected('000660|D', 'r1');
    s().setActiveTool('rect');
    render(<Host />);

    fireEvent.contextMenu(document.body);

    expect(s().selectedFor('005930|minute')).toEqual([]);
    expect(s().selectedFor('000660|D')).toEqual([]);
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
