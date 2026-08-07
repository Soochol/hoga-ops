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

/** 죽은 KIS 선물(2026-08-07). 백엔드 라인업에서 뺐지만, 되살아나도 카드가 서지 않는지
 *  프론트 쪽에서도 못 박는다 — 이 상품은 거래량 0 이라 값이 정산가에 굳어 있다. */
const VKOSPI_F = futuresQuote({
  id: 'VKOSPI_F',
  underlying_id: null,
  label: 'VKOSPI F',
  code: 'A04608',
  value: 73.5,
  change: 0,
  change_rate: 0,
  market_basis: -3.67,
  days_left: 5,
});

/** 변동성지수 — 키움 ka20003 의 `603` 행이 최상위 `volatility` 로 온다. */
const VOLATILITY = { code: '603', name: '변동성지수', value: 75.97, change_pct: -1.56 };

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
  futuresCandles: Record<
    string,
    {
      closes: number[];
      day_open: number | null;
      session?: string;
      coverage?: { first_hhmm: string; observed_buckets: number; gap_count: number } | null;
    }
  > = {},
  volatility: { code: string; name: string; value: number | null; change_pct: number | null } | null = null,
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
    if (url.startsWith('/api/market/sectors')) return { markets: {}, volatility };
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
      KOSPI200_F: { closes: [1013.35, 1000, 990, 981.15], day_open: 1017.15, session: 'day' },
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

  it('야간엔 야간 시리즈를 그린다 — 그림과 값의 소스가 같아야 한다', async () => {
    // 백엔드가 소스를 맞춰 보낸다(값=야간 → 그림=야간). 프론트는 받은 대로 그린다.
    mockApi(
      { session: 'night', quotes: [futuresQuote({ data_session: 'night', value: 1004.95 })] },
      { KOSPI200_F: { closes: [1000, 1002, 1005, 1004.95], day_open: null, session: 'night' } },
    );
    renderCards();

    await screen.findByText('982.92');
    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));
    await waitFor(() => expect(sparkPath(cardByLabel('KOSPI 200 F'))).not.toBeNull());

    expect(sparkPath(cardByLabel('KOSPI 200 F'))?.match(/L/g)).toHaveLength(3);
    // 야간 실시간이므로 낡음 배지는 없다
    expect(within(cardByLabel('KOSPI 200 F')).queryByText(/주간 마감값/)).toBeNull();
  });

  it('야간 그림이 앞이 잘렸으면 시작 시각을 말한다', async () => {
    // 02:00 부터만 관측 — 스파크라인엔 축이 없어서 8시간짜리 선과 10분짜리 선이
    // 화면에서 똑같이 카드를 채운다. 글자로만 구별할 수 있다.
    mockApi(
      { session: 'night', quotes: [futuresQuote({ data_session: 'night', value: 1004.95 })] },
      {
        KOSPI200_F: {
          closes: [1000, 1002, 1005],
          day_open: null,
          session: 'night',
          coverage: { first_hhmm: '0200', observed_buckets: 5, gap_count: 0 },
        },
      },
    );
    renderCards();

    await screen.findByText('982.92');
    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));
    expect(within(cardByLabel('KOSPI 200 F')).getByText(/02:00~/)).toBeTruthy();
  });

  it('관측이 끊겼으면 끊긴 횟수도 말한다', async () => {
    mockApi(
      { session: 'night', quotes: [futuresQuote({ data_session: 'night', value: 1004.95 })] },
      {
        KOSPI200_F: {
          closes: [1000, 1002, 1005],
          day_open: null,
          session: 'night',
          coverage: { first_hhmm: '1800', observed_buckets: 40, gap_count: 2 },
        },
      },
    );
    renderCards();

    await screen.findByText('982.92');
    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));
    expect(within(cardByLabel('KOSPI 200 F')).getByText(/끊김 2곳/)).toBeTruthy();
  });

  it('18:00부터 끊김 없이 봤으면 아무 말도 하지 않는다', async () => {
    // 정상을 알리는 문구는 소음이다 — 온전할 때 조용해야 경고가 의미를 갖는다.
    mockApi(
      { session: 'night', quotes: [futuresQuote({ data_session: 'night', value: 1004.95 })] },
      {
        KOSPI200_F: {
          closes: [1000, 1002, 1005],
          day_open: null,
          session: 'night',
          coverage: { first_hhmm: '1800', observed_buckets: 40, gap_count: 0 },
        },
      },
    );
    renderCards();

    await screen.findByText('982.92');
    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));
    const card = cardByLabel('KOSPI 200 F');
    expect(within(card).queryByText(/~/)).toBeNull();
    expect(within(card).queryByText(/끊김/)).toBeNull();
  });

  it('주간 그림에는 커버리지를 붙이지 않는다', async () => {
    // 주간은 REST 로 날짜를 지정해 다시 받을 수 있어서 "놓친 구간" 개념이 없다.
    mockApi({ quotes: [futuresQuote()] }, {
      KOSPI200_F: {
        closes: [1013.35, 1000, 981.15],
        day_open: 1017.15,
        session: 'day',
        coverage: null,
      },
    });
    renderCards();

    await screen.findByText('982.92');
    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));
    expect(within(cardByLabel('KOSPI 200 F')).queryByText(/~/)).toBeNull();
  });

  it('야간 봉이 아직 부족하면 아무것도 그리지 않는다', async () => {
    // 야간 개장 직후 — 백엔드가 시리즈를 아예 안 준다. 주간 그림으로 폴백하면
    // 값은 야간인데 그림은 주간이라, 주간 하락이 야간에 일어난 것으로 읽힌다.
    mockApi(
      { session: 'night', quotes: [futuresQuote({ data_session: 'night', value: 1004.95 })] },
      {},
    );
    renderCards();

    await screen.findByText('982.92');
    await userEvent.click(within(toggleFor('KOSPI 200')).getByText('선물'));
    expect(sparkPath(cardByLabel('KOSPI 200 F'))).toBeNull();
  });
});

