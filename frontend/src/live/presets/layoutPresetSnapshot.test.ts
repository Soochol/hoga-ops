import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import type { LiveTimeframe } from '../../state/livePage';
import { useLiveLayoutStore } from '../../state/liveLayout';
import {
  applyPresetPayload,
  capturePresetPayload,
  defaultPresetPayload,
} from './layoutPresetSnapshot';

function chart(id: string, group: number, timeframe: LiveTimeframe = '1m'): WorkspaceWindow {
  return {
    id, kind: 'chart', group,
    rect: { x: 0, y: 0, w: 0.4, h: 0.6 },
    chart: { timeframe },
  };
}

function book(id: string, group: number): WorkspaceWindow {
  return { id, kind: 'book', group, rect: { x: 0.4, y: 0, w: 0.25, h: 0.5 } };
}

const SAMSUNG = { code: '005930', name: '삼성전자' };

beforeEach(() => {
  localStorage.clear();
  useLiveLayoutStore.setState({ lastAppliedPresetId: null });
  useWorkspaceStore.setState({
    windows: [chart('a', 1), book('b', 1)],
    zOrder: ['a', 'b'],
    groupSymbols: { 1: { ...SAMSUNG } },
    chartRuntime: {},
  });
});

describe('capturePresetPayload (창·배치만 — 종목 없음)', () => {
  it('창 목록·z순서를 담고 종목은 담지 않는다', () => {
    const payload = capturePresetPayload();
    expect(payload.zOrder).toEqual(['a', 'b']);
    expect(payload.groupSymbols).toEqual({});
    expect((payload.windows as WorkspaceWindow[]).map((w) => w.id)).toEqual(['a', 'b']);
    expect((payload.windows as WorkspaceWindow[])[0].chart?.timeframe).toBe('1m');
  });

  it('창의 group 번호는 배치의 일부라 남는다(그 번호가 어느 종목인지만 프리셋 밖)', () => {
    useWorkspaceStore.setState({ windows: [chart('a', 3)], zOrder: ['a'] });
    const payload = capturePresetPayload();
    expect((payload.windows as WorkspaceWindow[])[0].group).toBe(3);
  });

  it('deep copy — 캡처 payload 를 변형해도 스토어가 안 바뀐다', () => {
    const payload = capturePresetPayload();
    (payload.windows as WorkspaceWindow[])[0].group = 9;
    expect(useWorkspaceStore.getState().windows[0].group).toBe(1);
  });
});

describe('applyPresetPayload (창·배치 교체 — 종목은 유지)', () => {
  it('창·배치를 복원하고 chartRuntime 을 리셋하되, 보고 있는 종목은 그대로 둔다', () => {
    // 런타임에 잔여를 심어 리셋 확인.
    useWorkspaceStore.setState({ chartRuntime: { a: { historicalFromDate: '20260101', lastMinuteHistoricalFromDate: null } } });
    applyPresetPayload({
      windows: [chart('x', 1, '5m'), book('y', 1)],
      zOrder: ['x', 'y'],
      groupSymbols: {},
    }, 'preset-1');

    const s = useWorkspaceStore.getState();
    expect(s.windows.map((w) => w.id)).toEqual(['x', 'y']);
    expect(s.windows[0].chart?.timeframe).toBe('5m');
    expect(s.groupSymbols).toEqual({ 1: SAMSUNG });
    expect(s.chartRuntime).toEqual({}); // 창 id 가 갈렸다 → fresh-view 리셋
    expect(useLiveLayoutStore.getState().lastAppliedPresetId).toBe('preset-1');
  });

  it('옛 v3 payload 의 종목은 무시된다 — 저장돼 있어도 현재 종목을 덮지 않는다', () => {
    applyPresetPayload({
      windows: [chart('x', 1)],
      zOrder: ['x'],
      groupSymbols: { 1: { code: '000660', name: '하이닉스' } },
    }, 'preset-old');
    expect(useWorkspaceStore.getState().groupSymbols).toEqual({ 1: SAMSUNG });
  });

  it('프리셋이 다른 그룹을 쓰면 그 그룹은 종목 없이 열린다(현재 그룹 종목은 보존)', () => {
    applyPresetPayload({ windows: [chart('x', 2)], zOrder: ['x'], groupSymbols: {} }, null);
    const s = useWorkspaceStore.getState();
    expect(s.windows[0].group).toBe(2);
    expect(s.groupSymbols[2]).toBeUndefined();
    expect(s.groupSymbols[1]).toEqual(SAMSUNG);
  });

  it('손상 창(무효 kind·rect 없음)은 드롭하고 유효 창만 복원', () => {
    applyPresetPayload({
      windows: [
        { id: 'ok', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 0.4, h: 0.3 }, chart: { timeframe: '1m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } } },
        { id: 'bad', kind: 'nope', group: 1 }, // 무효 kind·rect 없음
      ] as unknown[],
      zOrder: ['ok', 'bad'],
      groupSymbols: {},
    }, null);
    expect(useWorkspaceStore.getState().windows.map((w) => w.id)).toEqual(['ok']);
  });

  it('유효 창이 하나도 없으면 공장 기본 배치로 폴백(빈 워크스페이스로 안 덮음)', () => {
    applyPresetPayload({ windows: [], zOrder: [], groupSymbols: {} }, null);
    const s = useWorkspaceStore.getState();
    expect(s.windows.length).toBeGreaterThan(0);
    expect(s.windows.some((w) => w.kind === 'chart')).toBe(true);
  });

  it('공장 기본 폴백 경로에서도 종목이 살아남는다', () => {
    // 폴백 분기는 한때 groupSymbols 를 {} 로 만들어 냈다 — "기본 배치로 초기화"가
    // 종목을 조용히 날리던 경로. 손상 payload 도 같은 분기를 탄다.
    applyPresetPayload({ windows: [], zOrder: [], groupSymbols: {} }, null);
    expect(useWorkspaceStore.getState().groupSymbols).toEqual({ 1: SAMSUNG });
  });

  it('capture→apply 왕복 = 배치 동형(창·순서 보존)', () => {
    const captured = capturePresetPayload();
    // 흩뜨린 뒤 되적용.
    useWorkspaceStore.setState({ windows: [chart('z', 5)], zOrder: ['z'], chartRuntime: {} });
    applyPresetPayload(captured, null);
    const s = useWorkspaceStore.getState();
    expect(s.windows.map((w) => w.id)).toEqual(['a', 'b']);
    expect(s.groupSymbols).toEqual({ 1: SAMSUNG });
  });

  it('persist — live.workspace.v1 에 복원 배치 + 유지된 종목이 쓰인다', () => {
    applyPresetPayload({
      windows: [chart('p', 1)],
      zOrder: ['p'],
      groupSymbols: { 1: { code: '035720', name: '카카오' } },
    }, 'p2');
    const persisted = JSON.parse(localStorage.getItem('live.workspace.v1') ?? '{}');
    expect(persisted.zOrder).toEqual(['p']);
    expect(persisted.groupSymbols['1'].code).toBe('005930'); // payload 의 카카오가 아니다
  });
});

describe('defaultPresetPayload', () => {
  it('빈 스냅샷 — 적용 시 공장 기본 배치로 폴백하고 종목은 유지', () => {
    const payload = defaultPresetPayload();
    expect(payload.windows).toEqual([]);
    expect(payload.zOrder).toEqual([]);
    applyPresetPayload(payload, null);
    const s = useWorkspaceStore.getState();
    expect(s.windows.some((w) => w.kind === 'chart')).toBe(true);
    expect(s.groupSymbols).toEqual({ 1: SAMSUNG });
  });
});
