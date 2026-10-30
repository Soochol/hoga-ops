import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BookTradeList } from './BookTradeList';

const trades = Array.from({ length: 20 }, (_, index) => ({ key: `row-${index}`, price: 70000, qty: 20 - index, side: 1 }));

it('holds older rows during live updates and resumes the latest list on returning to the top', () => {
  const open = vi.fn();
  const view = render(<BookTradeList trades={trades} baselinePrice={69000} layout="book" onOpen={open} />);
  const scroll = screen.getByTestId('book-trade-list');
  scroll.scrollTop = 100;
  fireEvent.scroll(scroll);
  const latest = [{ key: 'new', price: 71000, qty: 1000, side: -1 }, ...trades];
  view.rerender(<BookTradeList trades={latest} baselinePrice={69000} layout="book" onOpen={open} />);
  expect(scroll).toHaveAttribute('data-reading', 'true');
  expect(scroll.scrollTop).toBe(100);
  expect(screen.queryByText('1,000')).toBeNull();
  fireEvent.doubleClick(scroll);
  expect(open).toHaveBeenCalledOnce();
  scroll.scrollTop = 0;
  fireEvent.scroll(scroll);
  expect(scroll).toHaveAttribute('data-reading', 'false');
  expect(screen.getByText('1,000')).toBeInTheDocument();
});

it('caps the rendered window at 200 and clears a held view when its source key changes', () => {
  const many = Array.from({ length: 250 }, (_, index) => ({ ...trades[0], key: `many-${index}`, qty: index + 1 }));
  const view = render(<BookTradeList key="KRX" trades={many} baselinePrice={69000} layout="order" />);
  expect(screen.getByText('200')).toBeInTheDocument();
  expect(screen.queryByText('201')).toBeNull();
  const scroll = screen.getByTestId('book-trade-list');
  expect(scroll).toHaveStyle({ height: '216px' });
  scroll.scrollTop = 100;
  fireEvent.scroll(scroll);
  view.rerender(<BookTradeList key="NXT" trades={[]} baselinePrice={69000} layout="order" />);
  expect(screen.getByTestId('book-trade-list')).toHaveAttribute('data-reading', 'false');
  expect(screen.queryByText('200')).toBeNull();
});