describe('IndexCards VKOSPI 단독 카드', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('변동성지수는 토글 없는 단독 카드로 붙는다', async () => {
    mockApi({ quotes: [futuresQuote()] }, {}, VOLATILITY);
    renderCards();

    expect(await screen.findByText('VKOSPI')).toBeTruthy();
    expect(screen.getByText('75.97')).toBeTruthy();
    // 바꿀 짝이 없으므로 토글이 없어야 한다
    expect(screen.queryByLabelText('VKOSPI 현물/선물')).toBeNull();
  });

  it('변동성지수가 없으면 4열, 있으면 5열이다', async () => {
    mockApi({ quotes: [futuresQuote()] });
    const { container, unmount } = renderCards();
    await screen.findByText('982.92');
    expect(container.querySelector('.grid-cols-4')).toBeTruthy();
    unmount();

    mockApi({ quotes: [futuresQuote()] }, {}, VOLATILITY);
    const second = renderCards();
    await screen.findByText('VKOSPI');
    expect(second.container.querySelector('.grid-cols-5')).toBeTruthy();
  });

  it('값이 없으면 —, 등락률만 그린다 (등락폭을 역산하지 않는다)', async () => {
    mockApi({ quotes: [futuresQuote()] }, {}, { ...VOLATILITY, value: null });
    renderCards();

    await screen.findByText('VKOSPI');
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('죽은 VKOSPI 선물이 응답에 남아 있어도 카드가 서지 않는다', async () => {
    // 라인업에서 뺐지만(2026-08-07) 벤더 응답이 되살아나는 경로를 프론트에서도 막는다 —
    // 거래량 0 이라 값이 정산가에 굳은 상품이 실시간 카드처럼 보이면 안 된다.
    mockApi({ quotes: [futuresQuote(), VKOSPI_F] });
    const { container } = renderCards();

    await screen.findByText('982.92');
    expect(screen.queryByText('VKOSPI F')).toBeNull();
    expect(container.querySelector('.grid-cols-4')).toBeTruthy();
  });
});
