import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { PatternSearchRequest, PatternSearchResponse } from '../api/screener';

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
vi.mock('../api/screener', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/screener')>()),
  searchPattern: (body: PatternSearchRequest) => searchPattern(body),
}));

const jump = vi.fn();
vi.mock('../live/useJumpToLive', () => ({
  useJumpToLive: () => jump,
  wantsNewTab: () => false,
}));

const focusSavedRange = vi.fn();
// ★ 가변이다. 기준 고정은 "activeCode 가 바뀌어도 목록이 그대로" 로만 관찰되므로
//   고정 mock 이면 그 가드가 아무것도 증명하지 못한다.
const live = { activeCode: '005930', activeInstrument: { label: '삼성전자' }, focusSavedRange };
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: unknown) => unknown) => sel(live),
}));

const setChartTimeframe = vi.fn();
// 실제 워크스페이스의 모양을 그대로 흉내낸다 — **zOrder 마지막이 차트가 아닌** 창이고
// (브라우저에서 실제로 그랬다) 그 위에 같은 그룹의 차트 창이 있다.
const WS = {
  setChartTimeframe,
  zOrder: ['chart1', 'book1', 'broker1'],
  windows: [
    { id: 'chart1', kind: 'chart', group: 1 },
    { id: 'book1', kind: 'book', group: 1 },
    { id: 'broker1', kind: 'broker', group: 1 },
  ],
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
    query: { length, from_date: '20260824', to_date: '20260901', bars: BARS(length) },
    universe: 800 + length,
    dist: { p50: 0.38, p95: 0.75, p99: 0.83, p99_99: opts.history ? 0.87 : null, sample: 801 },
    matches: [
      {
        code: '000660', name: topName, from_date: '20180307', to_date: '20180315',
        corr: 0.986, bars: BARS(length),
        tail: opts.history ? [101, 103, 99] : null,
        forward_pct: opts.history ? 7.4 : null,
      },
      {
        code: '004710', name: '한솔테크닉스', from_date: '20240529', to_date: '20240607',
        corr: 0.897, bars: BARS(length),
        tail: opts.history ? [98, 97, 95] : null,
        forward_pct: opts.history ? -17.5 : null,
      },
      {
        code: '019010', name: '베뉴지', from_date: '20210708', to_date: '20210716',
        corr: 0.83, bars: BARS(length),
        tail: opts.history ? [100, 100, 99] : null,
        forward_pct: opts.history ? -1 : null,
      },
      {
        code: '039840', name: '디오', from_date: '20001219', to_date: '20010103',
        corr: 0.81, bars: BARS(length),
        tail: opts.history ? [] : null,
        // 계열 끝이라 이후가 없다 — 요약 표본에서 **빠져야** 한다(0 으로 세면 안 된다).
        forward_pct: null,
      },
    ],
    baseline: opts.history
      ? { fwd_median_pct: -1.7, fwd_win_rate_pct: 43.9, sample: 3_132_838 }
      : null,
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
  focusSavedRange.mockReset();
  setChartTimeframe.mockReset();
  live.activeCode = '005930';
  live.activeInstrument = { label: '삼성전자' };
  usePatternQueryStore.setState({ pending: null });
  searchPattern.mockImplementation(async (body) =>
    body.mode === 'history'
      ? { code: '005930', name: '삼성전자', mode: 'history',
          results: [lengthResult(body.lengths[0], 'SK하이닉스', { history: true })] }
      : { code: '005930', name: '삼성전자', mode: 'now',
          results: body.lengths.map((n) => lengthResult(n, `길이${n}위`)) },
  );
});

describe('PatternDrawer', () => {
  it('now 는 봉수 전 범위를 한 요청에 받는다 — 스크럽이 로컬 전환이 되는 전제', async () => {
    renderDrawer();
    await screen.findByText('길이7위');
    expect(searchPattern).toHaveBeenCalledTimes(1);
    expect(searchPattern.mock.calls[0][0].lengths.length).toBeGreaterThan(1);
  });

  it('봉수를 바꿔도 다시 요청하지 않고 결과만 갈린다', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('길이7위');
    await user.click(screen.getByLabelText('봉수 늘리기'));
    expect(await screen.findByText('길이8위')).toBeInTheDocument();
    // ★ 이 단언이 이 기능의 UX 근거다 — 요청이 늘면 스테퍼는 스크럽이 아니라 폼이 된다.
    expect(searchPattern).toHaveBeenCalledTimes(1);
    expect(screen.getByText('8봉')).toBeInTheDocument();
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
      code: '005930', name: '삼성전자', mode: 'now',
      results: [{ ...lengthResult(7, 'x'), matches: [] }],
    });
    renderDrawer();
    expect(await screen.findByText('조건에 맞는 매치가 없다.')).toBeInTheDocument();
  });

  it('그 봉수를 채울 이력이 없으면 그렇게 말한다', async () => {
    searchPattern.mockResolvedValue({
      code: '005930', name: '삼성전자', mode: 'now', results: [],
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
