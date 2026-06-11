import { it, expect, vi } from 'vitest';
import { type ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveTabBar } from './LiveTabBar';
import type { LiveTab } from '../state/liveTabs';

const tabs: LiveTab[] = [
  { id: 'a', code: '005930', label: '삼성전자', timeframe: '1m', historicalFromDate: null },
  { id: 'b', code: '000660', label: 'SK하이닉스', timeframe: '1m', historicalFromDate: null },
];

function setup(over: Partial<ComponentProps<typeof LiveTabBar>> = {}) {
  const props: ComponentProps<typeof LiveTabBar> = {
    tabs, activeTabId: 'a', activeLoading: false, atCap: false,
    onFocus: vi.fn(), onClose: vi.fn(), onReorder: vi.fn(), onNewTab: vi.fn(),
    ...over,
  };
  render(<LiveTabBar {...props} />);
  return props;
}

it('renders the stock name only (code hidden when the name is known)', () => {
  setup();
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.queryByText('005930')).toBeNull();
});

it('falls back to the code when the name is unknown (label === code)', () => {
  setup({
    tabs: [{ id: 'x', code: '123456', label: '123456', timeframe: '1m', historicalFromDate: null }],
    activeTabId: 'x',
  });
  expect(screen.getByText('123456')).toBeInTheDocument();
});

it('clicking a tab calls onFocus with its id', () => {
  const p = setup();
  fireEvent.click(screen.getByText('SK하이닉스'));
  expect(p.onFocus).toHaveBeenCalledWith('b');
});

it('clicking the close button calls onClose, not onFocus', () => {
  const p = setup();
  fireEvent.click(screen.getByLabelText('005930 닫기'));
  expect(p.onClose).toHaveBeenCalledWith('a');
  expect(p.onFocus).not.toHaveBeenCalled();
});

it('middle-click closes the tab', () => {
  const p = setup();
  fireEvent.mouseDown(screen.getByText('SK하이닉스').closest('[data-tab-id]')!, { button: 1 });
  expect(p.onClose).toHaveBeenCalledWith('b');
});

it('the new-tab button calls onNewTab', () => {
  const p = setup();
  fireEvent.click(screen.getByLabelText('새 탭'));
  expect(p.onNewTab).toHaveBeenCalled();
});

it('disables the new-tab button at the cap', () => {
  setup({ atCap: true });
  expect(screen.getByLabelText('새 탭')).toBeDisabled();
});
