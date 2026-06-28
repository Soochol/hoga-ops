import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
    expect(screen.getByText('005930').parentElement).toHaveClass('h-orderbook-row');
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
  });
});
