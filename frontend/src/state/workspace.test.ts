import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useWorkspaceStore,
  activeGroupOf,
  groupTargetChartWindow,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceWindow,
} from './workspace';
import { BOOK_WINDOW_DEFAULT_W } from '../live/workspace/bookPanelMetrics';
import { NARROW_CANVAS_W } from '../workspace/referenceCanvas';

function chart(id: string, group: number): WorkspaceWindow {
  return {
    id,
    kind: 'chart',
    group,
    rect: { x: 0, y: 0, w: 500, h: 400 },
    chart: { timeframe: '1m' },
  };
}

function book(id: string, group: number): WorkspaceWindow {
  return { id, kind: 'book', group, rect: { x: 0, y: 0, w: 236, h: 440 } };
}

// 워크스페이스의 authoritative 저장소는 자기 탭의 sessionStorage 다(workspace.ts 스코프
// 주석). 이 파일의 픽스처는 전부 localStorage 로 세우므로, 앞 테스트가 남긴 탭 저장소가
// 픽스처를 가리지 않도록 매 테스트 전에 비운다 — 하이드레이션은 탭을 먼저 본다.
beforeEach(() => {
  sessionStorage.clear();
});

describe('activeGroupOf', () => {
  it('포커스 창(zOrder 마지막)의 그룹을 반환한다', () => {
    const state = { windows: [chart('a', 3), chart('b', 7)], zOrder: ['a', 'b'] };
    expect(activeGroupOf(state)).toBe(7);
  });
  it('창이 없으면 그룹 1', () => {
    expect(activeGroupOf({ windows: [], zOrder: [] })).toBe(1);
  });
});

describe('groupTargetChartWindow (ADR-0119 PR-D 그룹 링크 발행자 선정)', () => {
  it('그룹의 z-최상위 차트 창을 반환한다 — 다른 그룹·데이터 창은 건너뛴다', () => {
    const windows = [chart('a', 1), chart('b', 2), chart('c', 1), book('d', 1)];
    // z순서: a < b < c < d — 그룹 1 의 최상위 차트는 c (d 는 데이터 창).
    expect(groupTargetChartWindow(windows, ['a', 'b', 'c', 'd'], 1)?.id).toBe('c');
    expect(groupTargetChartWindow(windows, ['a', 'b', 'c', 'd'], 2)?.id).toBe('b');
  });
  it('그룹에 차트 창이 없으면 null', () => {
    const windows = [chart('a', 1), book('d', 2)];
    expect(groupTargetChartWindow(windows, ['a', 'd'], 2)).toBeNull();
    expect(groupTargetChartWindow([], [], 1)).toBeNull();
  });
});

describe('useWorkspaceStore 액션', () => {
  beforeEach(() => {
    // 알려진 상태로 초기화 — 싱글톤 하이드레이션·이전 테스트 잔여 제거.
    useWorkspaceStore.setState({ windows: [chart('a', 3)], zOrder: ['a'], groupSymbols: {} });
    // 탭 저장소가 authoritative 이므로(workspace.ts 스코프) 함께 비운다 — 앞 테스트가
    // 남긴 sessionStorage 가 아래 localStorage 픽스처를 가린다.
    sessionStorage.clear();
    localStorage.clear();
  });

  it('addWindow 는 활성 그룹을 상속한다(#711)', () => {
    const id = useWorkspaceStore.getState().addWindow('book');
    const win = useWorkspaceStore.getState().windows.find((w) => w.id === id);
    expect(win?.group).toBe(3); // 포커스 차트 'a' 의 그룹
    expect(win?.kind).toBe('book');
  });

  it('새 차트 창은 포커스 차트 창의 timeframe 을 복제한다(#712)', () => {
    useWorkspaceStore.setState({
      windows: [{ ...chart('a', 3), chart: { timeframe: 'D' } }],
      zOrder: ['a'],
      groupSymbols: {},
    });
    const id = useWorkspaceStore.getState().addWindow('chart');
    const win = useWorkspaceStore.getState().windows.find((w) => w.id === id);
    expect(win?.chart?.timeframe).toBe('D');
  });

  it('closeWindow 는 창과 zOrder 에서 함께 제거한다', () => {
    const id = useWorkspaceStore.getState().addWindow('book');
    useWorkspaceStore.getState().closeWindow(id);
    const s = useWorkspaceStore.getState();
    expect(s.windows.some((w) => w.id === id)).toBe(false);
    expect(s.zOrder.includes(id)).toBe(false);
  });

  it('focusWindow 는 zOrder 끝으로 올린다', () => {
    useWorkspaceStore.setState({ windows: [chart('a', 1), book('b', 1)], zOrder: ['a', 'b'], groupSymbols: {} });
    useWorkspaceStore.getState().focusWindow('a');
    expect(useWorkspaceStore.getState().zOrder).toEqual(['b', 'a']);
  });

  it('setWindowGroup 은 범위 밖 그룹을 거부한다', () => {
    useWorkspaceStore.getState().setWindowGroup('a', 11);
    expect(useWorkspaceStore.getState().windows[0].group).toBe(3); // 불변
    useWorkspaceStore.getState().setWindowGroup('a', 5);
    expect(useWorkspaceStore.getState().windows[0].group).toBe(5);
  });

  it('setWindowRects 는 여러 창을 한 번에 커밋한다(스플리터)', () => {
    useWorkspaceStore.setState({ windows: [chart('a', 1), book('b', 1)], zOrder: ['a', 'b'], groupSymbols: {} });
    useWorkspaceStore.getState().setWindowRects([
      { id: 'a', rect: { x: 0, y: 0, w: 300, h: 400 } },
      { id: 'b', rect: { x: 300, y: 0, w: 200, h: 400 } },
    ]);
    const s = useWorkspaceStore.getState();
    expect(s.windows.find((w) => w.id === 'a')?.rect.w).toBe(300);
    expect(s.windows.find((w) => w.id === 'b')?.rect.x).toBe(300);
  });

  it('액션은 localStorage 로 영속화한다', () => {
    useWorkspaceStore.getState().addWindow('book');
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).windows.length).toBe(2);
  });
});

