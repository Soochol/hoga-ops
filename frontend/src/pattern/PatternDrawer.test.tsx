import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { PatternSearchRequest, PatternSearchResponse } from '../api/screener';
import { DEFAULT_CONDITIONS } from './patternConditions';

/**
 * 패턴 드로어가 지키는 계약.
 *
 * 이 파일이 닫는 방향 — 셋 다 **실측이 근거**라 UI 취향으로 되돌리면 안 되는 것들이다:
 * * 봉수 스테퍼가 **네트워크 없이** 결과를 바꾼다(now 가 길이를 묶어 받는 이유).
 * * 베이스라인 줄이 과거 탭에서 **항상** 그려진다(끌 수 있는 표시가 아니다).
 * * 매치 요약이 **중앙값**이다 — 베이스라인이 중앙값이라 평균을 쓰면 두 줄의 축이 갈린다.
 *
 * 못 보는 것: 캔들 **모양**의 정확성은 여기서 안 잰다(SVG 경로는 CandleThumb 의 몫).
 */

const searchPattern = vi.fn<(body: PatternSearchRequest) => Promise<PatternSearchResponse>>();
const listPatternSaves = vi.fn();
const createPatternSave = vi.fn();
const deletePatternSave = vi.fn();
vi.mock('../api/screener', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/screener')>()),
  searchPattern: (body: PatternSearchRequest) => searchPattern(body),
  listPatternSaves: () => listPatternSaves(),
  createPatternSave: (b: unknown) => createPatternSave(b),
  deletePatternSave: (id: string) => deletePatternSave(id),
}));

const SAVE_RECENT = {
  id: 'r1', name: '삼성전자 · 최근 7봉', code: '005930', stock_name: '삼성전자',
  window: { kind: 'recent' as const, bars: 10, from_date: null, to_date: null },
  conditions: {
    // ★ 모든 값이 **공장값과 달라야** 복원을 실제로 잰다 — 같으면 복원 코드를 지워도
    //   테스트가 통과한다. 공장값이 100개·50억·±2봉으로 바뀐 2026-09-02 에 실제로 겹쳤고,
    //   `flex_bars` 는 **두 PR 이 합쳐지면서** 겹쳤다(한쪽이 2 를 픽스처로, 다른 쪽이
    //   2 를 공장값으로 만들었다) — 각자는 초록이었다.
    mode: 'history' as const, since: null, count: 40, sim_floor: 0.9,
    min_tv_eok: 10, exclude_etf: false, no_overlap: false, per_code: 3, volume_weight: 0.3,
    ma_preset: 'mid' as const, flex_bars: 0,
  },
  // ★ 이 저장은 **제외를 하나 들고 있다** — 불러오기가 그것까지 가져오는지 잰다.
  excluded: [{ code: '000660', from_date: '20180307', stock_name: 'SK하이닉스' }],
  created_at_ms: 1, updated_at_ms: 1,
};
const SAVE_FIXED = {
  id: 'f1', name: 'abcd', code: '000660', stock_name: 'SK하이닉스',
  window: { kind: 'fixed' as const, bars: null, from_date: '20180307', to_date: '20180315' },
  conditions: {
    mode: 'history' as const, since: '20230101', count: 20, sim_floor: 0,
    min_tv_eok: 10, exclude_etf: true, no_overlap: true, per_code: 5, volume_weight: 0,
    // ★ **이평·유연 축이 없던 시절의 저장**이다(실제 사용자 파일이 그랬다).
    //   두 키가 아예 없으므로 불러오면 공장값을 따라야 한다.
    ma_preset: null, flex_bars: null,
  },
  excluded: [],
  created_at_ms: 2, updated_at_ms: 2,
};

/** 이평을 **일부러 끈** 저장. 부재(`null`)와 구별되는지가 이 픽스처의 존재 이유다. */
const SAVE_MA_OFF = {
  id: 'o1', name: '이평 끈 검색', code: '005930', stock_name: '삼성전자',
  window: { kind: 'recent' as const, bars: 7, from_date: null, to_date: null },
  conditions: {
    mode: 'history' as const, since: null, count: 20, sim_floor: 0,
    min_tv_eok: 10, exclude_etf: true, no_overlap: true, per_code: 1, volume_weight: 0,
    ma_preset: 'off' as const, flex_bars: 0,
  },
  excluded: [],
  created_at_ms: 3, updated_at_ms: 3,
};

const jump = vi.fn();
// ★ 가변이다. 「새 탭이면 표식을 세우지 않는다」 는 이 술어가 참인 경로에서만 관찰된다.
let newTab = false;
vi.mock('../live/useJumpToLive', () => ({
  useJumpToLive: () => jump,
  wantsNewTab: () => newTab,
}));

const focusSavedRange = vi.fn();
// ★ 가변이다. 기준 고정은 "activeCode 가 바뀌어도 목록이 그대로" 로만 관찰되므로
//   고정 mock 이면 그 가드가 아무것도 증명하지 못한다.
const live = { activeCode: '005930', activeInstrument: { label: '삼성전자' }, focusSavedRange };
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: unknown) => unknown) => sel(live),
  // 순수 술어라 모의할 이유가 없다 — 실제와 **같은 판정**을 준다(분 단위 봉은 전부 `<n>m`).
  isMinuteTimeframe: (tf: string) => /^\d+m$/.test(tf),
}));

const setChartTimeframe = vi.fn();
// 실제 워크스페이스의 모양을 그대로 흉내낸다 — **zOrder 마지막이 차트가 아닌** 창이고
// (브라우저에서 실제로 그랬다) 그 위에 같은 그룹의 차트 창이 있다.
const extendChartHistoricalRange = vi.fn();
const WS = {
  setChartTimeframe,
  extendChartHistoricalRange,
  zOrder: ['chart1', 'book1', 'broker1'],
  // ★ `chart.timeframe` 이 있어야 한다 — 착지 창 선택이 **캘린더 봉인지**를 보기 때문이다.
  //   분봉 창을 골라 일봉으로 갈아엎던 것이 사용자 신고였다(2026-09-02).
  windows: [
    { id: 'chart1', kind: 'chart', group: 1, chart: { timeframe: 'D' } },
    { id: 'book1', kind: 'book', group: 1 },
    { id: 'broker1', kind: 'broker', group: 1 },
  ] as { id: string; kind: string; group: number; chart?: { timeframe: string } }[],
};
vi.mock('../state/workspace', () => ({
  useWorkspaceStore: { getState: () => WS },
  // 종목 교체의 목적지는 kind 를 보지 않는다 — 그래서 거래원 창이 나온다.
  activationTarget: () => ({ kind: 'window', window: { id: 'broker1', group: 1 } }),
}));

const { usePatternQueryStore } = await import('./patternQuery');

