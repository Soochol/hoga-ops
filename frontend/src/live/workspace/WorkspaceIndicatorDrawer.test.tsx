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
    render(<WorkspaceIndicatorDrawer onClose={() => {}} />);
    expect(screen.getByTestId('indicator-panel-scope-badge').textContent)
      .toBe('SK하이닉스 · 일봉');
  });

  it('차트 창이 없으면 아무것도 렌더하지 않는다', () => {
    useWorkspaceStore.setState({ windows: [win('b1', 'book')], zOrder: ['b1'] });
    const { container } = render(<WorkspaceIndicatorDrawer onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
