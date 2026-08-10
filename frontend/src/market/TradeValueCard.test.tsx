/** 거래대금 추이 카드 — 통계 타일 안이 지켜야 하는 계약을 고정한다.
 *
 * 값은 2026-08-10 실측 축(억원)이지만 **자릿수를 골라 놓았다**: 확정일을 20조로
 * 평평하게 깔고 당일만 움직여서, 아래 세 경우가 서로 다른 퍼센트로 갈리게 했다.
 *
 *     덮어씀 + 당일 제외 평균 → 30조 / 20조 → +50%   ← 계약
 *     안 덮음                → 10조 / 20조 → −50%
 *     평균에 당일 포함        → 30조 / 22조 → +36%
 *
 * 셋이 같은 숫자로 수렴하면 이 테스트는 아무것도 증명하지 못한다.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import { TradeValueCard } from './TradeValueCard';

const EOK_20JO = 200_000;
const EOK_10JO = 100_000;
const EOK_30JO = 300_000;

/** 실제 KST 오늘을 쓴다 — 상수로 박으면 날짜가 바뀌는 순간 테스트가 시간에 종속된다. */
const TODAY = todayKstYyyymmdd();
const EARLIER = ['20260803', '20260804', '20260805', '20260806'];

function series(lastDate: string, lastEok: number) {
  return [
    ...EARLIER.map((date) => ({ date, value_eok: EOK_20JO })),
    { date: lastDate, value_eok: lastEok },
  ];
}

const TRADE_VALUE = {
  unit: 'eok',
  markets: { KOSPI: series(TODAY, EOK_10JO), KOSDAQ: series(TODAY, EOK_10JO) },
};

/** `/sectors` 가 들고 있는 **당일** 종합 거래대금. 두 TR 이 같은 축이라 이걸로 덮는다. */
const SECTORS = {
  markets: {
    '0': { index: { code: '001', name: '종합(KOSPI)', trade_value_eok: EOK_30JO }, sectors: [] },
    '1': { index: { code: '101', name: '종합(KOSDAQ)', trade_value_eok: EOK_30JO }, sectors: [] },
  },
  volatility: null,
};

const urls: string[] = [];

function mockApi(tradeValue: unknown = TRADE_VALUE, sectors: unknown = SECTORS) {
  vi.spyOn(client, 'apiCall').mockImplementation((async (url: string) => {
    urls.push(url);
    if (url.startsWith('/api/market/trade-value')) return tradeValue;
    if (url.startsWith('/api/market/sectors')) return sectors;
    return {};
  }) as unknown as typeof client.apiCall);
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TradeValueCard />
    </QueryClientProvider>,
  );
}

describe('TradeValueCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    urls.length = 0;
  });

  it('당일 점을 /sectors 값으로 덮고, 기준 평균에서는 당일을 뺀다', async () => {
    mockApi();
    renderCard();
    // 30조 = 덮어쓴 값. 10조가 보이면 덮기가 안 걸린 것이다.
    await waitFor(() => expect(screen.getAllByText('30.00조').length).toBe(2));
    // +50% = 당일을 뺀 평균(20조) 기준. +36% 면 평균에 당일이 섞인 것이다.
    expect(screen.getAllByText('+50%').length).toBe(2);
  });

  it('기준을 글자로 준다 — 배경에서는 값을 읽을 수 없다', async () => {
    // 차트가 배경이라 축도 눈금도 없다. 이 줄이 없으면 퍼센트가 무엇 대비인지
    // 카드 안에 근거가 남지 않는다.
    mockApi();
    renderCard();
    await waitFor(() => expect(screen.getAllByText('평소 20.00조').length).toBe(2));
  });

  it('배경 추이는 스크린리더에서 감춘다 — 읽는 그림이 아니다', async () => {
    mockApi();
    const { container } = renderCard();
    await waitFor(() => expect(screen.getAllByText('30.00조').length).toBe(2));
    const svgs = Array.from(container.querySelectorAll('svg'));
    expect(svgs.length).toBe(2);
    expect(svgs.every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('마지막 점이 오늘이 아니면 덮지 않는다', async () => {
    // 장 마감 후 자정을 넘기면 `/sectors` 가 아직 어제 값을 들고 있을 수 있다.
    // 날짜를 안 보고 덮으면 그 값이 **어제 점 위에** 올라가 조용히 하루가 밀린다.
    mockApi({
      unit: 'eok',
      markets: { KOSPI: series('20260807', EOK_10JO), KOSDAQ: series('20260807', EOK_10JO) },
    });
    renderCard();
    await waitFor(() => expect(screen.getAllByText('10.00조').length).toBe(2));
    expect(screen.queryByText('30.00조')).not.toBeInTheDocument();
    expect(screen.getAllByText('-50%').length).toBe(2);
  });

  it('한 시장만 실패하면 그 칸만 빈 문구다', async () => {
    // 백엔드는 실패한 시장의 **키를 뺀다**(빈 배열이 아니다).
    mockApi({ unit: 'eok', markets: { KOSPI: series(TODAY, EOK_10JO) } });
    renderCard();
    await waitFor(() => expect(screen.getByText('30.00조')).toBeInTheDocument());
    expect(screen.getByText('코스닥 이력을 받지 못했습니다.')).toBeInTheDocument();
  });

  it('둘 다 없으면 로딩과 실패를 다른 문구로 말한다', async () => {
    mockApi({ unit: 'eok', markets: {} });
    renderCard();
    await waitFor(() =>
      expect(screen.getByText('거래대금 이력을 받지 못했습니다.')).toBeInTheDocument(),
    );
  });

  it('날짜 범위는 헤더에 한 번만 적는다', async () => {
    // 두 타일이 같은 창을 보므로 타일마다 적으면 같은 글자가 두 번 나온다.
    mockApi();
    renderCard();
    await waitFor(() => expect(screen.getAllByText('30.00조').length).toBe(2));
    const month = Number(TODAY.slice(4, 6));
    const day = Number(TODAY.slice(6, 8));
    expect(screen.getAllByText(new RegExp(`8/3–${month}/${day}`)).length).toBe(1);
  });

  it('기간 토글이 요청 창을 바꾼다 — 기본은 20일이다', async () => {
    mockApi();
    renderCard();
    await waitFor(() => expect(urls.some((u) => u.includes('days=20'))).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: '120일' }));
    await waitFor(() => expect(urls.some((u) => u.includes('days=120'))).toBe(true));
  });
});
