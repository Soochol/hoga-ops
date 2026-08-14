import { render, screen, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { LiveQuote } from '../api/liveQuotes';

// 그룹 2개 × 종목 2개 — 그룹 순서와 그룹 내 행 순서를 **한 번의 코드 나열**로 잰다.
const BASE_DATA = {
  folders: [
    { id: 'f1', name: '반도체', order: 0 },
    { id: 'f2', name: '이차전지', order: 1 },
  ],
  entries: [
    { code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 },
    { code: '000660', name: 'SK하이닉스', folder_id: 'f1', order: 1 },
    { code: '373220', name: 'LG에너지솔루션', folder_id: 'f2', order: 0 },
    { code: '006400', name: '삼성SDI', folder_id: 'f2', order: 1 },
  ],
};

vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  getHeatmap: vi.fn(() => Promise.resolve(BASE_DATA)),
}));

vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useLiveQuoteOverlay: vi.fn(),
}));

const { useLiveStatusMock } = vi.hoisted(() => ({ useLiveStatusMock: vi.fn() }));
vi.mock('../api/liveStatus', async (orig) => ({
  ...(await orig<typeof import('../api/liveStatus')>()),
  useLiveStatus: useLiveStatusMock,
}));

vi.mock('../live/liveNavigate', () => ({
  activateLiveCode: vi.fn(),
  activateLiveInstrument: vi.fn(),
  openLiveInNewTab: vi.fn(),
}));

import { Heatmap } from './Heatmap';
import { useLiveQuoteOverlay } from '../api/liveQuotes';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { SORT_THROTTLE_MS } from '../heatmap/heat';
import { HEATMAP_KEY } from '../heatmap/heatmapKeys';

function quotes(byCode: Record<string, number>): Map<string, LiveQuote> {
  return new Map(Object.entries(byCode).map(([code, pct]) => [
    code, { code, price: 10_000, change_pct: pct, change_won: 0 } as LiveQuote,
  ]));
}

/** f2(+7% 평균)가 f1(+1.5%)보다 위. 각 그룹 안도 등락률 내림차순. */
const INITIAL = quotes({ '005930': -2, '000660': 5, '373220': 8, '006400': 6 });
/** 그룹 순서와 행 순서가 **둘 다** 뒤집히는 시세 — f1(+15%)이 f2(+1.5%)를 앞선다. */
const FLIPPED = quotes({ '005930': 20, '000660': 10, '373220': 1, '006400': 2 });

const INITIAL_ORDER = ['373220', '006400', '000660', '005930'];
const FLIPPED_ORDER = ['005930', '000660', '006400', '373220'];

function setQuotes(byCode: Map<string, LiveQuote>) {
  vi.mocked(useLiveQuoteOverlay).mockReturnValue({
    quoteByCode: byCode, phase: 'open', dataUpdatedAt: 0,
  } as ReturnType<typeof useLiveQuoteOverlay>);
}

/** 보드에 그려진 종목 코드를 화면 순서대로. 그룹 순서 × 행 순서의 합성 결과다. */
function codeOrder(): string[] {
  return within(screen.getByTestId('heatmap-board'))
    .getAllByTestId(/^heatmap-row-/)
    .map((n) => n.getAttribute('data-testid')!.replace('heatmap-row-', ''));
}

