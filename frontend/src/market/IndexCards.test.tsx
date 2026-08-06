/** 지수 카드의 현물↔선물 토글.
 *
 * **주 회귀 가드 둘.**
 *
 * ① **localStorage 병합.** 카드마다 `useCardMode` 인스턴스가 따로라, 저장할 때
 *    마운트 시점 스냅샷을 쓰면 마지막에 누른 카드가 다른 카드의 선택을 덮어쓴다.
 *    증상이 "가끔 하나만 풀린다" 라서 눈으로는 잡기 어렵다.
 *
 * ② **낡음 배지.** KIS REST 는 야간장 중에도 주간 마감 스냅샷(15:45 동결)을 준다.
 *    `session !== dataSession` 을 화면이 말하지 않으면 밤 11시에 6시간 전 값을
 *    실시간으로 읽는다.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { IndexCards } from './MarketPage';

const SPOT_QUOTES = [
  { id: 'KOSPI', label: 'KOSPI', value: 6296.38, change: -301.88, change_rate: -4.58, t_ms: 1 },
  { id: 'KOSDAQ', label: 'KOSDAQ', value: 801.67, change: 2.08, change_rate: 0.26, t_ms: 1 },
  { id: 'KOSPI200', label: 'KOSPI 200', value: 982.92, change: -55.67, change_rate: -5.36, t_ms: 1 },
  { id: 'KOSDAQ150', label: 'KOSDAQ 150', value: 1371.62, change: 9.87, change_rate: 0.72, t_ms: 1 },
];

function futuresQuote(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'KOSPI200_F',
    underlying_id: 'KOSPI200',
    label: 'KOSPI 200 F',
    code: 'A01609',
    expiry: '202609',
    days_left: 36,
    last_trade_date: '20260910',
    value: 981.15,
    change: -60.9,
    change_rate: -5.84,
    prev_close: 1042.05,
    volume: 123714,
    open_interest: 159288,
    oi_change: -1469,
    market_basis: -1.77,
    disparity: -0.4,
    data_session: 'day',
    t_ms: 1,
    ...over,
  };
}

const KOSDAQ150_F = futuresQuote({
  id: 'KOSDAQ150_F',
  underlying_id: 'KOSDAQ150',
  label: 'KOSDAQ 150 F',
  code: 'A06609',
  value: 1365.8,
  change: -0.6,
  change_rate: -0.04,
  market_basis: -5.82,
});

const VKOSPI_F = futuresQuote({
  id: 'VKOSPI_F',
  underlying_id: null,
  label: 'VKOSPI F',
  code: 'A04608',
  value: 73.5,
  change: 2.15,
  change_rate: 3.01,
  market_basis: -3.67,
  days_left: 6,
});

/** 현물 분봉 — 선물 모드가 이걸 그리면 안 된다는 것을 보이려고 값을 확실히 구분한다. */
const SPOT_CANDLES = {
  candles: [
    { open: 900, high: 900, low: 900, close: 900 },
    { open: 900, high: 900, low: 900, close: 901 },
  ],
};

function mockApi(
  futures: {
    quotes: unknown[];
    session?: string;
    unavailable?: string | null;
  },
  futuresCandles: Record<string, { closes: number[]; day_open: number | null }> = {},
) {
  vi.spyOn(client, 'apiCall').mockImplementation((async (url: string) => {
    if (url.startsWith('/api/live/index-quotes')) return { quotes: SPOT_QUOTES };
    if (url.startsWith('/api/market/futures-quotes')) {
      return {
        session: 'day',
        unavailable: null,
        ...futures,
      };
    }
    if (url.startsWith('/api/market/futures-candles')) return { series: futuresCandles };
    if (url.startsWith('/api/market/sectors')) return { markets: {} };
    if (url.startsWith('/api/live/index-candles')) return SPOT_CANDLES;
    return {};
  }) as unknown as typeof client.apiCall);
}

/** 카드 안의 스파크라인 path. 없으면 null. */
function sparkPath(card: HTMLElement): string | null {
  return card.querySelector('svg path')?.getAttribute('d') ?? null;
}

/** 라벨 텍스트로 카드 루트를 찾는다. */
function cardByLabel(label: string): HTMLElement {
  const el = screen.getByText(label).closest('div[class*="flex-col"]');
  if (!el) throw new Error(`카드를 찾지 못함: ${label}`);
  return el as HTMLElement;
}

