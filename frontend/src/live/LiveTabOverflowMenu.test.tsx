import { fireEvent, render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { LiveTabOverflowMenu } from './LiveTabOverflowMenu';
import type { LiveTab } from '../state/liveTabs';

const tabs: LiveTab[] = [
  { id: 'a', code: '005930', label: '삼성전자', timeframe: '1m', historicalFromDate: null, viewport: null },
  { id: 'b', code: '000660', label: 'SK하이닉스', timeframe: '1m', historicalFromDate: null, viewport: null },
  { id: 'c', code: '035420', label: 'NAVER', timeframe: 'D', historicalFromDate: null, viewport: null },
];

function setup() {
  const onFocus = vi.fn();
  render(<LiveTabOverflowMenu tabs={tabs} activeTabId="b" onFocus={onFocus} />);
  return { onFocus };
}

it('opens a list of all tabs', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  expect(screen.getByRole('dialog', { name: '열린 탭' })).toBeInTheDocument();
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  expect(screen.getByText('NAVER')).toBeInTheDocument();
});

it('filters by label and code', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: '005930' } });
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.queryByText('SK하이닉스')).toBeNull();
  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: 'nav' } });
  expect(screen.getByText('NAVER')).toBeInTheDocument();
  expect(screen.queryByText('삼성전자')).toBeNull();
});

it('selects a tab and closes the menu', () => {
  const { onFocus } = setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.click(screen.getByText('NAVER'));
  expect(onFocus).toHaveBeenCalledWith('c');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('closes the menu on Escape', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('closes the menu on outside mousedown', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('shows an empty state when no tabs match the query', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: 'no-match' } });
  expect(screen.getByText('일치하는 탭 없음')).toBeInTheDocument();
});

it('bounds the rendered result list and lets search reach later tabs', () => {
  const manyTabs = Array.from({ length: 250 }, (_, index): LiveTab => ({
    id: `tab-${index}`,
    code: String(100000 + index),
    label: `종목 ${index + 1}`,
    timeframe: '1m',
    historicalFromDate: null,
    viewport: null,
  }));
  const onFocus = vi.fn();
  render(<LiveTabOverflowMenu tabs={manyTabs} activeTabId="tab-0" onFocus={onFocus} />);
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));

  expect(screen.queryByText('종목 250')).toBeNull();
  expect(screen.getByText('250개 중 200개 표시')).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: '100249' } });
  expect(screen.getByText('종목 250')).toBeInTheDocument();
  fireEvent.click(screen.getByText('종목 250'));
  expect(onFocus).toHaveBeenCalledWith('tab-249');
});

it('marks the active tab', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  expect(screen.getByLabelText('활성 탭: SK하이닉스')).toBeInTheDocument();
});
