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

vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: unknown) => unknown) =>
    sel({ activeCode: '005930', activeInstrument: { label: '삼성전자' } }),
}));

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

function renderDrawer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PatternDrawer />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  searchPattern.mockReset();
  jump.mockReset();
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
