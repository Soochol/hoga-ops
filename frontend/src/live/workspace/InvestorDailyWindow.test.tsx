import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InvestorNetPoint, InvestorSubjectBreakdown } from '../../api/types';
import { useInvestorDailySpanStore } from '../../state/investorDailySpan';
import { todayKstYyyymmdd } from '../liveDateTime';

const useLivePastInvestorNet = vi.fn();
vi.mock('../../api/livePastInvestorNet', () => ({
  useLivePastInvestorNet: (...args: unknown[]) => useLivePastInvestorNet(...args),
}));

const { InvestorDailyWindow } = await import('./InvestorDailyWindow');

/** 실측 행(005930 · 20260803). 백엔드 `ROW_59` · `investorDailyRows.test.ts` 와 같은 값. */
const MEASURED: InvestorSubjectBreakdown = {
  individual: 8_658_155,
  native_foreign: 27_186,
  other_corp: 278_288,
  fin_invest: -3_563_890,
  insurance: 51_236,
  trust: -1_292_721,
  other_fin: 8_289,
  bank: 6_344,
  pension: -129_133,
  private_fund: -120_079,
  nation: 0,
};

const anchor = (yyyymmdd: string) =>
  Date.parse(
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}T09:00:00+09:00`,
  );

const point = (date: string, breakdown: InvestorSubjectBreakdown | null = MEASURED): InvestorNetPoint => ({
  t_ms: anchor(date),
  foreign_net: -3_896_489,
  institution_net: -5_039_954,
  breakdown,
});

function mockPoints(points: InvestorNetPoint[]) {
  useLivePastInvestorNet.mockReturnValue({ data: { points }, isLoading: false, error: null });
}

const DATES = ['20260728', '20260729', '20260730', '20260731', '20260803', '20260804'];

beforeEach(() => {
  useLivePastInvestorNet.mockReset();
  useInvestorDailySpanStore.setState({ span: 20 });
});

describe('InvestorDailyWindow', () => {
  it('상위 4주체와 기관 세부 8종을 모두 컬럼으로 세운다', () => {
    mockPoints([point('20260803')]);
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    for (const label of [
      '개인', '외국인', '기관계', '기타법인',
      '금융투자', '보험', '투신', '기타금융', '은행', '연기금등', '사모펀드', '국가',
    ]) {
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument();
    }
  });

  it('실측 행의 값을 그대로 그린다 — 개인·기관 세부 포함', () => {
    mockPoints([point('20260803')]);
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    const row = screen.getByTestId('investor-daily-row-20260803');
    expect(within(row).getByText('+8,658,155')).toBeInTheDocument();  // 개인
    expect(within(row).getByText('-3,563,890')).toBeInTheDocument();  // 금융투자
    expect(within(row).getByText('-1,292,721')).toBeInTheDocument();  // 투신
  });

  it('기간 칩은 표시 행 수만 바꾸고 **재요청하지 않는다**', () => {
    mockPoints(DATES.map((d) => point(d)));
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    expect(screen.getAllByTestId(/^investor-daily-row-/)).toHaveLength(6);
    const argsBefore = useLivePastInvestorNet.mock.calls.at(-1);

    fireEvent.click(screen.getByRole('button', { name: '5일' }));

    expect(screen.getAllByTestId(/^investor-daily-row-/)).toHaveLength(5);
    // 같은 (code, from, to) 여야 react-query 키가 갈리지 않는다 — 갈리면 칩을 누를
    // 때마다 벤더 콜이 나가고, 이 창의 "콜 1회" 설계가 무너진다.
    expect(useLivePastInvestorNet.mock.calls.at(-1)).toEqual(argsBefore);
  });

  it('요청 구간은 최장 기간(60거래일)을 덮는 달력 구간이다', () => {
    mockPoints([point('20260803')]);
    useInvestorDailySpanStore.setState({ span: 5 });
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    const [code, from, to] = useLivePastInvestorNet.mock.calls[0] as [string, string, string];
    expect(code).toBe('005930');
    expect(to).toBe(todayKstYyyymmdd());
    // 60거래일 ≈ 84달력일. 그보다 짧으면 60일 칩이 데이터를 다 못 채운다.
    const spanDays = (Date.parse(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}`)
      - Date.parse(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}`)) / 86_400_000;
    expect(spanDays).toBeGreaterThanOrEqual(84);
  });

  it('커서 날짜 행만 강조한다', () => {
    mockPoints([point('20260803'), point('20260804')]);
    render(<InvestorDailyWindow code="005930" cursorDate="20260803" />);

    expect(screen.getByTestId('investor-daily-row-20260803').className).toContain('bg-tint-selection');
    expect(screen.getByTestId('investor-daily-row-20260804').className).not.toContain('bg-tint-selection');
  });

  it('오늘 행에는 잠정 표식이 붙는다 — 확정치와 같은 표에 있으므로', () => {
    const today = todayKstYyyymmdd();
    mockPoints([point('20260803'), point(today)]);
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    expect(within(screen.getByTestId(`investor-daily-row-${today}`)).getByText('잠정')).toBeInTheDocument();
    expect(within(screen.getByTestId('investor-daily-row-20260803')).queryByText('잠정')).toBeNull();
  });

  it('분해가 없는 날은 빈 칸이고, 누적이 덜 더해진 사실을 말한다', () => {
    mockPoints([point('20260803'), point('20260804', null)]);
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    // 0 으로 그리면 "그날 개인 순매수 0" 이라는 거짓말이 된다.
    const stale = screen.getByTestId('investor-daily-row-20260804');
    expect(within(stale).queryByText('0')).toBeNull();
    expect(screen.getByText('−1일')).toBeInTheDocument();
  });

  it('데이터가 없으면 빈 상태를 보여 준다 — 무자격 dev 의 정상 경로다', () => {
    mockPoints([]);
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    expect(screen.getByText('일별 투자자 데이터 없음')).toBeInTheDocument();
  });
});
