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

it('구분된 연결 정보·전체 제목을 읽기 목록으로 제공하고 클릭해도 펼치지 않는다', () => {
  render(<NewsWindow code="005930" name="삼성전자" />);
  expect(screen.getByText('종목코드 연결')).toBeInTheDocument();
  expect(screen.getByText('제목에 종목명')).toBeInTheDocument();
  const linkedOnly = screen.getByRole('checkbox', { name: /종목 연결만/ });
  expect(linkedOnly).toBeChecked();
  expect(screen.queryByText('조회 결과')).not.toBeInTheDocument();
  expect(screen.queryByText('다른 회사 소식')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  fireEvent.click(linkedOnly);
  expect(screen.getByText('조회 결과')).toBeInTheDocument();
  expect(screen.getByText('다른 회사 소식')).toBeInTheDocument();
  fireEvent.click(linkedOnly);
  expect(screen.getByText('삼성전자 투자 소식')).toBeInTheDocument();
  expect(screen.queryByText('다른 회사 소식')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /삼성전자 투자 소식/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('삼성전자 투자 소식'));
  expect(screen.queryByText(/제공 종목코드:/)).not.toBeInTheDocument();
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