describe('손상된 저장값 방어(관대한 per-entry 검증)', () => {
  it('손상된 창은 드롭하고 정상 창만 하이드레이션한다', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        windows: [
          { id: 'good', kind: 'book', group: 2, rect: { x: 1, y: 2, w: 300, h: 300 } },
          { id: 'badGroup', kind: 'book', group: 99, rect: { x: 0, y: 0, w: 200, h: 200 } },
          { id: 'badKind', kind: 'nope', group: 1, rect: { x: 0, y: 0, w: 200, h: 200 } },
          { noId: true },
        ],
        zOrder: ['good', 'ghost'],
        groupSymbols: { 2: { code: '005930', name: '삼성전자' }, 99: { code: 'x', name: 'y' } },
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.map((w) => w.id)).toEqual(['good']);
    expect(s.zOrder).toEqual(['good']); // ghost 드롭
    expect(s.groupSymbols[2]).toEqual({ code: '005930', name: '삼성전자' });
    expect(s.groupSymbols[99]).toBeUndefined(); // 범위 밖 그룹 드롭
  });

  it('그룹 심볼 kind=index 는 code 가 실제 LiveIndexId 일 때만 보존한다(리뷰 #2)', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        windows: [{ id: 'c', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 500, h: 400 }, chart: { timeframe: '1m' } }],
        zOrder: ['c'],
        groupSymbols: {
          1: { code: 'KOSPI', name: '코스피', kind: 'index' },   // 유효 → 보존
          2: { code: 'FOO', name: '가짜', kind: 'index' },        // 무효 code → kind 강등
        },
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const gs = mod.useWorkspaceStore.getState().groupSymbols;
    expect(gs[1]).toEqual({ code: 'KOSPI', name: '코스피', kind: 'index' });
    expect(gs[2]).toEqual({ code: 'FOO', name: '가짜' }); // kind 없음(stock 기본)
  });

  it('차트 창 하이드레이션: 손상 timeframe→1m, 지표 누락→정규화 사본', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        windows: [{ id: 'c', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 500, h: 400 }, chart: { timeframe: 'ZZZ' } }],
        zOrder: ['c'],
        groupSymbols: {},
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const win = mod.useWorkspaceStore.getState().windows[0];
    expect(win.chart?.timeframe).toBe('1m'); // 손상값 폴백
    // 지표는 창이 소유하지 않는다 — 손상 저장값에서도 chart 는 봉만 담는다.
    expect(win.chart && 'indicators' in win.chart).toBe(false);
  });

  it('readRect: 부분/비유한 rect 는 드롭, 미달 크기는 MIN 으로 클램프', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        windows: [
          { id: 'tiny', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 50, h: 30 } }, // MIN 미달 → 클램프
          { id: 'partial', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 300 } }, // h 누락 → 드롭
          { id: 'nonfinite', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 'x', h: 200 } }, // 비유한 → 드롭
        ],
        zOrder: ['tiny', 'partial', 'nonfinite'],
        groupSymbols: {},
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.map((w) => w.id)).toEqual(['tiny']); // partial·nonfinite 드롭
    expect(s.windows[0].rect.w).toBe(160); // MIN_W 클램프
    expect(s.windows[0].rect.h).toBe(120); // MIN_H 클램프
  });

  it('모든 창이 손상되면 기본 레이아웃으로 폴백한다', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ windows: [{ bad: 1 }, { kind: 'nope' }], zOrder: [], groupSymbols: {} }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.length).toBe(3); // defaultWindows: chart + book + broker
    expect(s.windows[0].kind).toBe('chart');
    expect(s.zOrder.length).toBe(3);
  });

  it('windows 가 배열이 아니면 기본 레이아웃으로 폴백한다', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ windows: 'foo', zOrder: [], groupSymbols: {} }));
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.length).toBe(3);
    expect(s.windows[0].kind).toBe('chart');
  });
});

