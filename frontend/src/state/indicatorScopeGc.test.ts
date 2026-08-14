import { describe, it, expect, beforeEach } from 'vitest';
import { useLivePageStore } from './livePage';
import { useChartPrefsStore } from './chartPrefs';
import { useWorkspaceStore, type WorkspaceWindow } from './workspace';
import { useStudyWorkspaceStore } from './studyWorkspace';
import { FACTORY_INDICATOR_SETTINGS } from './indicatorSettingsV2';
import { normalizePaneOrder } from '../chart/paneOrder';

/**
 * 사라진 창의 지표 스코프 회수 가드.
 *
 * 두 방향으로 틀릴 수 있고 **둘 다 조용하다**:
 *  - 안 지우면 닿을 수 없는 설정이 저장소에 쌓인다(창 id 는 재사용되지 않는다).
 *  - 과하게 지우면 화면에 멀쩡히 있는 창의 설정이 초기화된다. 이쪽이 훨씬 나쁘다 —
 *    사용자는 자기가 무엇을 잃었는지도 모른다.
 *
 * 그래서 "요청받은 id" 가 아니라 **실제로 사라진 창**을 기준으로 회수하는지를 잰다.
 */

function chartWindow(id: string): WorkspaceWindow {
  return { id, kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.4, h: 0.4 }, chart: { timeframe: '1m' } };
}

function scopes(): string[] {
  return Object.keys(useLivePageStore.getState().indicatorsByWindow).sort();
}

function prefScopes(): string[] {
  return Object.keys(useChartPrefsStore.getState().indicatorModalByWindow).sort();
}

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({
    ...FACTORY_INDICATOR_SETTINGS,
    indicatorsByTimeframe: {},
    indicatorsByWindow: {},
    indicatorTimeframe: '1m',
    paneOrder: normalizePaneOrder([]),
    paneStretch: {},
  });
  useChartPrefsStore.setState({ indicatorModalByWindow: {}, indicatorModalByTimeframe: {} });
});

describe('/live 창 소멸', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      windows: [chartWindow('w1'), chartWindow('w2')],
      zOrder: ['w1', 'w2'],
      groupSymbols: { 1: { code: '005930', name: '삼성전자' } },
      chartRuntime: {},
    });
    useLivePageStore.getState().detachWindowIndicators('live:w1');
    useLivePageStore.getState().detachWindowIndicators('live:w2');
  });

  it('창을 닫으면 그 창의 스코프만 회수한다', () => {
    useWorkspaceStore.getState().closeWindow('w1');

    expect(scopes()).toEqual(['live:w2']);
    expect(prefScopes()).toEqual(['live:w2']);
  });

  it('레이아웃 프리셋 적용은 사라진 창만 회수한다 — 같은 id 가 살아남으면 설정도 산다', () => {
    // 프리셋 payload 는 창 id 를 담는다(snapshotWorkspace). 그 배치를 저장한 그
    // 세션의 창이면 id 가 그대로라, 전량 폐기하면 멀쩡한 설정을 잃는다.
    useWorkspaceStore.getState().applyWorkspaceSnapshot({
      windows: [chartWindow('w2'), chartWindow('w3')],
      zOrder: ['w2', 'w3'],
    });

    expect(scopes()).toEqual(['live:w2']);
  });
});

describe('/study 창 소멸', () => {
  it('닫기가 거부되면(마지막 차트 창) 스코프를 회수하지 않는다', () => {
    useStudyWorkspaceStore.setState({
      windows: [{ id: 's1', kind: 'chart', rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, chart: { timeframe: '1m' } }],
      zOrder: ['s1'],
      chartRuntime: {},
    });
    useLivePageStore.getState().detachWindowIndicators('study:s1');

    useStudyWorkspaceStore.getState().closeWindow('s1');

    // 창이 그대로 남았으므로 설정도 남아야 한다 — 요청 id 로 지웠다면 여기서 깨진다.
    expect(useStudyWorkspaceStore.getState().windows).toHaveLength(1);
    expect(scopes()).toEqual(['study:s1']);
  });

  it('실제로 닫히면 회수한다', () => {
    useStudyWorkspaceStore.setState({
      windows: [
        { id: 's1', kind: 'chart', rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, chart: { timeframe: '1m' } },
        { id: 's2', kind: 'chart', rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, chart: { timeframe: 'D' } },
      ],
      zOrder: ['s1', 's2'],
      chartRuntime: {},
    });
    useLivePageStore.getState().detachWindowIndicators('study:s1');
    useLivePageStore.getState().detachWindowIndicators('study:s2');

    useStudyWorkspaceStore.getState().closeWindow('s2');

    expect(scopes()).toEqual(['study:s1']);
  });
});

describe('네임스페이스', () => {
  it('창 id 가 같아도 `/live` 회수가 `/study` 를 건드리지 않는다', () => {
    useWorkspaceStore.setState({
      windows: [chartWindow('dup')],
      zOrder: ['dup'],
      groupSymbols: {},
      chartRuntime: {},
    });
    useLivePageStore.getState().detachWindowIndicators('live:dup');
    useLivePageStore.getState().detachWindowIndicators('study:dup');

    useWorkspaceStore.getState().closeWindow('dup');

    expect(scopes()).toEqual(['study:dup']);
  });
});
