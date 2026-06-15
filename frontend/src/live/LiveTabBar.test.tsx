import { it, expect, vi } from 'vitest';
import { type ComponentProps } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LiveTabBar } from './LiveTabBar';
import type { LiveTab } from '../state/liveTabs';

const tabs: LiveTab[] = [
  { id: 'a', code: '005930', label: '삼성전자', timeframe: '1m', historicalFromDate: null, viewport: null },
  { id: 'b', code: '000660', label: 'SK하이닉스', timeframe: '1m', historicalFromDate: null, viewport: null },
];

function setup(over: Partial<ComponentProps<typeof LiveTabBar>> = {}) {
  const props: ComponentProps<typeof LiveTabBar> = {
    tabs, activeTabId: 'a', activeLoading: false,
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
    tabs: [{ id: 'x', code: '123456', label: '123456', timeframe: '1m', historicalFromDate: null, viewport: null }],
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

it('shows an unlimited tab count and keeps the new-tab button enabled', () => {
  setup();
  expect(screen.getByText('2 open')).toBeInTheDocument();
  expect(screen.getByLabelText('새 탭')).toBeEnabled();
});

it('selects a tab through the overflow menu', () => {
  const p = setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.click(within(screen.getByRole('dialog')).getByText('SK하이닉스'));
  expect(p.onFocus).toHaveBeenCalledWith('b');
});

it('scrolls the active tab into view when activeTabId changes', () => {
  const scrollIntoView = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  try {
    const { rerender } = render(
      <LiveTabBar
        tabs={tabs}
        activeTabId="a"
        activeLoading={false}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
      />
    );
    scrollIntoView.mockClear();
    rerender(
      <LiveTabBar
        tabs={tabs}
        activeTabId="b"
        activeLoading={false}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
      />
    );
    const activeTab = screen.getByText('SK하이닉스').closest('[data-tab-id]')!;
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(activeTab).toHaveAttribute('data-tab-id', 'b');
    expect(activeTab).toHaveAttribute('aria-selected', 'true');
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

it('keeps fixed actions outside the scrollable tablist', () => {
  const manyTabs = Array.from({ length: 24 }, (_, index): LiveTab => ({
    id: `tab-${index}`,
    code: String(100000 + index),
    label: `종목 ${index + 1}`,
    timeframe: '1m',
    historicalFromDate: null,
    viewport: null,
  }));
  setup({ tabs: manyTabs, activeTabId: 'tab-0' });

  const tablist = screen.getByRole('tablist');
  const newTabButton = screen.getByLabelText('새 탭');
  const overflowButton = screen.getByLabelText('열린 탭 목록');
  const tabCount = screen.getByText('24 open');

  expect(within(tablist).queryByLabelText('새 탭')).toBeNull();
  expect(within(tablist).queryByLabelText('열린 탭 목록')).toBeNull();
  expect(within(tablist).queryByText('24 open')).toBeNull();
  expect(tablist).not.toContainElement(newTabButton);
  expect(tablist).not.toContainElement(overflowButton);
  expect(tablist).not.toContainElement(tabCount);
});

it('drag-and-drop reorders via onReorder(from, to)', () => {
  const p = setup();
  const elA = screen.getByText('삼성전자').closest('[data-tab-id]')!;
  const elB = screen.getByText('SK하이닉스').closest('[data-tab-id]')!;
  // jsdom DragEvent.dataTransfer is null — provide a stub that round-trips the index.
  const store: Record<string, string> = {};
  const dataTransfer = {
    setData: (k: string, v: string) => { store[k] = v; },
    getData: (k: string) => store[k] ?? '',
    types: ['text/tab-index'],
    effectAllowed: '',
  };
  fireEvent.dragStart(elA, { dataTransfer });
  fireEvent.dragOver(elB, { dataTransfer });
  fireEvent.drop(elB, { dataTransfer });
  expect(p.onReorder).toHaveBeenCalledWith(0, 1);
});

it('ignores a foreign drop (no tab-index payload)', () => {
  const p = setup();
  const elB = screen.getByText('SK하이닉스').closest('[data-tab-id]')!; // idx 1
  const dataTransfer = { setData: () => {}, getData: () => '', types: [] as string[], effectAllowed: '' };
  fireEvent.dragOver(elB, { dataTransfer });
  fireEvent.drop(elB, { dataTransfer });
  expect(p.onReorder).not.toHaveBeenCalled();
});