const { PatternDrawer } = await import('./PatternDrawer');

const BARS = (n: number) => Array.from({ length: n }, (_, i) => [100 + i, 104 + i, 98 + i, 102 + i]);

function lengthResult(length: number, topName: string, opts: { history?: boolean } = {}) {
  return {
    length,
    query: { length, from_date: '20260824', to_date: '20260901', bars: BARS(length), ma: null },
    ma_periods: [],
    universe: 800 + length,
    dist: { p50: 0.38, p95: 0.75, p99: 0.83, p99_99: opts.history ? 0.87 : null, sample: 801 },
    matches: [
      {
        code: '000660', name: topName, from_date: '20180307', to_date: '20180315',
        corr: 0.986, bars: BARS(length),
        tail: opts.history ? [101, 103, 99] : null,
        forward_pct: opts.history ? 7.4 : null,
        ma: null,
      },
      {
        code: '004710', name: '한솔테크닉스', from_date: '20240529', to_date: '20240607',
        corr: 0.897, bars: BARS(length),
        tail: opts.history ? [98, 97, 95] : null,
        forward_pct: opts.history ? -17.5 : null,
        ma: null,
      },
      {
        code: '019010', name: '베뉴지', from_date: '20210708', to_date: '20210716',
        corr: 0.83, bars: BARS(length),
        tail: opts.history ? [100, 100, 99] : null,
        forward_pct: opts.history ? -1 : null,
        ma: null,
      },
      {
        code: '039840', name: '디오', from_date: '20001219', to_date: '20010103',
        corr: 0.81, bars: BARS(length),
        tail: opts.history ? [] : null,
        // 계열 끝이라 이후가 없다 — 요약 표본에서 **빠져야** 한다(0 으로 세면 안 된다).
        forward_pct: null,
        ma: null,
      },
    ],
    baseline: opts.history
      ? { fwd_median_pct: -1.7, fwd_win_rate_pct: 43.9, sample: 3_132_838 }
      : null,
    // 일봉 목업이라 null 이다 — 주봉의 미완성 마지막 봉에서만 값이 있다.
    partial_last_bucket_days: null,
    elapsed_ms: opts.history ? 421 : 14,
  };
}

let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** 리렌더가 **같은 QueryClient** 를 유지해야 "재검색이 없었다" 를 잴 수 있다. */
function Wrapper() {
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PatternDrawer />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function renderDrawer() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<Wrapper />);
}

beforeEach(() => {
  searchPattern.mockReset();
  jump.mockReset();
  newTab = false;
  // ★ 진짜 `useJumpToLive` 는 `activateLiveCode` 로 activeCode 를 옮긴다. 그 한 걸음이
  //   빠지면 「눌린 행에 표식」 이 **원리적으로 양성이 될 수 없다** — 선택 표식이
  //   activeCode 게이트를 지나기 때문(목록 밖에서 종목이 바뀌면 표식이 거짓말이 된다).
  jump.mockImplementation((code: string) => {
    if (!newTab) live.activeCode = code;
  });
  focusSavedRange.mockReset();
  setChartTimeframe.mockReset();
  extendChartHistoricalRange.mockReset();
  live.activeCode = '005930';
  live.activeInstrument = { label: '삼성전자' };
  // ★ 워크스페이스는 **모듈 지역 객체**라 테스트가 고치면 다음 테스트로 샌다.
  WS.zOrder = ['chart1', 'book1', 'broker1'];
  WS.windows = [
    { id: 'chart1', kind: 'chart', group: 1, chart: { timeframe: 'D' } },
    { id: 'book1', kind: 'book', group: 1 },
    { id: 'broker1', kind: 'broker', group: 1 },
  ];
  listPatternSaves.mockReset();
  createPatternSave.mockReset();
  deletePatternSave.mockReset();
  listPatternSaves.mockResolvedValue({
    schema_version: 1, saves: [SAVE_RECENT, SAVE_FIXED, SAVE_MA_OFF],
  });
  createPatternSave.mockResolvedValue({ ...SAVE_RECENT, id: 'new' });
  deletePatternSave.mockResolvedValue(undefined);
  usePatternQueryStore.setState({ pending: null });
  searchPattern.mockImplementation(async (body) =>
    body.mode === 'history'
      ? { code: '005930', name: '삼성전자', mode: 'history', timeframe: 'D',
          results: [lengthResult(body.lengths[0], 'SK하이닉스', { history: true })] }
      : { code: '005930', name: '삼성전자', mode: 'now', timeframe: 'D',
          results: body.lengths.map((n) => lengthResult(n, `길이${n}위`)) },
  );
});

