import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BookScrollArea } from './BookScrollArea';

afterEach(() => vi.unstubAllGlobals());
it('exposes clipped rows and columns and allows reaching either edge without changing the window', () => {
  let resized = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {} disconnect() {}
  });
  render(<BookScrollArea><div>사다리</div></BookScrollArea>);
  const region = screen.getByRole('region', { name: '10호가 사다리와 요약' });
  Object.defineProperties(region, {
    clientWidth: { configurable: true, value: 350 },
    scrollWidth: { configurable: true, value: 455 },
    clientHeight: { configurable: true, value: 350 },
    scrollHeight: { configurable: true, value: 462 },
  });
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.left !== undefined) region.scrollLeft = Math.min(options.left, 105);
    if (options.top !== undefined) region.scrollTop = Math.min(options.top, 112);
    fireEvent.scroll(region);
  });
  Object.defineProperty(region, 'scrollTo', { configurable: true, value: scrollTo });
  act(() => resized());
  expect(screen.getByText('숨겨진 행·열')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '요약 →' }));
  fireEvent.click(screen.getByRole('button', { name: '매수 ↓' }));
  expect(region.scrollLeft).toBe(105);
  expect(region.scrollTop).toBe(112);
  expect(screen.getByRole('button', { name: '요약 →' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '← 잔량' }));
  fireEvent.click(screen.getByRole('button', { name: '↑ 매도' }));
  expect(region.scrollLeft).toBe(0);
  expect(region.scrollTop).toBe(0);
});
