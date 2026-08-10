/** 거래대금 추이 카드 — 통계 타일 안이 지켜야 하는 계약을 고정한다.
 *
 * ── 픽스처가 이렇게 생긴 이유 ───────────────────────────────────────────────
 *
 * 확정일 29개를 20조로 평평하게 깔고 **당일에서 20번째 되는 날 하나만 60조**로
 * 세워 두었다. 그 하나가 기준 표본에 들어가느냐로 아래 네 경우가 갈린다:
 *
 *     정상(창 21개 · 당일 제외 20개) → 평소 22.00조 · +36%   ← 계약
 *     off-by-one(창 20개 → 19개)     → 평소 20.00조 · +50%
 *     평균에 당일 포함               → 평소 20.50조 · +46%
 *     당일을 안 덮음                 → 평소 22.00조 · −55%
 *
 * **모의가 `days` 를 잘라야 한다.** 무시하면 창을 바꿔도 같은 배열이 와서 off-by-one
 * 이 테스트에 안 잡힌다 — 실제로 그래서 처음에 놓쳤다(픽스처가 5일짜리라 어느 창에서도
 * 표본이 같았다). 실 백엔드는 `days` 로 자르므로 모의도 자른다.
 */
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
/** 당일에서 몇 번째로 되짚는 날인가 → `YYYYMMDD`. 6월 안에 머물게 잡아 전부 유효하다. */
const past = (offset: number) => `202606${String(31 - offset).padStart(2, '0')}`;
/** 기준 표본에 **들어가야 하는 마지막 날**. 여기 60조를 세운다. */
const SPIKE_OFFSET = 20;
const HISTORY = 29;

function series(lastDate: string, lastEok: number) {
  const points = [];
  for (let o = HISTORY; o >= 1; o--) {
    points.push({ date: past(o), value_eok: o === SPIKE_OFFSET ? EOK_60JO : EOK_20JO });
  }
  points.push({ date: lastDate, value_eok: lastEok });
  return points;
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
  beforeEach(() => {
    vi.restoreAllMocks();
    urls.length = 0;
  });

  it('당일 점을 /sectors 값으로 덮고, 기준 평균에서는 당일을 뺀다', async () => {
    mockApi();
    renderCard();
    // 30조 = 덮어쓴 값. 10조가 보이면 덮기가 안 걸린 것이다.
    await waitFor(() => expect(screen.getAllByText('30.00조').length).toBe(2));
    // +36% = 당일을 뺀 20개 평균(22조) 기준. +46% 면 평균에 당일이 섞인 것이다.
    expect(screen.getAllByText('+36%').length).toBe(2);
  });

  it('기준 표본은 화면 창과 독립이다 — 토글해도 "평소" 가 그대로다', async () => {
    // `days=span` 으로 받으면 20일 창에서 당일을 뺀 뒤 19개만 남아 라벨(20일 평균)과
    // 어긋나고, 토글이 기준을 움직인다(2026-08-10 실측: 32.68조↔32.63조).
    // 그 상태면 여기서 20일 창만 `평소 20.00조` 로 갈라진다.
    mockApi();
    renderCard();
    await waitFor(() => expect(screen.getAllByText('평소 22.00조').length).toBe(2));
    await userEvent.click(screen.getByRole('button', { name: '120일' }));
    await waitFor(() => expect(urls.some((u) => u.includes('days=120'))).toBe(true));
    expect(screen.getAllByText('평소 22.00조').length).toBe(2);
    // 20일 창은 **21일치를 받는다** — 당일을 빼고도 20개가 남아야 하기 때문이다.
    expect(urls.some((u) => u.includes('days=21'))).toBe(true);
    expect(urls.some((u) => u.includes('days=20&') || u.endsWith('days=20'))).toBe(false);
  });

  it('기준을 글자로 준다 — 배경에서는 값을 읽을 수 없다', async () => {
    // 차트가 배경이라 축도 눈금도 없다. 이 줄이 없으면 퍼센트가 무엇 대비인지
    // 카드 안에 근거가 남지 않는다.
    mockApi();
    renderCard();
    await waitFor(() => expect(screen.getAllByText('평소 22.00조').length).toBe(2));
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
      markets: { KOSPI: series(past(0), EOK_10JO), KOSDAQ: series(past(0), EOK_10JO) },
    });
    renderCard();
    await waitFor(() => expect(screen.getAllByText('10.00조').length).toBe(2));
    expect(screen.queryByText('30.00조')).not.toBeInTheDocument();
    expect(screen.getAllByText('-55%').length).toBe(2);
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

  it('날짜 범위는 헤더에 한 번만, 그리고 **화면 창** 기준이다', async () => {
    // 두 타일이 같은 창을 보므로 타일마다 적으면 같은 글자가 두 번 나온다.
    // 그리고 받은 길이(21일)가 아니라 **보이는 길이(20일)** 를 말해야 한다.
    mockApi();
    renderCard();
    await waitFor(() => expect(screen.getAllByText('30.00조').length).toBe(2));
    const month = Number(TODAY.slice(4, 6));
    const day = Number(TODAY.slice(6, 8));
    // 20일 창의 첫날 = 당일에서 19번째 되짚는 날.
    const firstShown = past(19);
    const label = `${Number(firstShown.slice(4, 6))}/${Number(firstShown.slice(6, 8))}–${month}/${day}`;
    expect(screen.getAllByText(new RegExp(label)).length).toBe(1);
  });
});