describe('PatternDrawer', () => {
  /** 「길이 고정」으로 되돌린다 — 공장값이 ±2봉이라 스크럽 전제가 **기본 상태에서는
   *  성립하지 않는다**(유연이 켜지면 길이 하나만 보내므로 봉수마다 재검색이다). */
  async function fixLength(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /길이 ±2봉/ }));
    await user.click(await screen.findByRole('option', { name: '길이 고정' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /길이 고정/ })).toBeInTheDocument());
  }

  it('길이 고정이면 now 가 봉수 전 범위를 한 요청에 받는다 — 스크럽이 로컬 전환이 되는 전제', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await fixLength(user);
    expect(searchPattern.mock.calls.at(-1)![0].lengths.length).toBeGreaterThan(1);
  });

  it('길이 고정이면 봉수를 바꿔도 다시 요청하지 않고 결과만 갈린다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await fixLength(user);
    const before = searchPattern.mock.calls.length;
    await user.click(screen.getByLabelText('봉수 늘리기'));
    expect(await screen.findByText('길이8위')).toBeInTheDocument();
    // ★ 이 단언이 이 기능의 UX 근거다 — 요청이 늘면 스테퍼는 스크럽이 아니라 폼이 된다.
    expect(searchPattern).toHaveBeenCalledTimes(before);
    expect(screen.getByText('8봉')).toBeInTheDocument();
  });

  it('공장값(±2봉)에서는 봉수가 서버 왕복이다 — 유연과 스크럽은 곱할 수 없는 축이다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    expect(searchPattern.mock.calls[0][0].lengths).toEqual([7]);
    const before = searchPattern.mock.calls.length;
    await user.click(screen.getByLabelText('봉수 늘리기'));
    // 유연은 길이 하나만 보내므로 응답이 기준 ±2 뿐이다 — 스크럽이 그 밖으로 나가면
    // 재검색이 **나야 한다**. 안 나면 화면이 조용히 빈다(공장값이 ±2 라 늘 걸린다).
    await vi.waitFor(() =>
      expect(searchPattern.mock.calls.length).toBeGreaterThan(before));
    expect(searchPattern.mock.calls.at(-1)![0].lengths).toEqual([8]);
  });

  it('봉수는 서버 한계에서 멈춘다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    for (let i = 0; i < 4; i += 1) await user.click(screen.getByLabelText('봉수 줄이기'));
    expect(screen.getByText('5봉')).toBeInTheDocument();
    expect(screen.getByLabelText('봉수 줄이기')).toBeDisabled();
  });

  it('과거 탭은 길이 하나만 요청한다 — 길이당 비용이 30배다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await screen.findByText('SK하이닉스');
    const last = searchPattern.mock.calls.at(-1)![0];
    expect(last.mode).toBe('history');
    expect(last.lengths).toEqual([7]);
  });

  it('과거 탭은 베이스라인을 항상 그린다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    expect(await screen.findByText('전체 구간 베이스라인')).toBeInTheDocument();
    expect(screen.getByText(/-1\.7% · 승률 44%/)).toBeInTheDocument();
  });

  it('매치 요약은 중앙값이고, 이후가 없는 매치는 표본에서 뺀다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    // forward_pct 는 [7.4, -17.5, -1, null] → 표본 **3개**, 중앙값 **-1.0**, 승률 33%.
    // ★ 표본이 짝수면 평균과 중앙값이 같아져 이 단언이 평균 구현도 통과시킨다 —
    //   그래서 홀수로 만들었다(평균이었다면 -3.7 이라 아래 단언이 빨개진다).
    expect(await screen.findByText('매치 상위 3개')).toBeInTheDocument();
    expect(screen.getByText(/-1\.0% · 승률 33%/)).toBeInTheDocument();
  });

  it('행을 누르면 그 종목으로 간다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    const row = await screen.findByText('길이7위');
    await user.click(row);
    expect(jump).toHaveBeenCalledWith('000660', '길이7위', expect.anything());
  });

  it('유사도 숫자 옆에 분포 위 위치가 함께 그려진다', async () => {
    renderDrawer();
    await screen.findByText('길이7위');
    // 절대값만 보이면 "98.6% 닮음" 으로 오독된다 — 대조군이 라벨에 들어가 있어야 한다.
    const strips = screen.getAllByRole('img', { name: /상위 1%는/ });
    expect(strips.length).toBeGreaterThan(0);
    expect(strips[0]).toHaveAccessibleName(/유사도 0\.986/);
  });

  it('경과 시간과 비교 규모를 함께 보여준다', async () => {
    renderDrawer();
    expect(await screen.findByText(/807종목 비교 · 14ms/)).toBeInTheDocument();
  });
});

describe('PatternDrawer — 빈 상태', () => {
  it('매치가 없으면 그렇게 말한다', async () => {
    searchPattern.mockResolvedValue({
      code: '005930', name: '삼성전자', mode: 'now', timeframe: 'D',
      results: [{ ...lengthResult(7, 'x'), matches: [] }],
    });
    renderDrawer();
    // 기본 조건이 「최근 3년」 이므로 빈 목록의 원인을 그 조건으로 지목한다 —
    // 조건이 여럿이면 "없다" 만으로는 어느 손잡이를 돌릴지 알 수 없다.
    expect(await screen.findByText(/이 기간에 닮은 구간이 없다/)).toBeInTheDocument();
  });

  it('그 봉수를 채울 이력이 없으면 그렇게 말한다', async () => {
    searchPattern.mockResolvedValue({
      code: '005930', name: '삼성전자', mode: 'now', timeframe: 'D', results: [],
    });
    renderDrawer();
    expect(await screen.findByText(/7봉을 채울 이력이 없다/)).toBeInTheDocument();
  });

  it('검색이 실패하면 조용히 비우지 않고 알린다', async () => {
    searchPattern.mockRejectedValue(new Error('boom'));
    renderDrawer();
    const state = await screen.findByText(/패턴 검색에 실패했다/);
    expect(within(state).getByText(/boom/)).toBeInTheDocument();
  });
});

describe('PatternDrawer — 차트에서 건네받은 구간', () => {
  it('시드를 1회만 소비한다 — 스테퍼를 만져도 되돌아오지 않는다', async () => {
    const user = userEvent.setup();
    usePatternQueryStore.getState().requestPatternSearch({
      code: '005930', from: '20260401', to: '20260630',
    });
    renderDrawer();
    await screen.findByText(/차트에서 그은 구간/);
    expect(usePatternQueryStore.getState().pending).toBeNull();
    const body = searchPattern.mock.calls.at(-1)![0];
    expect([body.from, body.to]).toEqual(['20260401', '20260630']);

    // ✕ 로 풀면 봉수 스테퍼가 돌아오고, 시드가 그것을 다시 덮지 않는다.
    await user.click(screen.getByLabelText('구간 해제'));
    expect(await screen.findByText('7봉')).toBeInTheDocument();
    expect(screen.queryByText(/차트에서 그은 구간/)).not.toBeInTheDocument();
  });

  it('구간이 없으면 from/to 를 보내지 않는다', async () => {
    renderDrawer();
    await screen.findByText('길이7위');
    const body = searchPattern.mock.calls[0][0];
    expect(body.from).toBeUndefined();
    expect(body.to).toBeUndefined();
  });
});

describe('PatternDrawer — 과거 매치 클릭', () => {
  it('종목을 바꾼 **뒤** 구간을 세운다 — 순서가 계약이다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await user.click(await screen.findByText('SK하이닉스'));

    expect(jump).toHaveBeenCalledWith('000660', 'SK하이닉스', expect.anything());
    expect(focusSavedRange).toHaveBeenCalledTimes(1);
    // ★ 종목 교체가 "종목이 바뀌면 구간 해제" 트리거를 품고 있어, focus 가 먼저면
    //   그 자리에서 지워진다. 호출 순서를 직접 잰다.
    expect(jump.mock.invocationCallOrder[0]).toBeLessThan(
      focusSavedRange.mock.invocationCallOrder[0],
    );
  });

  it('구간 슬롯은 저장뷰와 같은 모양이고 viewId 가 매치마다 다르다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await user.click(await screen.findByText('SK하이닉스'));

    const focus = focusSavedRange.mock.calls[0][0];
    expect(focus.viewId).toBe('pattern:000660:20180307');
    expect(focus.code).toBe('000660');
    expect(focus.savedTimeframe).toBe('D');
    expect(focus.fromDate).toBe('20180307');
    expect(focus.toDate).toBe('20180315');
    // 마지막 봉(09:00 ts)이 밴드 안에 들어야 하므로 toMs 는 **종가 쪽**이다.
    expect(focus.toMs).toBeGreaterThan(focus.fromMs);
    expect(focus.toMs - Date.UTC(2018, 2, 15)).toBe(6.5 * 3600 * 1000);
  });

  it('착지 창을 일봉으로 돌린다 — 분봉 창에 꽂으면 그 날의 분봉이 없어 화면이 빈다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await user.click(await screen.findByText('SK하이닉스'));
    // ★ 거래원 창(activationTarget 의 답)이 아니라 **차트 창**이어야 한다.
    //   id 를 그대로 쓰면 `withChart` 가 조용히 no-op 이 되고 화면이 빈다.
    expect(setChartTimeframe).toHaveBeenCalledWith('chart1', 'D');
  });

  it('매치 구간의 캔들을 **먼저 불러온다** — 없으면 최신 봉으로 폴백한다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await user.click(await screen.findByText('SK하이닉스'));
    // ★ `studyDailyViewport` 는 **이미 로드된** 캔들에서 구간을 찾는다. 2018년 매치를
    //   눌러도 그 봉이 없으면 차트가 최근에 머문다(실측 2025-09).
    expect(extendChartHistoricalRange).toHaveBeenCalledTimes(1);
    const [id, from] = extendChartHistoricalRange.mock.calls[0];
    expect(id).toBe('chart1');
    // 매치 시작일(20180307)보다 **앞**이어야 한다 — 뷰포트가 구간보다 넓게 잡으므로.
    expect(from < '20180307').toBe(true);
  });

  it('지금 탭 클릭은 구간을 세우지 않는다 — 그 종목의 지금이 곧 매치다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByText('길이7위'));
    expect(jump).toHaveBeenCalled();
    expect(focusSavedRange).not.toHaveBeenCalled();
  });
});

