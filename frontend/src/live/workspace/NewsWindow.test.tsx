import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { StockNewsResponse } from '../../api/stockNews';
import { NewsWindow } from './NewsWindow';

const hook = vi.hoisted(() => vi.fn());
vi.mock('../../api/stockNews', () => ({ useStockNews: hook }));

const payload = (code = '005930'): StockNewsResponse => ({
  code, date: null, status: 'ok', limit: 40, fetched_at_ms: 1791464402000,
  items: [
    { id: 'code', title: '반도체 시장 소식', source: '테스트신문', published_at_ms: 1791464402000, related_codes: [code] },
    { id: 'title', title: '삼성전자 투자 소식', source: '테스트신문', published_at_ms: null, related_codes: ['000810'] },
    { id: 'other', title: '다른 회사 소식', source: '테스트신문', published_at_ms: null, related_codes: ['000810'] },
  ],
});
const result = (data: StockNewsResponse | undefined, extra = {}) => ({
  data, isError: false, isPending: false, isFetching: false, refetch: vi.fn(), ...extra,
});

beforeEach(() => {
  hook.mockReset();
  hook.mockReturnValue(result(payload()));
});

it('기사별 연결 사유 없이 출처·시각·전체 제목을 제공하고 연결 필터는 유지한다', () => {
  render(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.queryByText('종목코드 연결')).not.toBeInTheDocument();
  expect(screen.queryByText('제목에 종목명')).not.toBeInTheDocument();
  expect(screen.getByText('반도체 시장 소식')).toBeInTheDocument();
  expect(screen.getByText('삼성전자 투자 소식')).toBeInTheDocument();
  expect(screen.getAllByText('테스트신문')).toHaveLength(2);
  expect(screen.getByText('시각 미상')).toBeInTheDocument();
  expect(screen.getByText('10. 08. 22:00')).toBeInTheDocument();
  const linkedOnly = screen.getByRole('checkbox', { name: /종목 연결만/ });
  expect(linkedOnly).toBeChecked();
  expect(screen.queryByText('조회 결과')).not.toBeInTheDocument();
  expect(screen.queryByText('다른 회사 소식')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  fireEvent.click(linkedOnly);
  expect(screen.queryByText('종목코드 연결')).not.toBeInTheDocument();
  expect(screen.queryByText('제목에 종목명')).not.toBeInTheDocument();
  expect(screen.queryByText('조회 결과')).not.toBeInTheDocument();
  expect(screen.getAllByText('테스트신문')).toHaveLength(3);
  expect(screen.getByText('다른 회사 소식')).toBeInTheDocument();
  fireEvent.click(linkedOnly);
  expect(screen.getByText('반도체 시장 소식')).toBeInTheDocument();
  expect(screen.getByText('삼성전자 투자 소식')).toBeInTheDocument();
  expect(screen.queryByText('다른 회사 소식')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /삼성전자 투자 소식/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('삼성전자 투자 소식'));
  expect(screen.queryByText(/제공 종목코드:/)).not.toBeInTheDocument();
});

it('날짜·종목을 바꿔도 표시 필터를 유지하고 새 창은 저장된 필터와 최신 날짜로 시작한다', () => {
  const changed = vi.fn();
  const view = render(<NewsWindow code="005930" name="삼성전자" onLinkedOnlyChange={changed} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /종목 연결만/ }));
  expect(changed).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByLabelText('뉴스 날짜'), { target: { value: '2026-10-07' } });
  expect(screen.getByRole('checkbox', { name: /종목 연결만/ })).not.toBeChecked();
  view.rerender(<NewsWindow key="new-code" code="000660" name="SK하이닉스" linkedOnly={false} />);
  expect(screen.getByRole('checkbox', { name: /종목 연결만/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: '최신' })).toHaveAttribute('aria-pressed', 'true');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  expect(screen.getByLabelText('뉴스 날짜')).toHaveValue(today);
  expect(hook).toHaveBeenLastCalledWith('000660', null);
});

