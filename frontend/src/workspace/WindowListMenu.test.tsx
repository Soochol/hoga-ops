import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowListMenu, type WindowListSection } from './WindowListMenu';

/**
 * 창 목록 드롭다운(공용 프리젠테이션) — 죽은 "N창 · 그룹" 라벨의 후계.
 *
 * 고정하는 계약: (1) 닫힌 동안 트리거만 있고 개수 뱃지가 보인다, (2) 열면 섹션
 * 헤더 + 행이 나온다, (3) 행 클릭 = onFocus 후 닫힘(z-최상단 raise), (4) × =
 * onClose, (5) 닫을 수 없는 창(closable:false)엔 × 가 없다, (6) 모두 정리 =
 * onTidy 후 닫힘, (7) 방향키가 섹션을 가로질러 순환한다.
 */

function makeSections(): WindowListSection[] {
  return [
    {
      key: 'g1',
      heading: '그룹 1 · 삼성전자',
      rows: [
        { id: 'w-chart', label: '차트', isFocused: true, closable: true },
        { id: 'w-book', label: '10호가', isFocused: false, closable: true },
      ],
    },
    {
      key: 'g2',
      heading: '그룹 2 · SK하이닉스',
      rows: [{ id: 'w-prog', label: '프로그램', isFocused: false, closable: true }],
    },
  ];
}

function renderMenu(overrides: Partial<Parameters<typeof WindowListMenu>[0]> = {}) {
  const props = {
    testId: 'wl',
    count: 3,
    summary: '열린 창 3 · 그룹 2',
    sections: makeSections(),
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onTidy: vi.fn(),
    ...overrides,
  };
  render(<WindowListMenu {...props} />);
  return props;
}

const open = () => fireEvent.click(screen.getByTestId('wl-button'));

describe('WindowListMenu', () => {
  it('shows the count badge and keeps rows collapsed until opened', () => {
    renderMenu();
    expect(screen.getByTestId('wl-button')).toHaveTextContent('3');
    expect(screen.queryByTestId('wl-menu')).toBeNull();
    expect(screen.queryByTestId('wl-focus-w-chart')).toBeNull();
  });

  it('renders section headings and rows once opened', () => {
    renderMenu();
    open();
    expect(screen.getByTestId('wl-menu')).toBeInTheDocument();
    expect(screen.getByText('그룹 1 · 삼성전자')).toBeInTheDocument();
    expect(screen.getByText('그룹 2 · SK하이닉스')).toBeInTheDocument();
    expect(screen.getByText('열린 창 3 · 그룹 2')).toBeInTheDocument();
    expect(screen.getByTestId('wl-focus-w-book')).toBeInTheDocument();
  });

  it('calls onFocus and closes when a row is clicked', () => {
    const props = renderMenu();
    open();
    fireEvent.click(screen.getByTestId('wl-focus-w-book'));
    expect(props.onFocus).toHaveBeenCalledWith('w-book');
    expect(screen.queryByTestId('wl-menu')).toBeNull();
  });

  it('calls onClose from the × button without focusing the window', () => {
    const props = renderMenu();
    open();
    fireEvent.click(screen.getByTestId('wl-close-w-book'));
    expect(props.onClose).toHaveBeenCalledWith('w-book');
    expect(props.onFocus).not.toHaveBeenCalled();
  });

  it('omits the × button for windows that cannot be closed', () => {
    renderMenu({
      sections: [
        {
          key: 'only',
          rows: [
            { id: 'chart', label: '차트', isFocused: true, closable: false },
            { id: 'memo', label: '메모', isFocused: false, closable: true },
          ],
        },
      ],
    });
    open();
    expect(screen.queryByTestId('wl-close-chart')).toBeNull();
    expect(screen.getByTestId('wl-close-memo')).toBeInTheDocument();
  });

  it('calls onTidy and closes from 모두 정리', () => {
    const props = renderMenu();
    open();
    fireEvent.click(screen.getByTestId('wl-tidy'));
    expect(props.onTidy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('wl-menu')).toBeNull();
  });

  it('marks the focused row and focuses it on open', () => {
    renderMenu();
    open();
    // 포커스 창은 배지를 달고 열릴 때 초기 포커스를 받는다.
    expect(screen.getByTestId('wl-focus-w-chart')).toHaveFocus();
    expect(screen.getByTestId('wl-focus-w-chart')).toHaveTextContent('포커스');
  });

  it('wraps arrow-key navigation across sections', () => {
    renderMenu();
    open();
    const first = screen.getByTestId('wl-focus-w-chart');
    const last = screen.getByTestId('wl-focus-w-prog');
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
  });

  it('shows an empty state when there are no windows', () => {
    renderMenu({ sections: [], count: 0, summary: '열린 창 0' });
    open();
    expect(screen.getByText('열린 창이 없습니다')).toBeInTheDocument();
  });
});