describe('PatternDrawer — 기준 종목 고정', () => {
  it('매치를 눌러 화면 종목이 바뀌어도 목록은 그대로다', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDrawer();
    await screen.findByText('길이7위');
    expect(searchPattern).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText('길이7위'));
    // 클릭이 화면 종목을 바꿨다고 치자 — 실제 앱에서 jump 가 하는 일이다.
    live.activeCode = '000660';
    live.activeInstrument = { label: 'SK하이닉스' };
    rerender(<Wrapper />);

    // ★ 기준이 따라갔다면 새 검색이 나간다. 목록이 갈리면 매치를 하나씩 훑을 수 없다.
    expect(searchPattern).toHaveBeenCalledTimes(1);
    expect(searchPattern.mock.calls[0][0].code).toBe('005930');
    expect(await screen.findByText('길이7위')).toBeInTheDocument();
  });

  it('기준과 화면이 갈리면 바꾸는 버튼이 나타난다', async () => {
    const { rerender } = renderDrawer();
    await screen.findByText('길이7위');
    expect(screen.queryByRole('button', { name: /기준을/ })).not.toBeInTheDocument();

    live.activeCode = '000660';
    live.activeInstrument = { label: 'SK하이닉스' };
    rerender(<Wrapper />);
    // 버튼의 **존재 자체**가 "기준과 화면이 다르다" 는 표시를 겸한다.
    expect(screen.getByRole('button', { name: /SK하이닉스/ })).toBeInTheDocument();
  });

  it('그 버튼을 누르면 기준이 옮겨 가고 다시 검색한다', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDrawer();
    await screen.findByText('길이7위');
    live.activeCode = '000660';
    live.activeInstrument = { label: 'SK하이닉스' };
    rerender(<Wrapper />);

    await user.click(screen.getByRole('button', { name: /SK하이닉스/ }));
    await vi.waitFor(() => expect(searchPattern).toHaveBeenCalledTimes(2));
    expect(searchPattern.mock.calls[1][0].code).toBe('000660');
    expect(screen.queryByRole('button', { name: /기준을/ })).not.toBeInTheDocument();
  });

  it('차트에서 그은 구간은 기준도 그 종목으로 옮긴다 — 새 검색이다', async () => {
    live.activeCode = '005930';
    usePatternQueryStore.getState().requestPatternSearch({
      code: '000660', label: 'SK하이닉스', from: '20260401', to: '20260630',
    });
    renderDrawer();
    await screen.findByText(/차트에서 그은 구간/);
    const body = searchPattern.mock.calls.at(-1)![0];
    expect(body.code).toBe('000660');
  });
});