it('제목을 부분 일치로 검색하고 공백·대소문자·지우기와 종목 필터를 함께 처리한다', () => {
  const data = payload();
  data.items[0].title = '반도체 AI 투자 전망';
  data.items[2].title = '다른 회사 ai 투자 소식';
  hook.mockReturnValue(result(data));
  render(<NewsWindow code="005930" name="삼성전자" />);
  const search = screen.getByRole('searchbox', { name: '뉴스 제목 검색' });
  fireEvent.change(search, { target: { value: '  aI  ' } });
  expect(screen.getByText('반도체 AI 투자 전망')).toBeInTheDocument();
  expect(screen.queryByText('다른 회사 ai 투자 소식')).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /종목 연결만\s*1건/ })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: /종목 연결만/ }));
  expect(screen.getByText('다른 회사 ai 투자 소식')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /종목 연결만\s*2건/ })).not.toBeChecked();
  fireEvent.change(search, { target: { value: '삼성전자 투자' } });
  expect(screen.getByText('삼성전자 투자 소식')).toBeInTheDocument();
  expect(screen.queryByText('반도체 AI 투자 전망')).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: '   ' } });
  expect(screen.getAllByText('테스트신문')).toHaveLength(3);
  fireEvent.change(search, { target: { value: '없는 제목' } });
  expect(screen.getByText('검색어와 일치하는 제목이 없습니다.')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /종목 연결만\s*0건/ })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '뉴스 제목 검색 지우기' }));
  expect(search).toHaveValue('');
  expect(screen.getAllByText('테스트신문')).toHaveLength(3);
});

it('검색어를 새로고침·새 뉴스 수용·날짜·종목 전환에 유지하며 이전 기사는 노출하지 않는다', () => {
  const refetch = vi.fn();
  hook.mockReturnValue(result(payload(), { refetch }));
  const view = render(<NewsWindow code="005930" name="삼성전자" />);
  const search = screen.getByRole('searchbox', { name: '뉴스 제목 검색' });
  fireEvent.change(search, { target: { value: '새 기사' } });
  const list = screen.getByLabelText('삼성전자 뉴스 목록');
  list.scrollTop = 80;
  fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
  expect(refetch).toHaveBeenCalledOnce();
  expect(search).toHaveValue('새 기사');
  const next = payload();
  next.items = [{ ...next.items[0], id: 'new', title: '삼성전자 새 기사' }, ...next.items];
  hook.mockReturnValue(result(next));
  view.rerender(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.queryByText('삼성전자 새 기사')).not.toBeInTheDocument();
  expect(list.scrollTop).toBe(80);
  fireEvent.click(screen.getByRole('button', { name: /새 뉴스 1건/ }));
  expect(search).toHaveValue('새 기사');
  expect(screen.getByText('삼성전자 새 기사')).toBeInTheDocument();
  expect(screen.queryByText('반도체 시장 소식')).not.toBeInTheDocument();
  expect(list.scrollTop).toBe(0);
  hook.mockReturnValue(result(undefined, { isPending: true, isFetching: true }));
  fireEvent.change(screen.getByLabelText('뉴스 날짜'), { target: { value: '2026-10-07' } });
  expect(search).toHaveValue('새 기사');
  expect(screen.queryByText('삼성전자 새 기사')).not.toBeInTheDocument();
  expect(screen.getByText('뉴스를 불러오는 중입니다.')).toBeInTheDocument();
  expect(screen.queryByText('검색어와 일치하는 제목이 없습니다.')).not.toBeInTheDocument();
  view.rerender(<NewsWindow code="000660" name="SK하이닉스" />);
  expect(search).toHaveValue('새 기사');
  expect(screen.queryByText('삼성전자 새 기사')).not.toBeInTheDocument();
  expect(hook).toHaveBeenLastCalledWith('000660', '20261007');
});

it('검색 불일치가 조회 실패·원래 빈 결과·종목 연결 불일치 안내를 대신하지 않는다', () => {
  hook.mockReturnValue(result({ ...payload(), status: 'error', items: [] }));
  const view = render(<NewsWindow code="005930" name="삼성전자" />);
  fireEvent.change(screen.getByRole('searchbox', { name: '뉴스 제목 검색' }), { target: { value: '없는 제목' } });
  expect(screen.getByRole('status')).toHaveTextContent('뉴스 조회에 실패했습니다.');
  expect(screen.queryByText('검색어와 일치하는 제목이 없습니다.')).not.toBeInTheDocument();
  hook.mockReturnValue(result({ ...payload(), items: [] }));
  view.rerender(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.getByText('한국투자 조회 결과에 뉴스가 없습니다.')).toBeInTheDocument();
  expect(screen.queryByText('검색어와 일치하는 제목이 없습니다.')).not.toBeInTheDocument();
  hook.mockReturnValue(result({ ...payload('000810'), items: [payload('000810').items[0]] }));
  fireEvent.change(screen.getByLabelText('뉴스 날짜'), { target: { value: '2026-10-07' } });
  expect(screen.getByText('종목 연결 정보가 일치하는 기사가 없습니다.')).toBeInTheDocument();
  expect(screen.queryByText('검색어와 일치하는 제목이 없습니다.')).not.toBeInTheDocument();
});

