/** 업종 수급 카드 — 정렬과 세 주체의 공통 농도 기준을 검증한다.
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

function mockApi(flow: unknown = FLOW, breadth: unknown = BREADTH, sectors: unknown = {}) {
  vi.spyOn(client, 'apiCall').mockImplementation((async (url: string) => {
    if (url.startsWith('/api/market/sector-flow')) return flow;
    if (url.startsWith('/api/market/breadth')) return breadth;
    if (url.startsWith('/api/market/sectors')) return sectors;
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
    mockApi();
    renderCard();

    expect(await screen.findByText('종합(KOSPI)')).toBeTruthy();
    for (const label of ['외국인', '기관', '개인']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeTruthy();
      expect(within(screen.getByRole('columnheader', { name: label })).getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.queryByLabelText('정렬 기준')).toBeNull();
    for (const label of ['기본순', '상승순', '하락순']) expect(screen.queryByRole('button', { name: label })).toBeNull();
    expect(rowNames()[0]).toBe('종합(KOSPI)');
  });

  it.each([
    ['업종', 'ascending', ['대형주', '제약', '제조'], ['제조', '제약', '대형주']],
    ['등락', 'descending', ['제약', '제조', '대형주'], ['대형주', '제조', '제약']],
    ['외국인', 'descending', ['제약', '대형주', '제조'], ['제조', '대형주', '제약']],
    ['기관', 'descending', ['제조', '대형주', '제약'], ['제약', '대형주', '제조']],
    ['개인', 'descending', ['대형주', '제조', '제약'], ['제약', '제조', '대형주']],
  ] as const)('%s 헤더가 두 방향과 제공 순서를 순환하고 종합 행을 고정한다', async (label, direction, first, second) => {
    mockApi();
    renderCard();
    await screen.findByText('종합(KOSPI)');

    const header = screen.getByRole('columnheader', { name: label });
    const button = within(header).getByRole('button');
    expect(header).toHaveAttribute('aria-sort', 'none');
    expect(rowNames()).toEqual(['종합(KOSPI)', '제조', '대형주', '제약']);
    await userEvent.click(button);
    expect(rowNames()).toEqual(['종합(KOSPI)', ...first]);
    expect(header).toHaveAttribute('aria-sort', direction);
    await userEvent.click(button);
    expect(rowNames()).toEqual(['종합(KOSPI)', ...second]);
    expect(header).toHaveAttribute('aria-sort', direction === 'ascending' ? 'descending' : 'ascending');
    await userEvent.click(button);
    expect(rowNames()).toEqual(['종합(KOSPI)', '제조', '대형주', '제약']);
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('다른 열을 누르면 첫 방향으로 시작하고 기본순은 시세 제공 순서로 돌아간다', async () => {
    mockApi(FLOW, BREADTH, { markets: { '0': { sectors: [
      { code: '009', change_pct: 0.56 }, { code: '002', change_pct: -1.23 }, { code: '027', change_pct: -1.13 },
    ] } } });
    renderCard();
    await screen.findByText('종합(KOSPI)');
    await userEvent.click(within(screen.getByRole('columnheader', { name: '업종' })).getByRole('button'));
    await userEvent.click(within(screen.getByRole('columnheader', { name: '업종' })).getByRole('button'));
    await userEvent.click(screen.getByRole('button', { name: '외국인' }));
    expect(screen.getByRole('columnheader', { name: '외국인' })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: '업종' })).toHaveAttribute('aria-sort', 'none');
    await userEvent.click(screen.getByRole('button', { name: '외국인' }));
    await userEvent.click(screen.getByRole('button', { name: '외국인' }));
    expect(rowNames()).toEqual(['종합(KOSPI)', '제약', '대형주', '제조']);
  });

  it('수급의 결측값은 오름차순과 내림차순 모두 마지막에 둔다', async () => {
    mockApi({ ...FLOW, markets: { KOSPI: [
      FLOW.markets.KOSPI[0], { ...FLOW.markets.KOSPI[1], foreign: null },
      { ...FLOW.markets.KOSPI[2], foreign: -100 }, { ...FLOW.markets.KOSPI[3], foreign: 100 },
    ] } });
    renderCard();
    await screen.findByText('종합(KOSPI)');
    await userEvent.click(screen.getByRole('button', { name: '외국인' }));
    expect(rowNames()).toEqual(['종합(KOSPI)', '제약', '대형주', '제조']);
    await userEvent.click(screen.getByRole('button', { name: '외국인' }));
    expect(rowNames()).toEqual(['종합(KOSPI)', '대형주', '제약', '제조']);
  });

  it('정렬과 관계없이 종합을 포함한 세 열이 같은 금액에 같은 농도를 사용한다', async () => {
    mockApi({ ...FLOW, markets: { KOSPI: [
      { ...FLOW.markets.KOSPI[0], foreign: 1000, institution: -500, individual: 0 },
      { ...FLOW.markets.KOSPI[1], foreign: -500, institution: 500, individual: -250 },
      { ...FLOW.markets.KOSPI[2], foreign: 500, institution: null, individual: -1 },
    ] } });
    renderCard();
    await screen.findByText('종합(KOSPI)');

    const background = (name: string, column: number) => {
      const row = screen.getByRole('row', { name: new RegExp(name) });
      return (within(row).getAllByRole('cell')[column] as HTMLElement).style.background;
    };
    for (const label of ['등락', '외국인', '기관', '개인', '업종']) {
      await userEvent.click(within(screen.getByRole('columnheader', { name: label })).getByRole('button'));
      expect(background('종합', 2)).toContain('var(--price-up) 45%');
      expect(background('종합', 3)).toContain('var(--price-down) 22.5%');
      expect(background('제조', 2)).toBe(background('종합', 3));
      expect(background('제조', 3)).toBe(background('대형주', 2));
      expect(background('제조', 3)).toContain('var(--price-up) 22.5%');
      expect(background('제조', 4)).toContain('var(--price-down) 11.25%');
      expect(background('대형주', 4)).toContain('var(--price-down)');
      expect(background('종합', 4)).toBe('');
      expect(background('대형주', 3)).toBe('');
    }
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
    const line = (await screen.findByText(/52주 신고·신저/)).parentElement!;
    await waitFor(() => expect(line.textContent).toContain('코스피 신고가 31 / 신저가 14'));
    expect(line.textContent).toContain('코스닥 신고가 12+ / 신저가 5');
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

  it('코드가 같은 행만 합치고 시세의 결측값과 수급 미제공을 보존한다', async () => {
    mockApi(FLOW, BREADTH, { markets: { '0': { sectors: [
      { code: '027', name: '제조업', change_pct: null },
      { code: '604', name: '고배당50', change_pct: 3 },
      { code: '9999', name: '제약', change_pct: 5 },
    ] } } });
    renderCard();
    await screen.findByText('고배당50');
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    // Same code, different vendor name: one row, the quote's null stays null.
    const manufacturing = rows.find(r => r.firstElementChild?.textContent === '제조')!;
    expect(manufacturing.children[1].textContent).toBe('—');
    expect(manufacturing.children[2].textContent).toBe('-2,601');
    expect(screen.queryByText('제조업')).toBeNull();
    // Same name, different code: separate rows; never borrow the other's flow.
    expect(rows.filter(r => r.firstElementChild?.textContent === '제약')).toHaveLength(2);
    const quoteOnly = rows.find(r => r.firstElementChild?.textContent === '고배당50')!;
    expect(Array.from(quoteOnly.children).map(td => td.textContent)).toEqual(['고배당50', '+3.00%', '—', '—', '—']);
    await userEvent.click(screen.getByRole('button', { name: '규모·대표지수' }));
    expect(screen.getByText('고배당50')).toBeTruthy();
    expect(screen.queryByText('제조')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '미분류' }));
    expect(rowNames()).toEqual(['종합(KOSPI)', '제약']);
  });

  it('등락률을 전체에서 정렬한 뒤 12개로 자르고 전체 보기에서 복원한다', async () => {
    mockApi({ markets: {} }, BREADTH, { markets: { '0': { sectors: [
      ...Array.from({ length: 13 }, (_, i) => ({ code: String(i), name: `지수${i}`, change_pct: i === 0 ? null : -i })),
      { code: '9999', name: '최대상승', change_pct: 20 },
    ] } } });
    renderCard();
    await screen.findByText('지수0');
    await userEvent.click(screen.getByRole('button', { name: '등락' }));
    expect(rowNames()[0]).toBe('최대상승');
    expect(rowNames()).toHaveLength(12);
    expect(screen.queryByText('지수0')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '전체 보기' }));
    expect(rowNames()).toHaveLength(14);
    expect(rowNames().at(-1)).toBe('지수0');
  });
});
