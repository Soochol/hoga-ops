/** 주체별 연속 매매 카드 — 순매수↔순매도 토글이 지키는 계약을 고정한다.
 *
 * 값은 2026-08-10 장중 ka10131 실응답에서 가져왔다(양방향 각 1콜). 특히 순매도 쪽은
 * **음수 그대로** 두었다 — 백엔드가 부호를 보존하고 화면이 일수만 절대값으로 읽는
 * 분업이 이 카드의 계약이라, 픽스처를 양수로 만들면 그 분업이 통째로 검증에서 빠진다.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { ActorNetCard } from './MarketPage';

const BUY = {
  warnings: [],
  외국인: [
    { code: '068270', name: '셀트리온', actor: '외국인', streak_days: 4,
      streak_net_eok: 1209.63, streak_net_qty_shares: 631874, period_change_pct: 2.82 },
  ],
  기관: [
    { code: '009150', name: '삼성전기', actor: '기관', streak_days: 6,
      streak_net_eok: 3475.25, streak_net_qty_shares: 1_000_000, period_change_pct: 3.34 },
  ],
};

const SELL = {
  warnings: [],
  외국인: [
    { code: '005930', name: '삼성전자', actor: '외국인', streak_days: -2,
      streak_net_eok: -9404.83, streak_net_qty_shares: -4105152, period_change_pct: -1.24 },
  ],
  기관: [
    { code: '035420', name: 'NAVER', actor: '기관', streak_days: -1,
      streak_net_eok: -580.09, streak_net_qty_shares: -240000, period_change_pct: -0.3 },
  ],
};

/** 호출된 URL 을 그대로 모은다 — 방향이 실제로 wire 로 나가는지 재려면 필요하다. */
function mockApi(): string[] {
  const urls: string[] = [];
  vi.spyOn(client, 'apiCall').mockImplementation((async (url: string) => {
    urls.push(url);
    if (url.includes('direction=sell')) return SELL;
    if (url.includes('/api/market/streaks')) return BUY;
    return {};
  }) as unknown as typeof client.apiCall);
  return urls;
}

function renderCards() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 행 클릭이 `useJumpToLive`(=`useNavigate`)를 타므로 Router 없이는 마운트 자체가 죽는다.
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ActorNetCard actor="외국인" />
        <ActorNetCard actor="기관" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function card(actor: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: new RegExp(actor) });
  return heading.closest('div')!.parentElement as HTMLElement;
}

describe('ActorNetCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('기본은 순매수이고, 방향이 쿼리 파라미터로 나간다', async () => {
    const urls = mockApi();
    renderCards();

    expect(await screen.findByText('셀트리온')).toBeTruthy();
    // 두 카드가 같은 방향이면 쿼리 키가 같아 **한 벌만** 돈다.
    await waitFor(() => expect(urls).toEqual(['/api/market/streaks?direction=buy']));
  });

  it('순매도로 토글하면 그 방향만 새로 부르고 일수는 절대값으로 읽힌다', async () => {
    const urls = mockApi();
    renderCards();
    await screen.findByText('셀트리온');

    const foreign = card('외국인');
    await userEvent.click(within(foreign).getByRole('button', { name: '순매도' }));

    expect(await within(foreign).findByText('삼성전자')).toBeTruthy();
    // 벤더는 -2 를 주고 백엔드가 부호를 보존한다 — "-2일" 은 읽히지 않으므로 화면이 벗긴다.
    expect(within(foreign).getByText('2일')).toBeTruthy();
    expect(within(foreign).queryByText('-2일')).toBeNull();
    // 금액은 부호를 유지한다(색이 곧 그 정보다).
    expect(within(foreign).getByText('-9,405')).toBeTruthy();

    // 방향은 **카드별**이다 — 기관 카드는 순매수 그대로다.
    expect(within(card('기관')).getByText('삼성전기')).toBeTruthy();
    await waitFor(() =>
      expect(urls).toEqual([
        '/api/market/streaks?direction=buy',
        '/api/market/streaks?direction=sell',
      ]),
    );
  });

  it('카드마다 방향을 따로 저장하고, 서로의 선택을 지우지 않는다', async () => {
    mockApi();
    const first = renderCards();
    await screen.findByText('셀트리온');

    await userEvent.click(within(card('외국인')).getByRole('button', { name: '순매도' }));
    await within(card('외국인')).findByText('삼성전자');
    await userEvent.click(within(card('기관')).getByRole('button', { name: '순매도' }));
    await within(card('기관')).findByText('NAVER');
    // 되돌린 쪽만 바뀐다 — 한 저장 키를 두 카드가 나눠 쓰므로 병합하지 않으면
    // 나중 쓰기가 앞 선택을 지운다.
    await userEvent.click(within(card('기관')).getByRole('button', { name: '순매수' }));
    await within(card('기관')).findByText('삼성전기');

    expect(JSON.parse(localStorage.getItem('market.actorNetDirection.v1')!)).toEqual({
      외국인: 'sell',
      기관: 'buy',
    });

    // 새로고침(=재마운트) 후에도 각자의 선택이 살아 있다.
    first.unmount();
    renderCards();
    expect(await within(card('외국인')).findByText('삼성전자')).toBeTruthy();
    expect(within(card('기관')).getByText('삼성전기')).toBeTruthy();
  });

  it('빈 상태 문구가 방향을 말한다', async () => {
    vi.spyOn(client, 'apiCall').mockImplementation((async () => ({
      warnings: [], 외국인: [], 기관: [],
    })) as unknown as typeof client.apiCall);
    renderCards();

    // "연속 순매수 종목이 없습니다" 를 순매도 화면에서 보이면 어느 방향이 빈 건지 모른다.
    expect((await screen.findAllByText('연속 순매수 종목이 없습니다.')).length).toBe(2);
    await userEvent.click(within(card('외국인')).getByRole('button', { name: '순매도' }));
    expect(await screen.findByText('연속 순매도 종목이 없습니다.')).toBeTruthy();
  });
});