function renderCards() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IndexCards />
    </QueryClientProvider>,
  );
}

/** 토글이 붙은 카드의 세그먼티드 컨트롤. aria-label 로 카드를 특정한다. */
function toggleFor(indexLabel: string) {
  return screen.getByLabelText(`${indexLabel} 현물/선물`);
}

describe('IndexCards 현물/선물 토글', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('선물이 있는 카드에만 토글이 붙는다', async () => {
    mockApi({ quotes: [futuresQuote(), KOSDAQ150_F] });
    renderCards();

    expect(await screen.findByLabelText('KOSPI 200 현물/선물')).toBeTruthy();
    expect(screen.getByLabelText('KOSDAQ 150 현물/선물')).toBeTruthy();
    // 종합지수엔 선물이 없다 — 토글도 없어야 한다
    expect(screen.queryByLabelText('KOSPI 현물/선물')).toBeNull();
    expect(screen.queryByLabelText('KOSDAQ 현물/선물')).toBeNull();
  });

  it('선물을 고르면 값·라벨이 선물 것으로 바뀌고 베이시스가 붙는다', async () => {
    mockApi({ quotes: [futuresQuote()] });
    renderCards();

    expect(await screen.findByText('982.92')).toBeTruthy(); // 현물
    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));

    expect(screen.getByText('981.15')).toBeTruthy();
    expect(screen.queryByText('982.92')).toBeNull();
    expect(screen.getByText('KOSPI 200 F')).toBeTruthy();
    // 시장 베이시스(−1.77). 이론 베이시스(+2.15)를 쓰면 부호가 뒤집힌다.
    expect(screen.getByText('-1.77')).toBeTruthy();
    expect(screen.getByText(/D-36/)).toBeTruthy();
  });

  it('카드마다 선택이 독립이고 서로를 덮어쓰지 않는다', async () => {
    mockApi({ quotes: [futuresQuote(), KOSDAQ150_F] });
    renderCards();

    await userEvent.click(within(await screen.findByLabelText('KOSPI 200 현물/선물')).getByText('선물'));
    await userEvent.click(within(toggleFor('KOSDAQ 150')).getByText('선물'));

    // 둘 다 선물이어야 한다 — 두 번째 클릭이 첫 번째를 덮으면 여기서 깨진다
    expect(JSON.parse(localStorage.getItem('market.indexCardMode.v1') ?? '{}')).toEqual({
      KOSPI200: 'futures',
      KOSDAQ150: 'futures',
    });
    expect(screen.getByText('981.15')).toBeTruthy();
    expect(screen.getByText('1,365.80')).toBeTruthy();
  });

  it('저장된 선택이 새 마운트에서 복원된다', async () => {
    localStorage.setItem('market.indexCardMode.v1', JSON.stringify({ KOSPI200: 'futures' }));
    mockApi({ quotes: [futuresQuote(), KOSDAQ150_F] });
    renderCards();

    expect(await screen.findByText('981.15')).toBeTruthy();
    // 저장 안 된 카드는 현물 그대로
    expect(screen.getByText('1,371.62')).toBeTruthy();
  });

  it('선물 값이 아직 없으면 토글을 그리지 않고 현물로 남는다', async () => {
    // 저장된 선택은 '선물' 이지만 데이터가 없다 — 빈 카드를 만들면 안 된다
    localStorage.setItem('market.indexCardMode.v1', JSON.stringify({ KOSPI200: 'futures' }));
    mockApi({ quotes: [], unavailable: 'credentials_missing' });
    renderCards();

    expect(await screen.findByText('982.92')).toBeTruthy();
    expect(screen.queryByLabelText('KOSPI 200 현물/선물')).toBeNull();
  });

  it('야간엔 REST 값이 주간 마감본임을 배지로 말한다', async () => {
    mockApi({ quotes: [futuresQuote()], session: 'night' });
    renderCards();

    await userEvent.click(within(await screen.findByLabelText('KOSPI 200 현물/선물')).getByText('선물'));
    expect(screen.getByText(/주간 마감값/)).toBeTruthy();
  });

  it('장 마감 중에는 마감이라고 말한다', async () => {
    mockApi({ quotes: [futuresQuote()], session: 'closed' });
    renderCards();

    await userEvent.click(within(await screen.findByLabelText('KOSPI 200 현물/선물')).getByText('선물'));
    expect(screen.getByText(/장 마감/)).toBeTruthy();
  });

  it('주간 중에는 배지를 달지 않는다', async () => {
    mockApi({ quotes: [futuresQuote()], session: 'day' });
    renderCards();

    await userEvent.click(within(await screen.findByLabelText('KOSPI 200 현물/선물')).getByText('선물'));
    expect(screen.queryByText(/주간 마감값/)).toBeNull();
    expect(screen.queryByText(/장 마감/)).toBeNull();
  });

  it('야간엔 배지가 카드마다 갈린다 — WS 틱이 붙은 종목만 실시간이다', async () => {
    // 실측(2026-08-07 00:36, 40초): KOSPI200 48틱 / 코스닥150 0틱.
    // 스냅샷 하나로 판정하면 둘 중 하나는 반드시 틀린 배지를 단다.
    mockApi({
      session: 'night',
      quotes: [
        futuresQuote({ data_session: 'night' }),
        { ...KOSDAQ150_F, data_session: 'day' },
      ],
    });
    renderCards();

    await userEvent.click(within(await screen.findByLabelText('KOSPI 200 현물/선물')).getByText('선물'));
    await userEvent.click(within(toggleFor('KOSDAQ 150')).getByText('선물'));

    // 야간 실시간인 카드엔 배지가 없고, 무음인 카드에만 붙는다
    expect(within(cardByLabel('KOSPI 200 F')).queryByText(/주간 마감값/)).toBeNull();
    expect(within(cardByLabel('KOSDAQ 150 F')).getByText(/주간 마감값/)).toBeTruthy();
  });
});