describe('PatternDrawer — 그은 구간은 과거 전체에서 찾는다', () => {
  it('시드가 들어오면 history 모드로 검색한다', async () => {
    usePatternQueryStore.getState().requestPatternSearch({
      code: '005930', from: '20260401', to: '20260630',
    });
    renderDrawer();
    await screen.findByText(/차트에서 그은 구간/);
    // ★ 과거 어느 구간을 긋든 묻는 것은 "이 패턴이 과거 어디에서 또 나왔나" 다.
    //   now 로 두면 그은 구간과 무관한 답(각 종목의 최신 봉)을 낸다.
    const body = searchPattern.mock.calls.at(-1)![0];
    expect(body.mode).toBe('history');
    expect(body.no_overlap).toBe(true);
    expect(await screen.findByRole('button', { name: '과거에 이 모양' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('시드 뒤에도 탭 전환은 살아 있다 — 지금 닮은 종목도 유효한 질문이다', async () => {
    const user = userEvent.setup();
    usePatternQueryStore.getState().requestPatternSearch({
      code: '005930', from: '20260401', to: '20260630',
    });
    renderDrawer();
    await screen.findByText(/차트에서 그은 구간/);
    await user.click(screen.getByRole('button', { name: '지금 닮은 종목' }));
    await vi.waitFor(() =>
      expect(searchPattern.mock.calls.at(-1)![0].mode).toBe('now'));
  });
});

describe('PatternDrawer — 종목당 매치 수', () => {
  it('과거 탭에서만 고를 수 있고 **기본은 나온 자리 전부**다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    expect(screen.queryByRole('button', { name: '나온 자리 전부' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await screen.findByText('SK하이닉스');
    // 「1자리」 가 기본이던 때 "중복이 하나도 없네" 를 겪었다(2026-09-02) — 기본을 뒤집었다.
    expect(searchPattern.mock.calls.at(-1)![0].per_code).toBeGreaterThan(1);
  });

  it('「가장 닮은 1자리」를 고르면 per_code 를 내려 다시 찾는다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await screen.findByText('SK하이닉스');
    await user.click(screen.getByRole('button', { name: '가장 닮은 1자리' }));
    await vi.waitFor(() =>
      expect(searchPattern.mock.calls.at(-1)![0].per_code).toBe(1));
  });
});

describe('PatternDrawer — 조건 칩: 서버와 로컬의 분리', () => {
  /**
   * 이 describe 가 지키는 한 문장: **기간은 후보 모집단을 바꾸고, 유사도 하한과
   * 결과 수는 이미 뽑은 결과를 자른다.**
   *
   * 두 단언의 **대칭**이 가드다 — 기간은 재호출을, 유사도는 재호출 없음을 단언한다.
   * 한쪽만 두면 "전부 서버로" 나 "전부 로컬로" 로 흘러도 침묵한다.
   */
  async function openHistory(user: ReturnType<typeof userEvent.setup>) {
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await screen.findByText('SK하이닉스');
  }

  it('기간을 바꾸면 since 를 실어 **다시 검색한다**', async () => {
    const user = userEvent.setup();
    await openHistory(user);
    const before = searchPattern.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /최근 1년/ }));
    await user.click(screen.getByRole('option', { name: /최근 3년/ }));
    await vi.waitFor(() =>
      expect(searchPattern.mock.calls.length).toBeGreaterThan(before));
    expect(searchPattern.mock.calls.at(-1)![0].since).toMatch(/^\d{8}$/);
  });

  it('전체 기간을 고르면 since 를 보내지 않는다 — 서버가 필터를 아예 안 건다', async () => {
    const user = userEvent.setup();
    await openHistory(user);
    await user.click(screen.getByRole('button', { name: /최근 1년/ }));
    await user.click(screen.getByRole('option', { name: '전체 기간' }));
    await vi.waitFor(() =>
      expect(searchPattern.mock.calls.at(-1)![0].since).toBeUndefined());
  });

  it('유사도 하한을 바꿔도 **다시 검색하지 않는다** — 받아 둔 목록을 자른다', async () => {
    const user = userEvent.setup();
    await openHistory(user);
    const before = searchPattern.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /유사도 전체/ }));
    await user.click(screen.getByRole('option', { name: /0.93 이상/ }));
    // ★ 재호출이 나면 분리가 무너진 것이다.
    expect(searchPattern.mock.calls.length).toBe(before);
    expect(screen.getByRole('button', { name: /유사도 0.93/ })).toBeInTheDocument();
  });

  it('팝오버가 말한 개수와 실제로 그린 행 수가 같다', async () => {
    const user = userEvent.setup();
    await openHistory(user);
    await user.click(screen.getByRole('button', { name: /유사도 전체/ }));
    // 「제한 없음」 항목이 말하는 수를 읽고, 고른 뒤 실제 행을 센다.
    const promised = screen.getByRole('option', { name: /제한 없음/ }).textContent!.match(/(\d+)개/);
    await user.click(screen.getByRole('option', { name: /제한 없음/ }));
    // ★ 행은 `role="button"` 인 div 다(안에 ⋯ 버튼이 있어 버튼 중첩을 못 한다).
    //   태그가 아니라 **행 마커**로 센다.
    const rows = document.querySelectorAll('[data-testid="pattern-drawer"] [data-quote-row]');
    // 미리보기가 거짓말하면 이 세션에서 겪은 "라벨 과장" 이 반복된다.
    expect(rows.length).toBe(Number(promised![1]));
  });

  it('유사도 하한으로 목록이 비면 그 손잡이를 지목한다', async () => {
    const user = userEvent.setup();
    // 기본 픽스처는 0.986 이 있어 0.95 하한으로도 안 빈다 — **아무것도 못 넘는**
    // 목록을 따로 세워야 이 문구가 나오는 조건이 만들어진다.
    const low = lengthResult(7, 'SK하이닉스', { history: true });
    searchPattern.mockResolvedValue({
      code: '005930', name: '삼성전자', mode: 'history', timeframe: 'D',
      results: [{ ...low, matches: low.matches.map((m) => ({ ...m, corr: 0.9 })) }],
    });
    renderDrawer();
    await screen.findByText('SK하이닉스');
    await user.click(screen.getByRole('button', { name: /유사도 전체/ }));
    await user.click(screen.getByRole('option', { name: /0.95 이상/ }));
    expect(await screen.findByText(/유사도 0.95 이상인 구간이 없다/)).toBeInTheDocument();
  });
});

describe('PatternDrawer — 저장', () => {
  it('이름이 기준의 종류를 따라 미리 채워진다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '저장' }));
    // 스테퍼 상태 → 「최근 N봉」. 저장이 거의 원클릭이 되는 자리다.
    expect(screen.getByLabelText('이 검색의 이름')).toHaveValue('삼성전자 · 최근 7봉');
  });

  it('그은 구간이면 날짜가 이름이 된다 — 두 종류가 이름만으로 갈린다', async () => {
    const user = userEvent.setup();
    usePatternQueryStore.getState().requestPatternSearch({
      code: '005930', label: '삼성전자', from: '20260401', to: '20260630',
    });
    renderDrawer();
    await screen.findByText(/차트에서 그은 구간/);
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(screen.getByLabelText('이 검색의 이름')).toHaveValue('삼성전자 · 2026-04-01 ~ 06-30');
  });

  it('저장하면 화면의 조건이 통째로 담긴다 — 결과는 담기지 않는다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '저장' }));
    // 폼이 열리면 「저장」 이 둘이 된다(기준 줄 · 폼 제출) — 제출 버튼만 집는다.
    const submits = screen.getAllByRole('button', { name: '저장' });
    await user.click(submits[submits.length - 1]);
    await vi.waitFor(() => expect(createPatternSave).toHaveBeenCalled());
    const body = createPatternSave.mock.calls[0][0];
    expect(body.window).toEqual({ kind: 'recent', bars: 7, from_date: null, to_date: null });
    expect(body.conditions.count).toBe(100);   // 공장값
    expect(Object.keys(body)).not.toContain('matches');
  });
});

