import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { targetChartWindow, WorkspaceIndicatorDrawer } from './WorkspaceIndicatorDrawer';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';

function win(id: string, kind: WorkspaceWindow['kind'], group = 1): WorkspaceWindow {
  const w: WorkspaceWindow = { id, kind, group, rect: { x: 0, y: 0, w: 400, h: 300 } };
  if (kind === 'chart') {
    w.chart = { timeframe: 'D', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } };
  }
  return w;
}

describe('targetChartWindow — 드로어 대상 선정 (#712)', () => {
  it('포커스가 차트면 그 창, 데이터 창이면 z순서 최상위 차트', () => {
    const windows = [win('c1', 'chart'), win('c2', 'chart'), win('b1', 'book')];
    expect(targetChartWindow(windows, ['c1', 'c2'])?.id).toBe('c2');
    expect(targetChartWindow(windows, ['c2', 'c1', 'b1'])?.id).toBe('c1'); // 포커스=book → 차트 중 최상위
    expect(targetChartWindow([win('b1', 'book')], ['b1'])).toBeNull();
  });
});

describe('WorkspaceIndicatorDrawer', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      windows: [win('c1', 'chart', 3)],
      zOrder: ['c1'],
      groupSymbols: { 3: { code: '000660', name: 'SK하이닉스' } },
      chartRuntime: {},
    });
  });

  it('대상 창(종목·봉)을 헤더 배지에 표시하고 렌더한다', () => {
    render(<WorkspaceIndicatorDrawer windowId="c1" onClose={() => {}} />);
    expect(screen.getByTestId('indicator-panel-scope-badge').textContent)
      .toBe('SK하이닉스 · 일봉');
  });

  it('대상 창이 닫혔으면 아무것도 렌더하지 않는다', () => {
    useWorkspaceStore.setState({ windows: [win('b1', 'book')], zOrder: ['b1'] });
    const { container } = render(<WorkspaceIndicatorDrawer windowId="c1" onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  // #759 결정 4 — 대상 고정. 이전(#712)에는 z-최상위를 실시간 추적했는데, 그건
  // 트리거가 전역 툴바에 있어 대상을 추측할 수밖에 없던 시절의 규칙이었다.
  // 헤더 버튼은 대상을 명시하므로, 열린 뒤 다른 창이 포커스를 가져가도 따라가지
  // 않는다 — 색을 고르다 다른 종목 설정으로 미끄러지지 않게.
  it('지정한 창에 고정된다 — 다른 창이 z-최상위가 돼도 따라가지 않는다', () => {
    useWorkspaceStore.setState({
      windows: [win('c1', 'chart', 3), win('c2', 'chart', 4)],
      zOrder: ['c1', 'c2'], // c2 가 포커스(최상위)
      groupSymbols: {
        3: { code: '000660', name: 'SK하이닉스' },
        4: { code: '005930', name: '삼성전자' },
      },
      chartRuntime: {},
    });

    render(<WorkspaceIndicatorDrawer windowId="c1" onClose={() => {}} />);

    expect(screen.getByTestId('indicator-panel-scope-badge').textContent)
      .toBe('SK하이닉스 · 일봉');
  });
});
