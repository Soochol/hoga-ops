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
    rect: { x: 0, y: 0, w: 442, h: 531 },
    chart: { timeframe, indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } },
  };
}

function book(id: string, group: number): WorkspaceWindow {
  return { id, kind: 'book', group, rect: { x: 442, y: 0, w: 236, h: 440 } };
}

beforeEach(() => {
  localStorage.clear();
  useLiveLayoutStore.setState({ lastAppliedPresetId: null });
  useWorkspaceStore.setState({
    windows: [chart('a', 1), book('b', 1)],
    zOrder: ['a', 'b'],
    groupSymbols: { 1: { code: '005930', name: '삼성전자' } },
    chartRuntime: {},
  });
});

describe('capturePresetPayload (v3 = 워크스페이스 전체 스냅샷, ADR-0119 PR-E)', () => {
  it('창 목록·z순서·그룹→종목을 담는다', () => {
    const payload = capturePresetPayload();
    expect(payload.zOrder).toEqual(['a', 'b']);
    expect(payload.groupSymbols).toEqual({ 1: { code: '005930', name: '삼성전자' } });
    expect((payload.windows as WorkspaceWindow[]).map((w) => w.id)).toEqual(['a', 'b']);
    expect((payload.windows as WorkspaceWindow[])[0].chart?.timeframe).toBe('1m');
  });

  it('deep copy — 캡처 payload 를 변형해도 스토어가 안 바뀐다(창·groupSymbols 둘 다)', () => {
    const payload = capturePresetPayload();
    (payload.windows as WorkspaceWindow[])[0].group = 9;
    (payload.groupSymbols as Record<string, { code: string }>)['1'].code = '000000';
    expect(useWorkspaceStore.getState().windows[0].group).toBe(1);
    expect(useWorkspaceStore.getState().groupSymbols[1]?.code).toBe('005930');
  });
});

describe('applyPresetPayload (v3 = 워크스페이스 통째 교체)', () => {
  it('창·종목·배치를 통째 복원하고 chartRuntime 을 리셋한다', () => {
    // 런타임에 잔여를 심어 리셋 확인.
    useWorkspaceStore.setState({ chartRuntime: { a: { historicalFromDate: '20260101', lastMinuteHistoricalFromDate: null } } });
    applyPresetPayload({
      windows: [chart('x', 2, '5m'), book('y', 2)],
      zOrder: ['x', 'y'],
      groupSymbols: { 2: { code: '000660', name: '하이닉스' } },
    }, 'preset-1');

    const s = useWorkspaceStore.getState();
    expect(s.windows.map((w) => w.id)).toEqual(['x', 'y']);
    expect(s.windows[0].chart?.timeframe).toBe('5m');
    expect(s.groupSymbols).toEqual({ 2: { code: '000660', name: '하이닉스' } });
    expect(s.chartRuntime).toEqual({}); // fresh-view 리셋
    expect(useLiveLayoutStore.getState().lastAppliedPresetId).toBe('preset-1');
  });

  it('손상 창(무효 kind·rect 없음)은 드롭하고 유효 창만 복원', () => {
    applyPresetPayload({
      windows: [
        { id: 'ok', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 400, h: 300 }, chart: { timeframe: '1m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } } },
        { id: 'bad', kind: 'nope', group: 1 }, // 무효 kind·rect 없음
      ] as unknown[],
      zOrder: ['ok', 'bad'],
      groupSymbols: {},
    }, null);
    expect(useWorkspaceStore.getState().windows.map((w) => w.id)).toEqual(['ok']);
  });

  it('유효 창이 하나도 없으면 공장 기본으로 폴백(빈 워크스페이스로 안 덮음)', () => {
    applyPresetPayload({ windows: [], zOrder: [], groupSymbols: {} }, null);
    const s = useWorkspaceStore.getState();
    expect(s.windows.length).toBeGreaterThan(0);
    expect(s.windows.some((w) => w.kind === 'chart')).toBe(true);
  });

  it('capture→apply 왕복 = 동형(창·종목·순서 보존)', () => {
    const captured = capturePresetPayload();
    // 흩뜨린 뒤 되적용.
    useWorkspaceStore.setState({ windows: [chart('z', 5)], zOrder: ['z'], groupSymbols: {}, chartRuntime: {} });
    applyPresetPayload(captured, null);
    const s = useWorkspaceStore.getState();
    expect(s.windows.map((w) => w.id)).toEqual(['a', 'b']);
    expect(s.groupSymbols).toEqual({ 1: { code: '005930', name: '삼성전자' } });
  });

  it('persist — live.workspace.v1 에 복원 상태가 쓰인다', () => {
    applyPresetPayload({
      windows: [chart('p', 3)],
      zOrder: ['p'],
      groupSymbols: { 3: { code: '035720', name: '카카오' } },
    }, 'p2');
    const persisted = JSON.parse(localStorage.getItem('live.workspace.v1') ?? '{}');
    expect(persisted.zOrder).toEqual(['p']);
    expect(persisted.groupSymbols['3'].code).toBe('035720');
  });
});

describe('defaultPresetPayload', () => {
  it('빈 스냅샷 — 적용 시 공장 기본 워크스페이스로 폴백', () => {
    const payload = defaultPresetPayload();
    expect(payload.windows).toEqual([]);
    expect(payload.zOrder).toEqual([]);
    expect(payload.groupSymbols).toEqual({});
    applyPresetPayload(payload, null);
    expect(useWorkspaceStore.getState().windows.some((w) => w.kind === 'chart')).toBe(true);
  });
});