describe('레거시 마이그레이션 하이드레이션(#713, PR-C)', () => {
  it('live.workspace.v1 부재 + 레거시 키 존재 → 마이그레이션 시드로 하이드레이션한다', async () => {
    localStorage.clear();
    // live.workspace.v1 는 없고, 레거시 단일 뷰 상태만 존재.
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ candleTimeframe: 'D', activeInstrument: { kind: 'stock', code: '000660', label: 'SK하이닉스' }, activeCode: '000660' }),
    );
    localStorage.setItem(
      'live.layout.v1',
      JSON.stringify({
        rightCardOrder: ['brokers', 'orderbook'],
        // 나머지 3종은 숨김 → 순서 보존 + 숨김 제외를 함께 검증.
        rightCardHidden: { volumeDistribution: true, program: true, investor: true },
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    const chart = s.windows.find((w) => w.kind === 'chart')!;
    expect(chart.chart?.timeframe).toBe('D'); // 레거시 봉 계승
    expect(s.groupSymbols[1]).toEqual({ code: '000660', name: 'SK하이닉스' });
    // 레거시 카드 순서 보존 → brokers(broker), orderbook(book); 나머지 숨김 → 제외
    const dataKinds = s.windows.filter((w) => w.kind !== 'chart').map((w) => w.kind);
    expect(dataKinds).toEqual(['broker', 'book']);
  });

  /**
   * 마이그레이션 시드가 **새로고침을 넘어 살아남는지**. 종전엔 살아남지 못했다.
   *
   * 막는 방향: 시드가 저장 스키마와 **다른 좌표계**를 내는 것. 시드는 즉시 persist 되고
   * `persistFromState` 는 항상 v2(비율)로 태그하므로, 시드가 px 를 내면 저장소에 거짓
   * 태그가 남고 다음 로드의 `isFracRect` 가 전량 탈락시킨다 → 공장 기본 폴백.
   * 실측(고치기 전): 창 6개·봉 `D` → 새로고침 후 창 3개·봉 `1m`·id 전부 교체.
   *
   * 에러가 없다는 것이 이 실패의 특징이다 — 폴백이 정상 경로라 조용히 데이터만 사라진다.
   * 그래서 가드는 "창이 있다" 가 아니라 **같은 id·같은 봉이 남았는가**를 본다.
   *
   * 못 보는 것: 진짜 v1 px 저장값(사용자가 옛 버전에서 만든 것)의 `pendingNormalize`
   * 경로 — 그건 캔버스 실측이 필요해 jsdom 단위 테스트 범위 밖이다.
   */
  it('레거시 시드는 새로고침을 넘어 살아남는다 — 좌표계 태그가 참이어야 한다', async () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ candleTimeframe: 'D', activeCode: '000660', activeInstrument: { kind: 'stock', code: '000660', label: 'SK하이닉스' } }),
    );
    vi.resetModules();
    const first = await import('./workspace');
    const seeded = first.useWorkspaceStore.getState();
    const seededIds = seeded.windows.map((w) => w.id);

    // 저장된 스냅샷의 좌표계가 태그(v2=비율)와 일치해야 한다.
    const stored = JSON.parse(
      sessionStorage.getItem(WORKSPACE_STORAGE_KEY) ?? localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? 'null',
    );
    expect(stored.schema_version).toBe(2);
    for (const w of stored.windows) {
      expect(w.rect.w).toBeLessThanOrEqual(1);
      expect(w.rect.h).toBeLessThanOrEqual(1);
    }

    vi.resetModules();
    const second = await import('./workspace');
    const after = second.useWorkspaceStore.getState();
    expect(after.windows.map((w) => w.id)).toEqual(seededIds); // id 고정 = 재시드 없음
    expect(after.windows.find((w) => w.kind === 'chart')?.chart?.timeframe).toBe('D'); // 레거시 봉 유지
    expect(after.groupSymbols[1]).toEqual({ code: '000660', name: 'SK하이닉스' }); // 종목 유지
  });

  it('레거시 키도 없으면 공장 기본 레이아웃', async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.length).toBe(3); // defaultWindows
    expect(s.groupSymbols[1]).toBeUndefined();
  });

  // BookPanel 의 폭은 절대 계약이고, 비율 좌표계는 절대 하한을 표현하지 못한다
  // (ADR-0122). REF 캔버스(1546)에서 유도한 비율은 실제 캔버스에서 계약을 못 채워
  // 요약 열이 조용히 잘렸다 — 좁은 쪽 실측을 기준으로 못박아 재발을 막는다. 기준은
  // 패널 하한이 아니라 **창 기본 폭**이다: 세로 스크롤바가 뜨는 순간 그 여유
  // (BOOK_WINDOW_CHROME_W)까지 없으면 패널이 하한 아래로 눌린다. 숫자는
  // `bookPanelMetrics` 에서 가져와 하한이 움직이면 이 가드가 함께 따라오게 한다
  // (2026-08-16 이전엔 560 이 여기 손으로 복제돼 있었다).
  //
  // 캔버스 폭도 같은 이유로 상수에서 가져온다 — 손으로 복제한 1226 은 시세 스트립이
  // 있던 시절 실측이라 실제(1208)보다 넓어 가드가 그만큼 느슨했다(2026-08-17).
  it('기본 10호가 창은 좁은 실측 캔버스에서도 BookPanel 폭 계약을 만족한다', async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import('./workspace');
    const book = mod.useWorkspaceStore.getState().windows.find((w) => w.kind === 'book');
    expect(book).toBeDefined();
    expect(book!.rect.w * NARROW_CANVAS_W).toBeGreaterThanOrEqual(BOOK_WINDOW_DEFAULT_W);
    // 비율 불변식(ADR-0122) — 넓혀도 캔버스를 넘지 않는다.
    expect(book!.rect.x + book!.rect.w).toBeLessThanOrEqual(1);
  });

  // 하한이 560→448 로 내려오며 회수한 폭은 여백으로 남기지 않고 차트에 넘겼다
  // (2026-08-16). 우측 열만 줄이고 끝내면 캔버스 가운데에 빈 띠가 생기므로,
  // "차트 오른쪽 끝 = 우측 열 시작" 을 못박아 그 회귀를 막는다.
  it('회수한 폭은 차트가 흡수한다 — 차트와 우측 열 사이에 빈 띠가 없다', async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import('./workspace');
    const wins = mod.useWorkspaceStore.getState().windows;
    const chart = wins.find((w) => w.kind === 'chart')!;
    const book = wins.find((w) => w.kind === 'book')!;
    // 좌표 틈은 0 이다(2026-08-17) — 인접 창의 시각 간격은 `WindowFrameCore` 의
    // GAP(2px, 좌표는 그대로 두고 카드만 물러난다)이 담당하므로 좌표가 벌어질 이유가 없다.
    expect(book.rect.x - (chart.rect.x + chart.rect.w)).toBe(0);
    // 차트가 캔버스 절반보다 넓다 — 회수 방향이 뒤집히면(우측 열이 다시 먹으면) 깨진다.
    expect(chart.rect.w).toBeGreaterThan(0.5);
  });

  /**
   * 여백 소유자는 페이지 패딩(`WORKSPACE_PAGE_PAD`) **한 곳**이다 — 창 좌표는 여백을
   * 갖지 않는다(2026-08-17).
   *
   * 막는 방향: 비율 좌표에 여백이 **다시 들어오는** 것. 종전 `DEFAULT_EDGE_MARGIN`
   * (0.0104)·y(0.0206) 이 그것이었고, 비율이라 캔버스에 비례해 자라 `/study` 와의 창
   * 왼쪽 간격 차이가 1440 뷰포트 10px → 2560 뷰포트 22px 로 벌어졌다.
   *
   * 못 보는 것: 페이지 패딩 쪽 값(`WORKSPACE_PAGE_PAD` 리터럴)과 `/study` 시드
   * (`buildStudyWorkspaceSeed` — 자기 테스트가 `{x:0,y:0,w:0.58,h:1}` 을 못박는다).
   * 이 가드는 `/live` 기본 배치만 본다.
   */
  it('기본 배치는 여백 없이 캔버스를 꽉 채운다', async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import('./workspace');
    const rects = mod.useWorkspaceStore.getState().windows.map((w) => w.rect);
    expect(Math.min(...rects.map((r) => r.x))).toBe(0);
    expect(Math.min(...rects.map((r) => r.y))).toBe(0);
    expect(Math.max(...rects.map((r) => r.x + r.w))).toBe(1);
    expect(Math.max(...rects.map((r) => r.y + r.h))).toBe(1);
  });
});