describe('PatternDrawer — 저장 목록과 불러오기', () => {
  async function openSaves(user: ReturnType<typeof userEvent.setup>) {
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: /저장한 검색/ }));
  }

  it('목록은 종목별로 묶이고 이름·종목으로 찾는다', async () => {
    const user = userEvent.setup();
    await openSaves(user);
    // 그룹 헤더는 접기 토글이라 aria-expanded 를 갖는다 — 항목과 구별되는 축이다.
    const groups = await screen.findAllByRole('button', { expanded: true });
    expect(groups.map((g) => g.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('삼성전자'),
                              expect.stringContaining('SK하이닉스')]));

    // 이름이 「abcd」 여도 **종목으로** 찾을 수 있어야 한다(실측: 이름이 성의 없다).
    await user.type(screen.getByLabelText('저장한 검색 찾기'), '하이닉스');
    await vi.waitFor(() =>
      expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1));
    expect(screen.getByText('abcd')).toBeInTheDocument();
    expect(screen.queryByText('삼성전자 · 최근 7봉')).not.toBeInTheDocument();
  });

  it('불러오면 기준과 조건이 함께 복원된다', async () => {
    const user = userEvent.setup();
    await openSaves(user);
    await user.click(await screen.findByTestId('pattern-save-r1'));
    await vi.waitFor(() => expect(searchPattern).toHaveBeenCalledTimes(2));
    const body = searchPattern.mock.calls.at(-1)![0];
    expect(body.code).toBe('005930');
    // ★ **기간도 복원된다.** 이 단언이 없으면 조건 복원을 통째로 지워도 테스트가
    //   통과한다(나머지 값이 우연히 기본과 달라 보이지 않는다) — red-check 으로 확인.
    //   저장이 `since: null`(전체 기간)이므로 기본값 3년이 덮여 사라져야 한다.
    expect(body.since).toBeUndefined();
    expect(body.top).toBe(40);             // 저장된 결과 수(공장값 100 과 다르다)
    expect(body.min_tv_eok).toBe(10);      // 저장된 거래대금(공장값 50 과 다르다)
    expect(body.exclude_etf).toBe(false);
    expect(body.per_code).toBe(3);
    expect(body.volume_weight).toBeGreaterThan(0);
    // 유사도를 바꾸는 조건 둘 — 빠지면 **다른 검색이 복원된다**(공장값 off · 0 과 다르게 저장했다).
    expect(body.ma_preset).toBe('mid');
    expect(body.flex_bars).toBe(0);        // 저장된 유연 폭(공장값 ±2 와 다르다)
  });

  it('고정 구간 저장은 그 날짜로 되돌아간다', async () => {
    const user = userEvent.setup();
    await openSaves(user);
    await user.click(await screen.findByTestId('pattern-save-f1'));
    await vi.waitFor(() => expect(searchPattern).toHaveBeenCalledTimes(2));
    const body = searchPattern.mock.calls.at(-1)![0];
    expect([body.from, body.to]).toEqual(['20180307', '20180315']);
    expect(body.code).toBe('000660');
    // 저장은 날짜가 정본이고 화면은 **상대 기간**만 갖는다 — 그래서 날짜가 그대로
    // 왕복하지 않고 가장 가까운 기간 키로 되돌아간다(설계이지 손실이 아니다).
    expect(body.since).toMatch(/^\d{8}$/);
  });

  it('삭제는 목록에서 바로 한다', async () => {
    const user = userEvent.setup();
    await openSaves(user);
    await user.click(await screen.findByRole('button', { name: /abcd 삭제/ }));
    expect(deletePatternSave).toHaveBeenCalledWith('f1');
  });
});

describe('PatternDrawer — 눌린 행의 표식과 화살표 이동', () => {
  /** 과거 매치 목록을 띄우고 1위 행을 돌려준다(픽스처 순서: SK하이닉스 · 한솔테크닉스
   *  · 베뉴지 · 디오). `beforeEach` 가 이미 검색 모의를 세워 둔다. */
  async function openedList(user: ReturnType<typeof userEvent.setup>) {
    renderDrawer();
    await user.click(await screen.findByRole('button', { name: /과거에 이 모양/ }));
    return await screen.findByRole('button', { name: /SK하이닉스/ });
  }

  it('행을 누르면 그 행에 표식이 선다', async () => {
    const user = userEvent.setup();
    const row = await openedList(user);
    expect(row).not.toHaveAttribute('aria-current');
    await user.click(row);
    expect(screen.getByRole('button', { name: /SK하이닉스/ })).toHaveAttribute('aria-current', 'true');
    // 표식은 배경 틴트만 — 좌측 accent 바를 다시 넣지 말 것(DESIGN.md 리스트 행 규칙).
    expect(screen.getByRole('button', { name: /SK하이닉스/ }).style.background).toContain('tint-selection');
  });

  it('다른 행을 누르면 표식이 그리로 옮겨간다 — 한 번에 하나다', async () => {
    const user = userEvent.setup();
    await user.click(await openedList(user));
    await user.click(screen.getByRole('button', { name: /한솔테크닉스/ }));
    expect(screen.getByRole('button', { name: /SK하이닉스/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: /한솔테크닉스/ })).toHaveAttribute('aria-current', 'true');
  });

  it('새 탭으로 여는 클릭은 표식을 세우지 않는다 — 이 창의 차트가 안 움직인다', async () => {
    const user = userEvent.setup();
    const row = await openedList(user);
    newTab = true;
    await user.click(row);
    expect(screen.getByRole('button', { name: /SK하이닉스/ })).not.toHaveAttribute('aria-current');
  });

  it('새 결과가 오면 표식을 버린다 — 키가 여전히 맞아도', async () => {
    const user = userEvent.setup();
    renderDrawer();
    // `now` 모드. 기준을 바꾸면 새 검색이 돌지만 매치의 code·from_date·length 는
    // **그대로일 수 있다**(전 종목이 같은 날의 최신 창이라서). 그러면 키가 여전히
    // 맞고 차트도 그 종목에 있어 **activeCode 게이트마저 통과한다** — 눌러 본 적 없는
    // 새 결과의 행에 표식이 남는다. 리셋이 유일한 방어다.
    await user.click(await screen.findByRole('button', { name: /길이7위/ }));
    expect(screen.getByRole('button', { name: /길이7위/ })).toHaveAttribute('aria-current', 'true');
    await user.click(await screen.findByRole('button', { name: /기준을/ }));
    expect(await screen.findByRole('button', { name: /길이7위/ })).not.toHaveAttribute('aria-current');
  });

  it('목록 밖에서 종목이 바뀌면 표식이 사라진다 — 차트가 이미 딴 데 있다', async () => {
    const user = userEvent.setup();
    const view = renderDrawer();
    await user.click(await screen.findByRole('button', { name: '과거에 이 모양' }));
    await user.click(await screen.findByRole('button', { name: /SK하이닉스/ }));
    expect(screen.getByRole('button', { name: /SK하이닉스/ })).toHaveAttribute('aria-current', 'true');
    // 헤더 검색·관심종목에서 종목을 바꾼 상황 — **결과 목록은 그대로다.**
    // 진짜 스토어면 구독이 리렌더를 일으키지만 모의는 셀렉터 호출이라 직접 민다.
    live.activeCode = '068270';
    view.rerender(<Wrapper />);
    expect(screen.getByRole('button', { name: /SK하이닉스/ })).not.toHaveAttribute('aria-current');
  });

  it('아래 화살표가 다음 행으로 종목을 옮긴다', async () => {
    const user = userEvent.setup();
    const row = await openedList(user);
    await user.click(row);
    jump.mockClear();
    await user.keyboard('{ArrowDown}');
    expect(jump).toHaveBeenCalledWith('004710', '한솔테크닉스', expect.anything());
    expect(screen.getByRole('button', { name: /한솔테크닉스/ })).toHaveAttribute('aria-current', 'true');
  });

  it('마지막 행에서 아래 화살표는 멈춘다 — 순환하지 않는다', async () => {
    const user = userEvent.setup();
    await openedList(user);
    await user.click(screen.getByRole('button', { name: /디오/ })); // 픽스처의 마지막 매치
    jump.mockClear();
    await user.keyboard('{ArrowDown}');
    expect(jump).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /디오/ })).toHaveAttribute('aria-current', 'true');
  });
});