it('갱신된 뉴스는 읽던 목록을 밀지 않고 수동 반영한다', () => {
  const view = render(<NewsWindow code="005930" name="삼성전자" />);
  const list = screen.getByLabelText('삼성전자 뉴스 목록');
  list.scrollTop = 80;
  const next = payload();
  next.items = [{ ...next.items[0], id: 'new', title: '새로 도착한 기사' }, ...next.items];
  hook.mockReturnValue(result(next));
  view.rerender(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.queryByText('새로 도착한 기사')).not.toBeInTheDocument();
  expect(list.scrollTop).toBe(80);
  fireEvent.click(screen.getByRole('button', { name: /새 뉴스 1건/ }));
  expect(screen.getByText('새로 도착한 기사')).toBeInTheDocument();
  expect(list.scrollTop).toBe(0);
  expect(screen.queryByRole('button', { name: /새 뉴스/ })).not.toBeInTheDocument();
});

it('종목 변경 중 이전 뉴스가 남지 않는다', () => {
  const view = render(<NewsWindow code="005930" name="삼성전자" />);
  hook.mockReturnValue(result(undefined, { isPending: true, isFetching: true }));
  view.rerender(<NewsWindow code="000660" name="SK하이닉스" />);
  expect(screen.queryByText('삼성전자 투자 소식')).not.toBeInTheDocument();
  expect(screen.getByText('뉴스를 불러오는 중입니다.')).toBeInTheDocument();
  expect(hook).toHaveBeenLastCalledWith('000660', null);
});

it('날짜를 변경하면 목록을 초기화하고 한정된 빈 결과로 안내한다', () => {
  render(<NewsWindow code="005930" name="삼성전자" />);
  hook.mockReturnValue(result({ ...payload(), date: '20261007', items: [] }));
  fireEvent.change(screen.getByLabelText('뉴스 날짜'), { target: { value: '2026-10-07' } });
  expect(hook).toHaveBeenLastCalledWith('005930', '20261007');
  expect(screen.queryByText('삼성전자 투자 소식')).not.toBeInTheDocument();
  expect(screen.getByText(/선택일 기사 없음/)).toBeInTheDocument();
  expect(screen.getByText(/선택일 최대 40건/)).toBeInTheDocument();
});

it('조회 실패 시 이전 목록과 실패 안내를 함께 유지한다', () => {
  const view = render(<NewsWindow code="005930" name="삼성전자" />);
  hook.mockReturnValue(result({ ...payload(), status: 'error' }));
  view.rerender(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.getByText('삼성전자 투자 소식')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('이전 결과를 표시합니다.');
});

it('이전 결과를 표시하는 상태로 처음 열어도 복구 후 새 뉴스는 수동 반영한다', () => {
  hook.mockReturnValue(result({ ...payload(), status: 'error' }));
  const view = render(<NewsWindow code="005930" name="삼성전자" />);
  const next = payload();
  next.items = [{ ...next.items[0], id: 'recovered', title: '복구 후 새 기사' }, ...next.items];
  hook.mockReturnValue(result(next));
  view.rerender(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.queryByText('복구 후 새 기사')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /새 뉴스 1건/ })).toBeInTheDocument();
});

it('설정 누락과 성공한 빈 응답을 구별한다', () => {
  hook.mockReturnValue(result({ ...payload(), status: 'unconfigured', items: [], fetched_at_ms: null }));
  const view = render(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.getByText('한국투자 API 설정이 필요합니다.')).toBeInTheDocument();
  view.unmount();
  hook.mockReturnValue(result({ ...payload(), items: [] }));
  render(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.getByText('한국투자 조회 결과에 뉴스가 없습니다.')).toBeInTheDocument();
});
