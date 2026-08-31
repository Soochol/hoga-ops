import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InvestorNetPoint, InvestorSubjectBreakdown } from '../../api/types';
import { useInvestorDailySpanStore } from '../../state/investorDailySpan';
import { useInvestorEstimateUnitStore } from '../../state/investorEstimateUnit';
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

function mockPoints(points: InvestorNetPoint[], unit = 'qty_shares') {
  useLivePastInvestorNet.mockReturnValue({
    data: { points, unit }, isLoading: false, error: null,
  });
}

const DATES = ['20260728', '20260729', '20260730', '20260731', '20260803', '20260804'];

beforeEach(() => {
  useLivePastInvestorNet.mockReset();
  useInvestorDailySpanStore.setState({ span: 20 });
  useInvestorEstimateUnitStore.setState({ unit: 'qty' });
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

  it('단위 토글이 축을 서버로 넘긴다 — ka10059 는 한 응답에 두 축을 안 준다', () => {
    mockPoints([point('20260803')]);
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);
    expect(useLivePastInvestorNet.mock.calls.at(-1)?.[3]).toBe('qty');

    fireEvent.click(screen.getByRole('button', { name: /표시 단위/ }));

    expect(useLivePastInvestorNet.mock.calls.at(-1)?.[3]).toBe('amount');
  });

  it('금액 응답은 억으로 접어 그린다', () => {
    // 실측 금액 축 행(005930 · 20260828 · amt_qty_tp=1, 백만원).
    // 409,731백만원 = 4,097.31억 → 10억 이상이라 소수 0자리(formatAmount 규칙).
    mockPoints([{
      t_ms: anchor('20260803'),
      foreign_net: -503_783,
      institution_net: -427_253,
      breakdown: { ...MEASURED, individual: 409_731 },
    }], 'amt_mwon');
    useInvestorEstimateUnitStore.setState({ unit: 'amount' });
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    const row = screen.getByTestId('investor-daily-row-20260803');
    expect(within(row).getByText('+4,097억')).toBeInTheDocument();
  });

  it('⚠ 셀은 **응답의 단위**로 그린다 — 토글이 앞서가도 옛 값을 새 단위로 안 읽는다', () => {
    // 축이 쿼리 키에 들어 있어 전환 직후 `placeholderData` 가 옛 축(수량) 데이터를
    // 넘겨주는 프레임이 있다. 그때 스토어를 따라 포맷하면 1,589,169주가
    // "15,892억" 으로 그려진다(#1119 부류, 100배 오독).
    mockPoints([point('20260803')], 'qty_shares');   // 데이터는 아직 수량
    useInvestorEstimateUnitStore.setState({ unit: 'amount' });  // 토글은 이미 금액
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    const row = screen.getByTestId('investor-daily-row-20260803');
    expect(within(row).getByText('+8,658,155')).toBeInTheDocument();
    expect(within(row).queryByText(/억/)).toBeNull();
    // 칩은 스토어를 따른다 — 눌림 상태와 숫자의 출처가 다른 것이 요점이다.
    expect(screen.getByRole('button', { name: /표시 단위/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('축 전환이 도착하기 전에는 **전환 중임을 말한다** — 버튼이 죽은 것과 구별된다', () => {
    // 축을 처음 바꾸면 벤더 콜드 walk-back 이라 실측 4~9초가 걸린다(2026-08-31
    // /browse). 그동안 옛 값이 제 단위로 얌전히 서 있으면 사용자에겐 아무 일도
    // 안 일어난 것으로 보인다 — 실제 사용자 보고였다.
    mockPoints([point('20260803')], 'qty_shares');   // 데이터는 아직 수량
    useInvestorEstimateUnitStore.setState({ unit: 'amount' });  // 요청은 금액
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    expect(screen.getByText('억 조회 중')).toBeInTheDocument();
    const row = screen.getByTestId('investor-daily-row-20260803');
    expect(row.closest('table')).toHaveAttribute('data-axis-pending');
    // 표는 **지우지 않는다** — 축을 오갈 때마다 사라지면 비교가 끊긴다. 범위를 행으로
    // 좁히는 것은 단일 행 픽스처에서 누적행이 같은 값을 들기 때문이다(표 전체로
    // 찾으면 "multiple elements" 로 터진다).
    expect(within(row).getByText('+8,658,155')).toBeInTheDocument();
  });

  it('축이 도착하면 흐림과 문구가 함께 사라진다', () => {
    mockPoints([point('20260803')], 'qty_shares');
    useInvestorEstimateUnitStore.setState({ unit: 'qty' });
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    expect(screen.queryByText(/조회 중/)).toBeNull();
    const table = screen.getByTestId('investor-daily-row-20260803').closest('table');
    expect(table).not.toHaveAttribute('data-axis-pending');
  });

  it('unit 이 없는 옛 백엔드 응답은 수량으로 읽는다', () => {
    useLivePastInvestorNet.mockReturnValue({
      data: { points: [point('20260803')] }, isLoading: false, error: null,
    });
    useInvestorEstimateUnitStore.setState({ unit: 'amount' });
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    const row = screen.getByTestId('investor-daily-row-20260803');
    expect(within(row).getByText('+8,658,155')).toBeInTheDocument();
  });

  it('데이터가 없으면 빈 상태를 보여 준다 — 무자격 dev 의 정상 경로다', () => {
    mockPoints([]);
    render(<InvestorDailyWindow code="005930" cursorDate={null} />);

    expect(screen.getByText('일별 투자자 데이터 없음')).toBeInTheDocument();
  });
});