describe('PatternDrawer — 헤더의 기준 구간도 이동 대상이다', () => {
  it('누르면 기준 종목의 그 구간으로 일봉이 간다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByRole('button', { name: /길이7위/ });
    jump.mockClear();
    await user.click(screen.getByRole('button', { name: /구간으로 차트 이동/ }));
    expect(jump).toHaveBeenCalledWith('005930', '삼성전자', expect.anything());
    // 매치 행과 **같은 경로**를 탄다 — 일봉 전환 · 과거 범위 확장 · 밴드 착석.
    expect(setChartTimeframe).toHaveBeenCalledWith('chart1', 'D');
    expect(extendChartHistoricalRange).toHaveBeenCalled();
    expect(focusSavedRange).toHaveBeenCalledWith(
      expect.objectContaining({ fromDate: '20260824', toDate: '20260901', savedTimeframe: 'D' }),
    );
  });

  it('과거 모드에서도 같은 구간을 가리킨다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole('button', { name: '과거에 이 모양' }));
    await screen.findByRole('button', { name: /SK하이닉스/ });
    jump.mockClear();
    await user.click(screen.getByRole('button', { name: /구간으로 차트 이동/ }));
    // 기준은 매치가 아니라 **내가 그은 구간**이다 — SK하이닉스가 아니라 삼성전자로 간다.
    expect(jump).toHaveBeenCalledWith('005930', '삼성전자', expect.anything());
  });

  it('검색 결과가 없으면 누를 수 없다 — 가리킬 구간이 아직 없다', async () => {
    searchPattern.mockImplementation(() => new Promise(() => {}));
    renderDrawer();
    expect(await screen.findByRole('button', { name: /종목 없음|삼성전자/ })).toBeDisabled();
  });
});

describe('PatternDrawer — 이평 프리셋', () => {
  /** 칩 → 팝오버 → 항목. 칩 이름에는 「▾」가 붙어 있어 정확 매칭으로는 안 잡힌다. */
  /** ⚠ **공장값이 「단기 5·20」이다** — 그걸 다시 고르면 아무것도 재지 못한다(값이 안
   *  바뀌니 재검색도 없다). 프리셋 테스트는 공장값과 **다른** 항목을 골라야 한다. */
  async function pickPreset(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
    // 칩 라벨은 **현재 프리셋의 이름**이라 「이평」으로 시작하지 않을 수 있다
    // (공장값이 short 면 「단기 5·20▾」이다).
    await user.click(screen.getByRole('button', { name: /(이평 끄기|단기 5·20|중기 20·60)/ }));
    // 팝오버 항목은 `role="option"` 이다(리스트박스 의미) — button 이 아니다.
    await user.click(await screen.findByRole('option', { name: label }));
  }

  it('프리셋을 고르면 그 값이 검색 요청에 실린다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await pickPreset(user, /중기 20·60/);
    await vi.waitFor(() =>
      expect(searchPattern.mock.calls.at(-1)?.[0].ma_preset).toBe('mid'),
    );
  });

  it('이평은 서버 조건이다 — 결과를 자르는 것으로 흉내낼 수 없다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    const before = searchPattern.mock.calls.length;
    await pickPreset(user, /이평 끄기/);
    // 유사도 하한처럼 로컬에서 자르는 조건이면 재검색이 없다. 이건 다시 물어야 한다.
    await vi.waitFor(() =>
      expect(searchPattern.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('저장은 이평 프리셋과 유연 폭을 함께 담는다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await pickPreset(user, /중기 20·60/);
    await user.click(screen.getByRole('button', { name: '저장' }));
    const submits = screen.getAllByRole('button', { name: '저장' });
    await user.click(submits[submits.length - 1]);
    await vi.waitFor(() => expect(createPatternSave).toHaveBeenCalled());
    const body = createPatternSave.mock.calls.at(-1)![0];
    expect(body.conditions.ma_preset).toBe('mid');
    // 공장값이 ±2봉이므로 손대지 않으면 그대로 저장된다.
    expect(body.conditions.flex_bars).toBe(2);
  });
});

describe('PatternDrawer — 착지 창은 분봉 창을 갈아엎지 않는다', () => {
  /** zOrder 최상위를 분봉 차트로 바꾼다 — 사용자가 분봉 창을 마지막에 만진 상태다. */
  function withMinuteOnTop() {
    WS.zOrder = ['chart1', 'chartMin'];
    WS.windows = [
      { id: 'chart1', kind: 'chart', group: 1, chart: { timeframe: 'D' } },
      { id: 'chartMin', kind: 'chart', group: 1, chart: { timeframe: '1m' } },
    ];
  }

  it('분봉 창이 위에 있어도 **일봉 창**으로 착지한다', async () => {
    withMinuteOnTop();
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole('button', { name: '과거에 이 모양' }));
    await user.click(await screen.findByRole('button', { name: /SK하이닉스/ }));
    // 분봉 창을 골랐다면 그 창이 일봉으로 갈아엎혔을 것이다(사용자 신고 2026-09-02).
    expect(setChartTimeframe).toHaveBeenCalledWith('chart1', 'D');
    expect(setChartTimeframe).not.toHaveBeenCalledWith('chartMin', 'D');
  });

  it('캘린더 봉 창이 하나도 없으면 봉을 바꾸지 않는다 — 종목만 옮긴다', async () => {
    WS.zOrder = ['chartMin'];
    WS.windows = [{ id: 'chartMin', kind: 'chart', group: 1, chart: { timeframe: '5m' } }];
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole('button', { name: '과거에 이 모양' }));
    await user.click(await screen.findByRole('button', { name: /SK하이닉스/ }));
    expect(jump).toHaveBeenCalledWith('000660', 'SK하이닉스', expect.anything());
    expect(setChartTimeframe).not.toHaveBeenCalled();
    expect(extendChartHistoricalRange).not.toHaveBeenCalled();
  });

  it('패턴 구간은 **일봉 전용**으로 표시된다 — 분봉 창이 이 날짜로 얼면 화면이 빈다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole('button', { name: '과거에 이 모양' }));
    await user.click(await screen.findByRole('button', { name: /SK하이닉스/ }));
    expect(focusSavedRange).toHaveBeenCalledWith(
      expect.objectContaining({ dailyOnly: true, savedTimeframe: 'D' }),
    );
  });
});

