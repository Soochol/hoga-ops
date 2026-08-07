/** 업종 수급 카드 — 프로토타입 판정(B + 주체 토글)이 지키려던 계약을 고정한다.
 *
 * 값은 2026-08-07 장중 ka10051 실응답에서 가져왔다. 합성값을 쓰면 이 카드가 풀려던
 * 문제(한 방향으로 쏠린 날의 가독성)가 픽스처에서 사라진다.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { SectorFlowCard } from './SectorFlowCard';

const FLOW = {
  date: '20260807',
  unit: 'amt_eok',
  sampled_at_ms: 1_786_000_000_000,
  markets: {
    KOSPI: [
      { code: '001', name: '종합(KOSPI)', value: 6200.89, change_pct: -1.22, individual: -701, foreign: -3942, institution: 4723 },
      // 외국인 기준으로는 제조가 1위, 개인 기준으로는 대형주가 1위 — 토글이 순서를 바꾸는지 본다.
      { code: '027', name: '제조', value: 1000, change_pct: -1.13, individual: -1919, foreign: -2601, institution: 4669 },
      { code: '002', name: '대형주', value: 2000, change_pct: -1.23, individual: -1785, foreign: -2543, institution: 4389 },
      { code: '009', name: '제약', value: 3000, change_pct: 0.56, individual: -3011, foreign: 281, institution: 145 },
    ],
    KOSDAQ: [
      { code: '101', name: '종합(KOSDAQ)', value: 779.03, change_pct: -2.82, individual: 3453, foreign: -2435, institution: -1129 },
    ],
  },
};

const BREADTH = {
  markets: {
    KOSPI: { new_high_52w: { count: 31, truncated: false }, new_low_52w: { count: 14, truncated: false } },
    KOSDAQ: { new_high_52w: { count: 12, truncated: true }, new_low_52w: { count: 5, truncated: false } },
  },
};

function mockApi(flow: unknown = FLOW, breadth: unknown = BREADTH) {
  vi.spyOn(client, 'apiCall').mockImplementation((async (url: string) => {
    if (url.startsWith('/api/market/sector-flow')) return flow;
    if (url.startsWith('/api/market/breadth')) return breadth;
    return {};
  }) as unknown as typeof client.apiCall);
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SectorFlowCard />
    </QueryClientProvider>,
  );
}

/** 표의 업종 열만 순서대로. 종합 행 포함. */
function rowNames(): string[] {
  return Array.from(document.querySelectorAll('tbody tr')).map(
    (tr) => tr.querySelector('td')?.textContent?.trim() ?? '',
  );
}

describe('SectorFlowCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('세 주체 열이 항상 보이고 종합이 맨 위에 고정된다', async () => {
    // 토글은 "무엇을 보나" 가 아니라 "무엇으로 고르나" 다 — 열은 안 사라진다.
    mockApi();
    renderCard();

    expect(await screen.findByText('종합(KOSPI)')).toBeTruthy();
    for (const label of ['외국인', '기관', '개인']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeTruthy();
    }
    expect(rowNames()[0]).toBe('종합(KOSPI)');
  });

  it('주체 토글이 정렬·절단 기준을 바꾼다', async () => {
    mockApi();
    renderCard();
    await screen.findByText('종합(KOSPI)');

    // 외국인 기준: |−2601| > |−2543| > |281|
    expect(rowNames()).toEqual(['종합(KOSPI)', '제조', '대형주', '제약']);

    await userEvent.click(within(screen.getByLabelText('정렬 기준')).getByText('개인'));

    // 개인 기준: |−3011| > |−1919| > |−1785| — **제약이 꼴찌에서 1위로** 올라온다
    expect(rowNames()).toEqual(['종합(KOSPI)', '제약', '제조', '대형주']);
    // 어느 축으로 세웠는지 화면이 말한다 — 정렬만 바뀌고 표시가 그대로면 읽는 사람이
    // 무엇을 보고 있는지 모른다.
    expect(screen.getByRole('columnheader', { name: '개인' }).className).toContain('text-fg');
  });

  it('시장 토글이 코스닥 행으로 바꾼다', async () => {
    mockApi();
    renderCard();
    await screen.findByText('종합(KOSPI)');

    await userEvent.click(within(screen.getByLabelText('시장')).getByText('코스닥'));
    expect(await screen.findByText('종합(KOSDAQ)')).toBeTruthy();
    expect(screen.queryByText('종합(KOSPI)')).toBeNull();
  });

  it('선택이 새로고침을 넘어 유지된다', async () => {
    mockApi();
    const { unmount } = renderCard();
    await screen.findByText('종합(KOSPI)');
    await userEvent.click(within(screen.getByLabelText('시장')).getByText('코스닥'));
    await screen.findByText('종합(KOSDAQ)');
    unmount();

    mockApi();
    renderCard();
    expect(await screen.findByText('종합(KOSDAQ)')).toBeTruthy();
  });

  it('52주 신고·신저를 한 줄로 싣고 절사를 + 로 말한다', async () => {
    // 시장 폭 카드에서 살아남은 유일한 값이다. `truncated` 면 카운트는 **하한**(#1099).
    mockApi();
    renderCard();

    // 값이 여러 span 으로 쪼개져 있어 getByText 로는 못 잡는다 — 줄 전체를 읽는다.
    // 라벨은 즉시 뜨고 값은 breadth 쿼리가 온 뒤라 waitFor 가 필요하다.
    const line = (await screen.findByText(/52주 신고 · 신저/)).parentElement!;
    await waitFor(() => expect(line.textContent).toContain('코스피 31 · 14'));
    expect(line.textContent).toContain('코스닥 12+ · 5');
  });

  it('표본이 없으면 왜 비었는지 말한다', async () => {
    mockApi({ date: '20260807', unit: 'amt_eok', sampled_at_ms: null, markets: {} });
    renderCard();

    expect(await screen.findByText(/표본이 아직 없습니다/)).toBeTruthy();
  });

  it('값이 null 이면 0 이 아니라 — 로 그린다', async () => {
    // null 은 "안 샀다" 가 아니라 "벤더가 말하지 않았다" 다.
    mockApi({
      ...FLOW,
      markets: {
        KOSPI: [{ code: '001', name: '종합(KOSPI)', value: null, change_pct: null, individual: null, foreign: null, institution: null }],
      },
    });
    renderCard();

    await screen.findByText('종합(KOSPI)');
    const cells = Array.from(document.querySelectorAll('tbody tr td')).map((td) => td.textContent);
    expect(cells.filter((c) => c === '—').length).toBeGreaterThanOrEqual(4);
  });
});
