import { fireEvent, render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { useState } from 'react';
import { ChartTabOverflowMenu } from './ChartTabOverflowMenu';

type TestTab = {
  id: string;
  code: string;
  label: string;
  timeframe: '1m' | 'D';
  pinned?: boolean;
};

const TF_LABEL: Record<TestTab['timeframe'], string> = { '1m': '1분봉', D: '일봉' };
const renderLabel = (t: TestTab) => `${t.label} ${TF_LABEL[t.timeframe]}`;

const tabs: TestTab[] = [
  { id: 'a', code: '005930', label: '삼성전자', timeframe: '1m' },
  { id: 'b', code: '000660', label: 'SK하이닉스', timeframe: '1m' },
  { id: 'c', code: '035420', label: 'NAVER', timeframe: 'D' },
];

function Harness({ tabs, activeTabId, onFocus, onClose }: {
  tabs: TestTab[];
  activeTabId: string | null;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ChartTabOverflowMenu
      tabs={tabs}
      activeTabId={activeTabId}
      renderLabel={renderLabel}
      onFocus={onFocus}
      onClose={onClose}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

function setup(override: { tabs?: TestTab[]; activeTabId?: string } = {}) {
  const onFocus = vi.fn();
  const onClose = vi.fn();
  render(
    <Harness
      tabs={override.tabs ?? tabs}
      activeTabId={override.activeTabId ?? 'b'}
      onFocus={onFocus}
      onClose={onClose}
    />,
  );
  return { onFocus, onClose };
}

it('opens a list of all tabs', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  expect(screen.getByRole('dialog', { name: '열린 탭' })).toBeInTheDocument();
  expect(screen.getByText('삼성전자 1분봉')).toBeInTheDocument();
  expect(screen.getByText('SK하이닉스 1분봉')).toBeInTheDocument();
  expect(screen.getByText('NAVER 일봉')).toBeInTheDocument();
});

it('filters by label and code', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: '005930' } });
  expect(screen.getByText('삼성전자 1분봉')).toBeInTheDocument();
  expect(screen.queryByText('SK하이닉스 1분봉')).toBeNull();
  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: 'nav' } });
  expect(screen.getByText('NAVER 일봉')).toBeInTheDocument();
  expect(screen.queryByText('삼성전자 1분봉')).toBeNull();
});

it('filters by the visible display label (renderLabel output)', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: '일봉' } });
  expect(screen.getByText('NAVER 일봉')).toBeInTheDocument();
  expect(screen.queryByText('삼성전자 1분봉')).toBeNull();
});

it('selects a tab and closes the menu', () => {
  const { onFocus } = setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  fireEvent.click(screen.getByText('NAVER 일봉'));
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
  const manyTabs = Array.from({ length: 250 }, (_, index): TestTab => ({
    id: `tab-${index}`,
    code: String(100000 + index),
    label: `종목 ${index + 1}`,
    timeframe: '1m',
  }));
  const { onFocus } = setup({ tabs: manyTabs, activeTabId: 'tab-0' });
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));

  expect(screen.queryByText('종목 250 1분봉')).toBeNull();
  expect(screen.getByText('250개 중 200개 표시')).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('탭 검색'), { target: { value: '100249' } });
  expect(screen.getByText('종목 250 1분봉')).toBeInTheDocument();
  fireEvent.click(screen.getByText('종목 250 1분봉'));
  expect(onFocus).toHaveBeenCalledWith('tab-249');
});

it('marks the active tab', () => {
  setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  expect(screen.getByLabelText('활성 탭: SK하이닉스 1분봉')).toBeInTheDocument();
});

it('closes a tab from the list without selecting it or dismissing the dialog', () => {
  const { onFocus, onClose } = setup();
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));

  fireEvent.click(screen.getByLabelText('탭 닫기: 삼성전자 1분봉'));

  expect(onClose).toHaveBeenCalledWith('a');
  expect(onFocus).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '열린 탭' })).toBeInTheDocument();
});

it('shows a pinned marker instead of a close button for pinned tabs', () => {
  setup({ tabs: [{ ...tabs[0], pinned: true }, tabs[1]], activeTabId: 'b' });
  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  expect(screen.getByLabelText('고정된 탭: 삼성전자 1분봉')).toBeInTheDocument();
  expect(screen.queryByLabelText('탭 닫기: 삼성전자 1분봉')).toBeNull();
});
