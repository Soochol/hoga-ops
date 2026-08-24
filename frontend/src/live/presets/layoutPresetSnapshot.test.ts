import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
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
  // 창 id 를 고정으로 재사용하므로 **매번 비운다**(ADR-0152 의 테스트 격리 항목).
  // 안 비우면 앞 테스트가 심은 창 세트가 뒤 테스트를 가리고, 증상 서명이 "혼자
  // 돌리면 통과, 파일 전체로 돌리면 실패" 라 머신 부하 flake 와 헷갈린다.
  useLivePageStore.setState({ indicatorsByTimeframe: {}, indicatorsByWindow: {} });
  useChartPrefsStore.setState({ indicatorModalByTimeframe: {}, indicatorModalByWindow: {} });
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

/**
 * 프리셋이 창별 지표를 나른다 (ADR-0159).
 *
 * **막는 방향**: 프리셋을 갈아탄 뒤 지표가 페이지 세트로 리셋되는 것. 종전에는 창
 * id 의 스코프가 스냅샷 교체 때 회수돼, 창은 돌아오는데 지표는 공장값으로 열렸다.
 *
 * **못 보는 것**: 크로스기기. 프리셋은 서버 파일이고 지표는 localStorage 라, 다른
 * 기기에서 payload 가 지표를 실어 나르는지는 여기서 잴 수 없다 — 그 경로가 이
 * 기능의 주 동기지만 검증은 payload 왕복(캡처→적용)으로 대신한다.
 *
 * **등록 의존**: `applyPresetPayload` 가 복원을 **스냅샷 적용 뒤에** 부르는 것.
 * 순서가 뒤집히면 "스토어에 없는 창" 케이스가 고아를 만들고 상한에서 조용히
 * 포기한다(그 판정은 `indicatorScopeGc.test.ts`).
 */
const KEY_A = 'live:a';

describe('프리셋 지표 왕복 (ADR-0159)', () => {
  it('캡처가 차트 창에만 지표를 담는다 — 데이터 창은 실을 것이 없다', () => {
    useLivePageStore.setState({
      indicatorsByWindow: { [KEY_A]: { minute: { volumeEnabled: false } } },
    });

    const windows = capturePresetPayload().windows as Record<string, unknown>[];

    expect(windows[0].indicators).toEqual({ minute: { volumeEnabled: false } });
    expect(windows[1].kind).toBe('book');
    expect(windows[1].indicators).toBeUndefined();
  });

  it('**A → B → A 왕복에서 A 의 지표가 산다** — 이 기능의 본체', () => {
    useLivePageStore.setState({
      indicatorsByWindow: { [KEY_A]: { minute: { volumeEnabled: false } } },
    });
    const presetA = capturePresetPayload();

    // B 로 갈아탄다 — 창 id 가 갈리며 A 의 스코프가 회수된다(종전 리셋 지점).
    applyPresetPayload({
      windows: [chart('other', 1)], zOrder: ['other'], groupSymbols: {},
    }, 'preset-b');
    expect(Object.hasOwn(useLivePageStore.getState().indicatorsByWindow, KEY_A)).toBe(false);

    applyPresetPayload(presetA, 'preset-a');

    expect(useLivePageStore.getState().indicatorsByWindow[KEY_A])
      .toEqual({ minute: { volumeEnabled: false } });
  });

  it('**적용이 현재 창의 지표를 덮어쓴다** — 시드가 아니라 교체다', () => {
    useLivePageStore.setState({
      indicatorsByWindow: { [KEY_A]: { minute: { volumeEnabled: false } } },
    });
    const presetA = capturePresetPayload();

    // 저장 후 사용자가 지표를 만진다(창 id 는 그대로 — 종전에 유일하게 동작하던 경로).
    useLivePageStore.setState({
      indicatorsByWindow: { [KEY_A]: { minute: { volumeEnabled: true, ratioEnabled: true } } },
    });

    applyPresetPayload(presetA, 'preset-a');

    expect(useLivePageStore.getState().indicatorsByWindow[KEY_A])
      .toEqual({ minute: { volumeEnabled: false } });
  });

  it('공장값으로 저장한 창은 페이지 세트를 물어오지 않는다 — 빈 `{}` 가 실린다', () => {
    // 페이지 세트에 값을 심어 둔다. 빈 엔트리를 생략했다면 적용 시 이 값이 샌다.
    useLivePageStore.setState({ indicatorsByTimeframe: { minute: { ratioEnabled: true } } });
    const presetA = capturePresetPayload();

    applyPresetPayload(presetA, 'preset-a');

    expect(useLivePageStore.getState().indicatorsByWindow[KEY_A]).toEqual({});
  });

  it('지표 키 없는 옛 프리셋은 종전대로 — 복원이 아무것도 심지 않는다', () => {
    applyPresetPayload({
      windows: [chart('a', 1)], zOrder: ['a'], groupSymbols: {},
    }, 'legacy');

    // 마운트 시드(창 컴포넌트)가 채울 몫이라 이 시점엔 비어 있어야 한다.
    expect(Object.hasOwn(useLivePageStore.getState().indicatorsByWindow, KEY_A)).toBe(false);
  });

  it('두 스토어가 함께 왕복한다 — 절반만 프리셋 값이면 안 된다', () => {
    useLivePageStore.setState({
      indicatorsByWindow: { [KEY_A]: { minute: { volumeEnabled: false } } },
    });
    useChartPrefsStore.setState({
      indicatorModalByWindow: { [KEY_A]: { minute: { surgeMarkerEnabled: false } } },
    });
    const presetA = capturePresetPayload();

    applyPresetPayload({
      windows: [chart('other', 1)], zOrder: ['other'], groupSymbols: {},
    }, 'preset-b');
    applyPresetPayload(presetA, 'preset-a');

    expect(useLivePageStore.getState().indicatorsByWindow[KEY_A])
      .toEqual({ minute: { volumeEnabled: false } });
    expect(useChartPrefsStore.getState().indicatorModalByWindow[KEY_A])
      .toEqual({ minute: { surgeMarkerEnabled: false } });
  });

  it('"기본 배치로 초기화" 는 지표를 싣지 않는다 — 초기화의 뜻에 맞는다', () => {
    useLivePageStore.setState({
      indicatorsByWindow: { [KEY_A]: { minute: { volumeEnabled: false } } },
    });

    applyPresetPayload(defaultPresetPayload(), null);

    // 공장 창이 새 id 로 나므로 옛 엔트리는 회수되고, 새 창은 마운트 시드가 채운다.
    expect(Object.hasOwn(useLivePageStore.getState().indicatorsByWindow, KEY_A)).toBe(false);
  });
});
