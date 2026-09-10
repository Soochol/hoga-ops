import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import { TradeValueCard } from './TradeValueCard';

const EOK_20JO = 200_000;
const EOK_60JO = 600_000;
const EOK_10JO = 100_000;
const EOK_30JO = 300_000;

/** 실제 KST 오늘을 쓴다 — 상수로 박으면 날짜가 바뀌는 순간 테스트가 시간에 종속된다. */
const TODAY = todayKstYyyymmdd();

/** 당일에서 `offset` 일 되짚은 날 → `YYYYMMDD`. `past(0) === TODAY` 다(구성상).
 *
 *  픽스처가 120일 창보다 길어야 하므로 달·해를 넘는다 — 문자열 산술로는 못 하고
 *  `Date` 로 뺀다. 거래일 여부는 상관없다: 카드는 날짜를 **순서와 표시**에만 쓰고
 *  거래일 판정은 백엔드 몫이다. */
function past(offset: number): string {
  const d = new Date(
    Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(4, 6)) - 1, Number(TODAY.slice(6, 8))),
  );
  d.setUTCDate(d.getUTCDate() - offset);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${mm}${dd}`;
}

/** 마지막 점에서 몇 번째 되짚는 확정일에 60조를 세우는가. 20일 창의 기준 표본에
 *  **아슬아슬하게 들어가는 마지막 날** — 여기서 한 칸만 밀리면 off-by-one 이 드러난다. */
const SPIKE_OFFSET = 20;
/** 가장 넓은 화면 창(120일)보다 길어야 창 축을 잰다 — 파일 상단 주석 참조. */
const HISTORY = 130;

/** `lastOffset` = 마지막 점이 당일에서 몇 번째 되짚는 날인가(0 = 오늘, 1 = 어제).
 *  스파이크는 항상 **마지막 점 기준** 상대 위치라 두 경우가 대칭이다. */
function series(lastOffset: number, lastEok: number) {
  const points = [];
  for (let o = HISTORY; o >= 1; o--) {
    points.push({
      date: past(o + lastOffset),
      value_eok: o === SPIKE_OFFSET ? EOK_60JO : EOK_20JO,
    });
  }
  points.push({ date: past(lastOffset), value_eok: lastEok });
  return points;
}

const TRADE_VALUE = {
  unit: 'eok',
  markets: { KOSPI: series(0, EOK_10JO), KOSDAQ: series(0, EOK_10JO) },
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

function mockApi(tradeValue: typeof TRADE_VALUE | { unit: string; markets: Record<string, ReturnType<typeof series>> } = TRADE_VALUE, sectors: unknown = SECTORS) {
  vi.spyOn(client, 'apiCall').mockImplementation((async (url: string) => {
    urls.push(url);
    if (url.startsWith('/api/market/trade-value')) {
      // 실 백엔드와 같이 `days` 로 자른다 — 위 파일 주석 참조.
      const days = Number(new URL(url, 'http://x').searchParams.get('days') ?? 120);
      return {
        ...tradeValue,
        markets: Object.fromEntries(
          Object.entries(tradeValue.markets).map(([k, v]) => [k, v.slice(-days)]),
        ),
      };
    }
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
  beforeEach(() => { vi.restoreAllMocks(); urls.length = 0; });

  it('updates today from sectors, excludes it from the baseline and avoids full-day percentage comparison', async () => {
    mockApi(); renderCard();
    await waitFor(() => expect(screen.getAllByText('30.00조')).toHaveLength(2));
    expect(screen.getAllByText('직전 20거래일 하루 평균 22.00조')).toHaveLength(2);
    expect(screen.getAllByText('집계 중 · 잠정')).toHaveLength(2);
    expect(screen.queryByText(/하루 평균 대비/)).not.toBeInTheDocument();
    expect(urls.some(u => u.endsWith('days=21'))).toBe(true);
  });

  it('changes baseline samples with the selected trading-day window', async () => {
    mockApi(); renderCard();
    await waitFor(() => expect(screen.getAllByText('직전 20거래일 하루 평균 22.00조')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: '60거래일' }));
    await waitFor(() => expect(screen.getAllByText('직전 60거래일 하루 평균 20.67조')).toHaveLength(2));
    expect(urls.some(u => u.endsWith('days=61'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '120거래일' }));
    await waitFor(() => expect(screen.getAllByText('직전 120거래일 하루 평균 20.33조')).toHaveLength(2));
    expect(urls.some(u => u.endsWith('days=121'))).toBe(true);
  });

  it('does not overwrite historical endpoints and labels their comparison', async () => {
    mockApi({ unit: 'eok', markets: { KOSPI: series(1, EOK_10JO), KOSDAQ: series(1, EOK_10JO) } });
    renderCard();
    await waitFor(() => expect(screen.getAllByText('10.00조')).toHaveLength(2));
    expect(screen.queryByText('30.00조', { selector: 'strong' })).not.toBeInTheDocument();
    expect(screen.getAllByText('하루 평균 대비 -55%')).toHaveLength(2);
    expect(screen.queryByText('집계 중 · 잠정')).not.toBeInTheDocument();
  });

  it('keeps missing-market status in its own slot', async () => {
    mockApi({ unit: 'eok', markets: { KOSPI: series(0, EOK_10JO) } }); renderCard();
    await waitFor(() => expect(screen.getByText('30.00조')).toBeInTheDocument());
    expect(screen.getByText('코스닥 이력을 받지 못했습니다.')).toBeInTheDocument();
  });

  it('distinguishes loading from empty responses', async () => {
    mockApi({ unit: 'eok', markets: {} }); renderCard();
    expect(screen.getByText('거래대금 이력을 불러오는 중입니다.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('거래대금 이력을 받지 못했습니다.')).toBeInTheDocument());
  });

  it('uses a common zero-based scale and exposes each bar through keyboard inspection', async () => {
    mockApi({ unit: 'eok', markets: { KOSPI: series(1, EOK_60JO), KOSDAQ: series(1, EOK_10JO) } });
    const { container } = renderCard();
    await waitFor(() => expect(screen.getByText('60.00조')).toBeInTheDocument());
    const charts = container.querySelectorAll('svg');
    const high = Number(charts[0].querySelector('rect:last-of-type')?.getAttribute('height'));
    const low = Number(charts[1].querySelector('rect:last-of-type')?.getAttribute('height'));
    expect(high / low).toBeCloseTo(6);
    const probe = screen.getAllByRole('group', { name: /차트 상세/ })[0];
    probe.focus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('status')).toHaveTextContent('코스피 20.00조');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('status')).toHaveTextContent('코스피 60.00조');
  });

  it('reports the actual sample count when history is shorter than the requested window', async () => {
    mockApi({ unit: 'eok', markets: { KOSPI: [{ date: past(1), value_eok: EOK_20JO }, { date: TODAY, value_eok: EOK_10JO }] } });
    renderCard();
    await waitFor(() => expect(screen.getByText('직전 1거래일 하루 평균 20.00조')).toBeInTheDocument());
  });
});