describe('PatternDrawer — 저장에 없던 조건은 공장값을 따른다', () => {
  /** 저장 목록을 열고 한 항목을 고른다. */
  async function pick(user: ReturnType<typeof userEvent.setup>, id: string) {
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: /저장한 검색/ }));
    await user.click(await screen.findByTestId(`pattern-save-${id}`));
    await vi.waitFor(() => expect(searchPattern).toHaveBeenCalledTimes(2));
    return searchPattern.mock.calls.at(-1)![0];
  }

  it('그 축이 없던 시절의 저장은 **공장값**으로 되살아난다', async () => {
    // f1 은 이평·유연이 생기기 전 저장이라 두 키가 아예 없다. 「끄기를 골랐다」가
    // 아니므로 새 기능이 자동으로 적용돼야 한다 — 사용자 신고 2026-09-02.
    const body = await pick(userEvent.setup(), 'f1');
    expect(body.ma_preset).toBe(DEFAULT_CONDITIONS.maPreset);
    expect(body.flex_bars).toBe(DEFAULT_CONDITIONS.flexBars);
  });

  it('일부러 끈 저장은 꺼진 채로 복원된다 — 부재와 선택은 다르다', async () => {
    const body = await pick(userEvent.setup(), 'o1');
    expect(body.ma_preset).toBe('off');
    expect(DEFAULT_CONDITIONS.maPreset).not.toBe('off');  // 공장값과 달라야 가드가 산다
  });
});

describe('PatternDrawer — 결과에서 자리 빼기', () => {
  async function openList(user: ReturnType<typeof userEvent.setup>) {
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    return await screen.findByRole('button', { name: /SK하이닉스/ });
  }

  it('⋯ 버튼이 우클릭과 같은 메뉴를 연다 — 우클릭만 두면 터치·키보드에서 못 닿는다', async () => {
    const user = userEvent.setup();
    await openList(user);
    await user.click(screen.getAllByRole('button', { name: /매치 메뉴/ })[0]);
    expect(await screen.findByTestId('pattern-match-row-menu')).toBeInTheDocument();
  });

  it('빼면 그 자리가 목록에서 사라지고 다음 후보가 올라온다', async () => {
    const user = userEvent.setup();
    await openList(user);
    const rows = () => [...document.querySelectorAll('[data-testid="pattern-drawer"] [data-quote-row]')];
    const n = rows().length;
    await user.click(screen.getAllByRole('button', { name: /매치 메뉴/ })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /이 자리만 빼기/ }));
    expect(screen.queryByRole('button', { name: /SK하이닉스/ })).not.toBeInTheDocument();
    // ★ 자르기 **전에** 걸리므로 개수가 유지된다 — 픽스처가 4행뿐이라 하나 줄지만,
    //   중요한 것은 「뺀 행만」 빠졌다는 것이다.
    expect(rows().length).toBe(n - 1);
  });

  it('숨김 칩에서 되돌리면 다시 나온다', async () => {
    const user = userEvent.setup();
    await openList(user);
    await user.click(screen.getAllByRole('button', { name: /매치 메뉴/ })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /이 자리만 빼기/ }));
    await user.click(await screen.findByRole('button', { name: /숨김 1/ }));
    await user.click(await screen.findByRole('option', { name: /SK하이닉스/ }));
    expect(await screen.findByRole('button', { name: /SK하이닉스/ })).toBeInTheDocument();
  });

  it('저장을 불러오면 그 저장의 제외가 함께 온다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: /저장한 검색/ }));
    await user.click(await screen.findByTestId('pattern-save-r1'));
    await vi.waitFor(() => expect(searchPattern).toHaveBeenCalledTimes(2));
    // ★ `loadSave` 가 기준도 덮어쓴다 — 그걸 이펙트로 감시하면 **불러온 그 순간**
    //   연결이 끊겨 제외가 사라진다(그렇게 짰다가 잡았다).
    expect(await screen.findByRole('button', { name: /숨김 1/ })).toBeInTheDocument();
  });
});

describe('PatternDrawer — 종목 통째로 빼기', () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>, i = 0) {
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByRole('button', { name: '과거에 이 모양' }));
    await screen.findByRole('button', { name: /SK하이닉스/ });
    await user.click(screen.getAllByRole('button', { name: /매치 메뉴/ })[i]);
  }

  it('«종목» 전부 빼기는 그 종목의 **모든 자리**를 덮는다', async () => {
    const user = userEvent.setup();
    // 픽스처는 000660 이 한 자리뿐이라, 덮는 범위는 «전체» 키(`code:*`)로 확인한다.
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /SK하이닉스.*전부 빼기/ }));
    expect(screen.queryByRole('button', { name: /SK하이닉스/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /숨김 1/ }));
    // 목록이 **하나**다 — 자리 제외와 종목 제외가 같은 줄에 서고, 「전체」로 구별된다.
    expect(await screen.findByRole('option', { name: /SK하이닉스.*전체/ })).toBeInTheDocument();
  });

});

describe('PatternDrawer — 길이 유연 병합 경로의 제외', () => {
  /**
   * 공장값이 ±2봉이라 **이 경로가 기본**인데, 서버 모의가 길이 하나만 주면 병합이 안 돌아
   * 다른 테스트는 전부 단일 결과 경로를 잰다. 그래서 제외 필터를 한쪽에만 걸어도 초록이
   * 나왔고, 브라우저에서야 「숨김 1인데 목록에 그대로」로 드러났다.
   */
  beforeEach(() => {
    searchPattern.mockImplementation(async () => ({
      code: '005930', name: '삼성전자', mode: 'history' as const, timeframe: 'D' as const,
      results: [
        lengthResult(6, 'SK하이닉스', { history: true }),
        lengthResult(7, 'SK하이닉스', { history: true }),
      ],
    }));
  });

  it('종목 전체 제외가 병합된 목록의 **여러 자리를 한 번에** 덮는다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole('button', { name: '과거에 이 모양' }));
    // 두 길이가 병합돼 같은 종목이 여러 행으로 선다 — 그게 이 경로의 특징이다.
    const before = await screen.findAllByRole('button', { name: /SK하이닉스/ });
    expect(before.length).toBeGreaterThan(1);
    await user.click(screen.getAllByRole('button', { name: /매치 메뉴/ })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /전부 빼기/ }));
    expect(screen.queryAllByRole('button', { name: /SK하이닉스/ })).toHaveLength(0);
  });

  it('자리만 빼면 같은 종목의 **다른 길이는 남는다** — 두 항목의 차이가 여기서 보인다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(await screen.findByRole('button', { name: '과거에 이 모양' }));
    const before = (await screen.findAllByRole('button', { name: /SK하이닉스/ })).length;
    await user.click(screen.getAllByRole('button', { name: /매치 메뉴/ })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /이 자리만 빼기/ }));
    // 같은 (종목, 시작일)은 길이가 달라도 함께 빠진다 — 키에 길이가 없기 때문이다.
    // 시작일이 다른 자리는 남는다.
    expect(screen.queryAllByRole('button', { name: /SK하이닉스/ }).length).toBeLessThan(before);
  });
});