// 창 헤더가 `종목코드(종목코드)` 로 나오던 버그의 치유 지점. 이름 없이 저장된 값
// (`liveNavigate` 의 `label ?? code` 폴백)의 유일한 서명이 `name === code` 다.
describe('backfillSymbolNames', () => {
  const RESOLVE = (code: string) => ({ '000660': 'SK하이닉스', '005930': '삼성전자' }[code]);

  function seed(groupSymbols: Record<number, { code: string; name: string; kind?: 'stock' | 'index' }>) {
    useWorkspaceStore.setState({
      windows: [chart('w1', 1)],
      zOrder: ['w1'],
      groupSymbols,
      chartRuntime: { w1: { historicalFromDate: '20260101', lastMinuteHistoricalFromDate: null, lastMinuteHistoricalTimeframe: null } },
    });
  }

  it('name === code 인 그룹만 실명으로 보강한다', () => {
    seed({ 1: { code: '000660', name: '000660' }, 2: { code: '005930', name: '삼성전자' } });
    useWorkspaceStore.getState().backfillSymbolNames(RESOLVE);
    const { groupSymbols } = useWorkspaceStore.getState();
    expect(groupSymbols[1]).toEqual({ code: '000660', name: 'SK하이닉스' });
    expect(groupSymbols[2]).toEqual({ code: '005930', name: '삼성전자' });
  });

  it('마스터에 없는 코드는 그대로 둔다', () => {
    seed({ 1: { code: '999999', name: '999999' } });
    useWorkspaceStore.getState().backfillSymbolNames(RESOLVE);
    expect(useWorkspaceStore.getState().groupSymbols[1]).toEqual({ code: '999999', name: '999999' });
  });

  it('지수는 건너뛴다 — code 가 곧 사람이 읽는 id 라 심볼 마스터 대상이 아니다', () => {
    seed({ 1: { code: 'KOSPI', name: 'KOSPI', kind: 'index' } });
    useWorkspaceStore.getState().backfillSymbolNames(() => '엉뚱한이름');
    expect(useWorkspaceStore.getState().groupSymbols[1]).toEqual({
      code: 'KOSPI', name: 'KOSPI', kind: 'index',
    });
  });

  it('보강할 게 없으면 groupSymbols 참조를 그대로 둔다(재렌더·persist 낭비 회피)', () => {
    seed({ 1: { code: '005930', name: '삼성전자' } });
    const before = useWorkspaceStore.getState().groupSymbols;
    useWorkspaceStore.getState().backfillSymbolNames(RESOLVE);
    expect(useWorkspaceStore.getState().groupSymbols).toBe(before);
  });

  // setGroupSymbol 은 종목 교체(fresh-view)라 chartRuntime 을 리셋하지만, 실명 보강은
  // 같은 종목의 라벨 수정이다. 여기서 리셋하면 심볼 마스터 응답이 도착하는 임의의
  // 시점에 진행 중이던 과거 백필이 조용히 처음으로 되감긴다.
  it('chartRuntime 을 리셋하지 않는다', () => {
    seed({ 1: { code: '000660', name: '000660' } });
    useWorkspaceStore.getState().backfillSymbolNames(RESOLVE);
    expect(useWorkspaceStore.getState().chartRuntime.w1).toEqual({ historicalFromDate: '20260101', lastMinuteHistoricalFromDate: null, lastMinuteHistoricalTimeframe: null });
  });

  it('보강 결과를 영속화한다 — 다음 새로고침에 오염된 값이 되살아나지 않는다', () => {
    seed({ 1: { code: '000660', name: '000660' } });
    useWorkspaceStore.getState().backfillSymbolNames(RESOLVE);
    const saved = JSON.parse(sessionStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '{}');
    expect(saved.groupSymbols[1]).toEqual({ code: '000660', name: 'SK하이닉스' });
  });
});