describe('IndexCards 스파크라인 소스 분리', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('선물 모드는 선물 분봉을 그린다 — 현물 분봉을 재사용하지 않는다', async () => {
    // 현물은 2점(900→901), 선물은 4점. path 의 좌표 개수로 소스가 갈린다.
    mockApi({ quotes: [futuresQuote()] }, {
      KOSPI200_F: { closes: [1013.35, 1000, 990, 981.15], day_open: 1017.15 },
    });
    renderCards();

    await screen.findByText('982.92');
    // 분봉은 시세와 별도 쿼리라 한 틱 늦게 온다.
    await waitFor(() => expect(sparkPath(cardByLabel('KOSPI 200'))).not.toBeNull());
    const spotPath = sparkPath(cardByLabel('KOSPI 200'));
    expect(spotPath?.match(/L/g)).toHaveLength(1); // 2점 = M + L 1개

    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));
    await waitFor(() => expect(sparkPath(cardByLabel('KOSPI 200 F'))).not.toBeNull());
    const futPath = sparkPath(cardByLabel('KOSPI 200 F'));
    expect(futPath?.match(/L/g)).toHaveLength(3); // 4점 = M + L 3개
    expect(futPath).not.toBe(spotPath);
  });

  it('선물 분봉이 없으면 스파크라인을 그리지 않는다', async () => {
    mockApi({ quotes: [futuresQuote()] }, {});
    renderCards();

    await screen.findByText('982.92');
    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));
    // 현물 분봉으로 대신 채우면 여기서 걸린다
    expect(sparkPath(cardByLabel('KOSPI 200 F'))).toBeNull();
  });
});

describe('IndexCards VKOSPI 단독 카드', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('대응 현물이 없는 선물은 토글 없는 단독 카드로 붙는다', async () => {
    mockApi({ quotes: [futuresQuote(), VKOSPI_F] });
    renderCards();

    expect(await screen.findByText('VKOSPI F')).toBeTruthy();
    expect(screen.getByText('73.50')).toBeTruthy();
    // 바꿀 짝이 없으므로 토글이 없어야 한다
    expect(screen.queryByLabelText('VKOSPI F 현물/선물')).toBeNull();
  });

  it('단독 선물이 없으면 4열, 있으면 5열이다', async () => {
    mockApi({ quotes: [futuresQuote()] });
    const { container, unmount } = renderCards();
    await screen.findByText('982.92');
    expect(container.querySelector('.grid-cols-4')).toBeTruthy();
    unmount();

    mockApi({ quotes: [futuresQuote(), VKOSPI_F] });
    const second = renderCards();
    await screen.findByText('VKOSPI F');
    expect(second.container.querySelector('.grid-cols-5')).toBeTruthy();
  });
});
