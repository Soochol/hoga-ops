import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DataSection,
  DataTableHeader,
  DataTableRow,
  DataTableShell,
  EmptyState,
  FormField,
  InlineState,
  ListRow,
} from './DataSurface';

describe('DataSurface primitives', () => {
  it('renders flat data sections without nested card chrome', () => {
    render(<DataSection title="10호가">rows</DataSection>);

    const section = screen.getByRole('region', { name: '10호가' });
    expect(section).toHaveClass('border-t');
    expect(section).not.toHaveClass('rounded-lg');
    expect(section).not.toHaveClass('bg-bg-card');
    expect(screen.getByText('10호가')).toHaveClass('uppercase');
  });

  it('labels data sections with non-string titles from the rendered heading', () => {
    render(
      <DataSection
        title={
          <>
            실시간 <strong>10호가</strong>
          </>
        }
      >
        rows
      </DataSection>,
    );

    const section = screen.getByRole('region', { name: '실시간 10호가' });
    expect(section).toBeInTheDocument();
    const emphasizedTitle = screen.getByText('10호가');
    expect(emphasizedTitle).toBeInTheDocument();
    expect(emphasizedTitle.closest('header')).toHaveClass('uppercase');
  });

  it('renders token-backed data table shell, header, and rows', () => {
    render(
      <DataTableShell minWidth="640px">
        <DataTableHeader columns="grid-cols-[1fr_2fr]">
          <span>코드</span>
          <span>종목명</span>
        </DataTableHeader>
        <DataTableRow columns="grid-cols-[1fr_2fr]" className="custom-row">
          <span>005930</span>
          <span>삼성전자</span>
        </DataTableRow>
      </DataTableShell>,
    );

    expect(screen.getByText('코드').parentElement).toHaveClass('border-b');
    expect(screen.getByText('005930').parentElement).toHaveClass('min-h-list-row');
    expect(screen.getByText('005930').parentElement).toHaveClass('custom-row');
  });

  it('renders selectable list rows with active and inactive states', () => {
    render(
      <>
        <ListRow active>Active</ListRow>
        <ListRow>Inactive</ListRow>
      </>,
    );

    expect(screen.getByText('Active')).toHaveClass('bg-tint-selection');
    expect(screen.getByText('Inactive')).toHaveClass('hover:bg-bg-input-hover');
  });

  it('renders a static header with no toggle button when not collapsible', () => {
    render(<DataSection title="10호가">rows</DataSection>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('rows')).toBeInTheDocument();
  });

  it('turns the header into a toggle button when collapsible and reflects expanded state', () => {
    const onToggle = vi.fn();
    render(
      <DataSection title="10호가" onToggleCollapse={onToggle} toggleTestId="toggle-orderbook">
        rows
      </DataSection>,
    );

    const button = screen.getByTestId('toggle-orderbook');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-label', '10호가 접기');
    button.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByText('rows')).toBeInTheDocument();
  });

  it('unmounts content and shows the empty dot only when collapsed and empty', () => {
    const { rerender } = render(
      <DataSection title="거래원" collapsed onToggleCollapse={() => {}} showEmptyDot>
        rows
      </DataSection>,
    );

    expect(screen.queryByText('rows')).toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('데이터 없음')).toBeInTheDocument();

    rerender(
      <DataSection title="거래원" collapsed={false} onToggleCollapse={() => {}} showEmptyDot>
        rows
      </DataSection>,
    );
    expect(screen.getByText('rows')).toBeInTheDocument();
    expect(screen.queryByText('데이터 없음')).toBeNull();
  });

  it('renders headerTrailing controls as a sibling outside the toggle button', () => {
    render(
      <DataSection
        title="10호가"
        onToggleCollapse={() => {}}
        toggleTestId="toggle-orderbook"
        headerTrailing={<button type="button" data-testid="drag-handle">handle</button>}
      >
        rows
      </DataSection>,
    );

    const toggle = screen.getByTestId('toggle-orderbook');
    const handle = screen.getByTestId('drag-handle');
    expect(handle).toBeInTheDocument();
    // 핸들은 토글 버튼 내부가 아니라 형제여야 클릭이 접기와 충돌하지 않는다.
    expect(toggle.contains(handle)).toBe(false);
  });

  it('renders a non-collapsible header with leading and trailing controls around the title', () => {
    render(
      <DataSection
        title="10호가"
        headerLeading={<button type="button" data-testid="drag">handle</button>}
        headerTrailing={<button type="button" data-testid="hide">x</button>}
      >
        rows
      </DataSection>,
    );

    // 접기 토글 버튼은 없다(비접기).
    expect(screen.queryByRole('button', { name: /펼치기|접기/ })).toBeNull();
    const drag = screen.getByTestId('drag');
    const hide = screen.getByTestId('hide');
    const title = screen.getByText('10호가');
    // 리딩(드래그)이 제목 앞, 트레일링(숨김)이 제목 뒤. 본문은 항상 표시.
    expect(drag.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(hide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('rows')).toBeInTheDocument();
  });

  it('renders empty states, form fields, and inline state tones', () => {
    render(
      <>
        <EmptyState title="비어 있음">다시 선택하세요.</EmptyState>
        <FormField label="Symbol">
          <input aria-label="Symbol input" />
        </FormField>
        <InlineState tone="error">실패</InlineState>
        <InlineState tone="warn">주의</InlineState>
        <InlineState tone="accent">완료</InlineState>
      </>,
    );

    expect(screen.getByText('비어 있음')).toHaveClass('text-fg');
    expect(screen.getByText('Symbol')).toHaveClass('uppercase');
    expect(screen.getByText('실패')).toHaveClass('text-error');
    expect(screen.getByText('주의')).toHaveStyle({ color: 'var(--warn)' });
    expect(screen.getByText('완료')).toHaveStyle({ color: 'var(--accent)' });
    expect(screen.getByText('완료')).toHaveStyle({ background: 'var(--tint-selection)' });
  });
});
