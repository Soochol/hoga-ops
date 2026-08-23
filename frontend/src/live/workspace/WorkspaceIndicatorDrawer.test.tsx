import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { targetChartWindow, WorkspaceIndicatorDrawer } from './WorkspaceIndicatorDrawer';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';

function win(id: string, kind: WorkspaceWindow['kind'], group = 1): WorkspaceWindow {
  const w: WorkspaceWindow = { id, kind, group, rect: { x: 0, y: 0, w: 400, h: 300 } };
  if (kind === 'chart') {
    w.chart = { timeframe: 'D' };
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

/**
 * 드로어는 **사용자가 지표를 켜고 끄는 주 표면**이다. 창별 세트(ADR-0152)에서
 * 이 표면이 대상 창이 아닌 곳에 쓰면 증상은 **"드로어에서 켰는데 차트가 안
 * 바뀜"** 이고, 그건 이 기능의 인수 워크스루가 통째로 실패하는 모양이다.
 *
 * `WindowViewValue` 를 만드는 4곳 중 창 컴포넌트 2곳은 창 테스트가 잰다.
 * 드로어 2곳이 남은 이음매라 여기서 잰다.
 *
 * **막는 방향**: 드로어 편집이 대상 창 밖(페이지 세트·다른 창)으로 새는 것.
 * **못 보는 것**: 드로어가 **어느 창을 대상으로 고르는가**(그건 위
 * `targetChartWindow` 케이스가 잰다) 와 픽셀.
 */
describe('드로어 편집은 대상 창의 세트로 간다 (ADR-0152)', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      windows: [win('c1', 'chart', 3), win('c2', 'chart', 3)],
      zOrder: ['c1', 'c2'],
      groupSymbols: { 3: { code: '000660', name: 'SK하이닉스' } },
      chartRuntime: {},
    });
    useLivePageStore.setState({
      ...FACTORY_INDICATOR_SETTINGS,
      indicatorsByTimeframe: {},
        indicatorsByWindow: {},
      indicatorTimeframe: '1m',
    });
  });

  it('대상 창의 버킷에 쓴다 — 페이지 세트도, 옆 창도 안 움직인다', () => {
    // 드로어는 c1 을 대상으로 열지만 포커스(zOrder 최상단)는 c2 다. 두 창은 같은
    // 봉(D)이라 **봉 축으로는 구별되지 않는다** — 창 축이 유일한 기여자다.
    render(<WorkspaceIndicatorDrawer windowId="c1" onClose={() => {}} />);

    fireEvent.click(screen.getByRole('checkbox', { name: '거래량' }));

    const s = useLivePageStore.getState();
    expect(s.indicatorsByWindow['live:c1']?.D?.volumeEnabled).toBe(false);
    expect(s.indicatorsByWindow['live:c2']).toBeUndefined();
    expect(s.indicatorsByTimeframe.D).toBeUndefined();
    // 최상위 ambient 투영도 그대로 — Provider 밖 소비자가 남의 창 값을 보면 안 된다.
    expect(s.volumeEnabled).toBe(true);
  });
});