/**
 * 창별 hogaplay 저장 데이터 소스 토글.
 *
 * **양방향으로 잰다.** 한쪽만 보면 "항상 켠다"·"항상 끈다" 하드코딩도 초록이라
 * 토글의 절반이 검증 밖에 남는다. 봉 전환의 carry/clear 도 같은 이유로 두 방향이다.
 */
describe('setChartHogaplaySource', () => {
  function seedChart(timeframe: '1m' | '5m' | 'D') {
    useWorkspaceStore.setState({
      windows: [{ ...chart('w1', 1), chart: { timeframe } }],
      zOrder: ['w1'],
      groupSymbols: { 1: { code: '005930', name: '삼성전자' } },
      chartRuntime: {},
    });
  }

  it('분봉 창에서 켜고 끈다(양방향)', () => {
    seedChart('1m');
    useWorkspaceStore.getState().setChartHogaplaySource('w1', true);
    expect(useWorkspaceStore.getState().chartRuntime.w1?.hogaplaySource).toBe(true);
    useWorkspaceStore.getState().setChartHogaplaySource('w1', false);
    expect(useWorkspaceStore.getState().chartRuntime.w1?.hogaplaySource).toBe(false);
  });

  // 캘린더 봉의 디스크 소스는 스크리너 일봉이지 hogaplay 가 아니다 — 켜면 버튼이
  // 이름과 다른 것을 켠 상태가 된다. **끄는 것은 언제나 허용**: 봉이 먼저 바뀌어
  // 이미 내려간 뒤 칩 × 가 늦게 도착해도 no-op 이어야 한다.
  it('캘린더 봉에서는 켜지지 않지만 끄기는 통과한다', () => {
    seedChart('D');
    useWorkspaceStore.getState().setChartHogaplaySource('w1', true);
    expect(useWorkspaceStore.getState().chartRuntime.w1?.hogaplaySource ?? false).toBe(false);
    expect(() => useWorkspaceStore.getState().setChartHogaplaySource('w1', false)).not.toThrow();
    expect(useWorkspaceStore.getState().chartRuntime.w1?.hogaplaySource ?? false).toBe(false);
  });

  it('분봉 → 분봉 전환에서는 따라오고, 분봉 → 캘린더에서는 내려간다', () => {
    seedChart('1m');
    useWorkspaceStore.getState().setChartHogaplaySource('w1', true);
    useWorkspaceStore.getState().setChartTimeframe('w1', '5m');
    expect(useWorkspaceStore.getState().chartRuntime.w1?.hogaplaySource).toBe(true);
    useWorkspaceStore.getState().setChartTimeframe('w1', 'D');
    expect(useWorkspaceStore.getState().chartRuntime.w1?.hogaplaySource).toBe(false);
  });

  // fresh-view(#711): 종목이 바뀌면 창의 비영속 런타임이 통째로 걷힌다. 그 규칙에
  // 이 플래그가 실제로 실려 있는지 — 안 실리면 이전 종목의 소스 선택이 새 종목으로 샌다.
  it('종목 교체가 플래그를 걷는다', () => {
    seedChart('1m');
    useWorkspaceStore.getState().setChartHogaplaySource('w1', true);
    useWorkspaceStore.getState().setGroupSymbol(1, { code: '000660', name: 'SK하이닉스' });
    expect(useWorkspaceStore.getState().chartRuntime.w1?.hogaplaySource ?? false).toBe(false);
  });

  it('차트가 아닌 창·없는 창은 무시한다', () => {
    useWorkspaceStore.setState({ windows: [book('b1', 1)], zOrder: ['b1'], groupSymbols: {}, chartRuntime: {} });
    useWorkspaceStore.getState().setChartHogaplaySource('b1', true);
    useWorkspaceStore.getState().setChartHogaplaySource('nope', true);
    expect(useWorkspaceStore.getState().chartRuntime).toEqual({});
  });
});