describe('히트맵 정렬 스로틀 (SORT_THROTTLE_MS)', () => {
  beforeEach(() => {
    // 그룹·행 모두 등락률 내림차순 — 스로틀이 관측되는 유일한 모드 조합.
    useHeatmapPrefsStore.setState({ sortMode: 'desc', groupSort: 'desc' });
    Element.prototype.scrollIntoView = vi.fn();
    useLiveStatusMock.mockClear();
    setQuotes(INITIAL);
  });
  afterEach(() => {
    if (vi.isFakeTimers()) { vi.runOnlyPendingTimers(); vi.useRealTimers(); }
  });

  /** 데이터 로드까지는 real timer 로 끝내고, 그 뒤 fake timer 로 창을 제어한다.
   *  이어서 시세를 한 번 바꿔 leading edge 를 소비한다 — 그래야 다음 변화가 창 **안**이다. */
  async function renderAndOpenWindow() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>,
    );
    await screen.findByTestId('heatmap-board');
    expect(codeOrder()).toEqual(INITIAL_ORDER);
    vi.useFakeTimers();
    // leading 소비: 마운트는 창을 열지 않으므로 **첫 갱신**이 즉시 통과하며 거기서 창이
    // 열린다. 값은 그대로 두고 Map 참조만 새로 만든다 — WS 틱 flush 가 매번 새 Map 을
    // 내는 실제 리듬과 같다(같은 참조를 넘기면 훅이 창을 열지 않는 게 정상 동작이다).
    setQuotes(new Map(INITIAL));
    act(() => { view.rerender(
      <QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>,
    ); });
    return { qc, rerender: () => act(() => { view.rerender(
      <QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>,
    ); }) };
  }

  it('창 안에서는 시세가 뒤집혀도 그룹·행 순서가 그대로다', async () => {
    const { rerender } = await renderAndOpenWindow();
    setQuotes(FLIPPED);
    rerender();
    expect(codeOrder()).toEqual(INITIAL_ORDER); // 자리는 아직 안 움직인다
  });

  it('창이 닫히면 최신 시세 기준 순서로 한 번에 커밋된다', async () => {
    const { rerender } = await renderAndOpenWindow();
    setQuotes(FLIPPED);
    rerender();
    act(() => { vi.advanceTimersByTime(SORT_THROTTLE_MS); });
    expect(codeOrder()).toEqual(FLIPPED_ORDER);
  });

  it('창 안 갱신이 여러 번이어도 커밋은 **최신값 한 번**뿐', async () => {
    const { rerender } = await renderAndOpenWindow();
    // 중간 시세들(순서를 이리저리 흔드는 값)이 화면에 반영되지 않아야 한다.
    for (const q of [
      quotes({ '005930': 30, '000660': 1, '373220': 2, '006400': 3 }),
      quotes({ '005930': 1, '000660': 2, '373220': 30, '006400': 3 }),
      FLIPPED,
    ]) {
      setQuotes(q);
      rerender();
      expect(codeOrder()).toEqual(INITIAL_ORDER);
    }
    act(() => { vi.advanceTimersByTime(SORT_THROTTLE_MS); });
    expect(codeOrder()).toEqual(FLIPPED_ORDER); // 마지막 값으로만 착지
  });

  it('창 안에서도 **표시값**은 즉시 갱신된다 — 얼린 건 자리뿐', async () => {
    const { rerender } = await renderAndOpenWindow();
    expect(screen.getByTestId('heatmap-row-005930').textContent).toContain('-2.00');
    setQuotes(FLIPPED);
    rerender();
    expect(screen.getByTestId('heatmap-row-005930').textContent).toContain('+20.00');
    expect(codeOrder()).toEqual(INITIAL_ORDER); // 숫자는 새 값, 자리는 아직 옛 순서
  });

  it('창 안에서도 그룹·종목의 **추가/삭제**는 즉시 보인다', async () => {
    // 얼린 대상이 결과 배열이 아니라 정렬 키라는 설계의 red-check.
    // 배열을 얼렸다면 삭제된 그룹이 최대 SORT_THROTTLE_MS 동안 화면에 남는다.
    const { qc, rerender } = await renderAndOpenWindow();
    setQuotes(FLIPPED); // 창 안 — 정렬 키는 갇힌 상태
    rerender();
    act(() => {
      qc.setQueryData(HEATMAP_KEY, {
        folders: [BASE_DATA.folders[0]],
        entries: BASE_DATA.entries.filter((e) => e.folder_id === 'f1'),
      });
      // React Query 의 구독자 알림은 setTimeout(0) 배치라 fake timer 아래선 직접
      // 흘려줘야 한다. 0ms 는 스로틀 창(SORT_THROTTLE_MS)을 열지 않으므로, 아래
      // 단언에서 f1 의 행 순서가 옛 키를 유지하는 것이 곧 스로틀 생존의 증거다.
      vi.advanceTimersByTime(0);
    });
    expect(codeOrder()).toEqual(['000660', '005930']); // f2 즉시 사라짐, f1 순서는 유지
    expect(screen.queryByTestId('heatmap-row-373220')).toBeNull();
  });
});
